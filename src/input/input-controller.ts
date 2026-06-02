import { EventHandler } from 'playcanvas';

import type { CameraMode } from '../types';
import { GamepadDevice } from './devices/gamepad';
import { KeyboardMouseDevice } from './devices/keyboard-mouse';
import { TouchDevice } from './devices/touch';
import { TrackpadDevice } from './devices/trackpad';
import { DomEventSource } from './dom-event-source';
import { InputFrame } from './input-frame';
import type { ControlScheme, Devices } from './schemes/control-scheme';
import { FlyScheme } from './schemes/fly';
import { OrbitScheme } from './schemes/orbit';
import { WalkScheme } from './schemes/walk';
import type { InputHost, UpdateContext } from './shared';

/**
 * Coordinator that wires together the input devices (keyboard-mouse, touch,
 * trackpad, gamepad) and per-mode control schemes, and exposes the resulting
 * per-frame `InputFrame` for the camera manager to consume. App-level input
 * interactions (mode shortcuts, nav interaction, pointer lock) are owned by the
 * host and attached to `domSource` separately.
 */
class InputController {
    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

    private _host: InputHost;

    private _trackpad = new TrackpadDevice();

    private _keyboardMouse = new KeyboardMouseDevice();

    private _touch = new TouchDevice();

    private _gamepad = new GamepadDevice();

    private _domSource = new DomEventSource();

    /**
     * Module-owned intent bus. Input-originated intents fire here
     * (`interrupt`/`interact`/`requestFirstPerson` + the schemes'
     * `mobileTap`/`navigateCancel`); the host subscribes and bridges to its own
     * event bus, and forwards inbound signals like `joystickInput` onto it.
     */
    private _events = new EventHandler();

    /** Layer-1 device readers, passed to the active control scheme. */
    private _devices: Devices;

    /** Per-mode control schemes (layer 2); `anim` has none. */
    private _schemes: Partial<Record<CameraMode, ControlScheme>>;

    /** Previous active camera mode, to fire scheme.enter() on a change. */
    private _prevMode: CameraMode | null = null;

    // The central DOM event source (so the host can attach its own interactions).
    get domSource(): DomEventSource {
        return this._domSource;
    }

    // The keyboard-mouse reader (so the host's pointer-lock manager can switch
    // its mouse-delta sourcing between native pointer-lock and screen tracking).
    get keyboardMouse(): KeyboardMouseDevice {
        return this._keyboardMouse;
    }

    // Module-owned intent bus — the host subscribes to input-originated intents
    // here, and may forward inbound signals (e.g. `joystickInput`) onto it.
    get events(): EventHandler {
        return this._events;
    }

    constructor(host: InputHost) {
        this._host = host;

        this._devices = {
            keyboardMouse: this._keyboardMouse,
            touch: this._touch,
            gamepad: this._gamepad,
            trackpad: this._trackpad
        };
        this._schemes = {
            orbit: new OrbitScheme(),
            fly: new FlyScheme(),
            walk: new WalkScheme()
        };

        const canvas = host.canvas;

        const src = this._domSource;

        // central DOM event source — binds the canvas/window listeners up front
        src.attach(canvas);

        // interrupt / interact: raw-input "activity" signals (consumed by the UI).
        // Registered FIRST so interrupt fires for every wheel even when trackpad
        // claims it below. (keydown interrupt is on window — keys now count as
        // activity; the canvas isn't focusable so its keydown never fired.)
        const interrupt = (event: Event) => {
            this._events.fire('inputEvent', 'interrupt', event);
        };
        const interact = (event: Event) => {
            this._events.fire('inputEvent', 'interact', event);
        };
        src.wheel.on(interrupt);
        src.pointerdown.on(interrupt);
        src.contextmenu.on(interrupt);
        src.keydown.on(interrupt);
        src.pointermove.on(interact);

        // readers self-register their handlers, IN ORDER — trackpad before the
        // keyboard-mouse reader so trackpad's wheel claim (return true) skips it,
        // avoiding a double-count. (gamepad polls — nothing to register.)
        this._trackpad.register(src);
        this._keyboardMouse.register(src);
        this._touch.register(src);

        // forward the virtual-joystick value into the touch reader (the host
        // bridges its `joystickInput` onto this bus)
        this._events.on('joystickInput', (value: { x: number; y: number }) => {
            this._touch.setJoystick(value.x, value.y);
        });
    }

    update(dt: number, distance: number) {
        const cameraComponent = this._host.cameraComponent;

        // layer 1: read the pure, mode-agnostic device readers.
        this._touch.update();
        this._keyboardMouse.update();
        this._trackpad.update();
        this._gamepad.update();

        // requestFirstPerson is the one cross-mode intent the per-mode schemes
        // can't own — it fires in orbit AND anim (neither has a first-person
        // scheme) and switches the mode synchronously via the DOM source. The
        // decision uses the pre-switch mode.
        const preMode = this._host.cameraMode;
        if (preMode !== 'fly' && preMode !== 'walk' && this._keyboardMouse.axis.length() > 0) {
            this._events.fire('inputEvent', 'requestFirstPerson');
        }

        // Read the mode AFTER requestFirstPerson so the context matches the
        // scheme we actually run (e.g. an orbit→fly switch above) — otherwise a
        // stale orbit context flips forward/back for the first fly frame.
        const mode = this._host.cameraMode;
        const isOrbit = mode === 'orbit';
        const isFly = mode === 'fly';
        const isWalk = mode === 'walk';
        const isFirstPerson = isFly || isWalk;

        // reset the newly-active scheme's per-mode state on a mode change
        if (mode !== this._prevMode) {
            this._schemes[mode]?.enter?.();
            this._prevMode = mode;
        }

        // layer 2: map the active scheme into the frame (anim has no scheme —
        // the frame is left empty and the anim controller drains it).
        const ctx: UpdateContext = {
            dt,
            distance,
            cameraComponent,
            mode,
            isOrbit,
            isFly,
            isWalk,
            isFirstPerson,
            gamingControls: this._host.gamingControls,
            touchCount: this._touch.touchCount,
            events: this._events
        };
        this._schemes[mode]?.map(this._devices, ctx, this.frame);
    }
}

export { InputController };
