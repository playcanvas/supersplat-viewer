import type { Collision } from '../collision';
import type { Picker } from '../navigation/picker';
import type { CameraMode, Global } from '../types';
import { GamepadDevice } from './devices/gamepad';
import { KeyboardMouseDevice } from './devices/keyboard-mouse';
import { TouchDevice } from './devices/touch';
import { TrackpadDevice } from './devices/trackpad';
import { DomEventSource } from './dom-event-source';
import { InputFrame } from './input-frame';
import { ModeShortcuts } from './interactions/mode-shortcuts';
import { NavInteraction } from './interactions/nav-interaction';
import { PointerLockManager } from './interactions/pointer-lock';
import type { ControlScheme, Devices } from './schemes/control-scheme';
import { FlyScheme } from './schemes/fly';
import { OrbitScheme } from './schemes/orbit';
import { WalkScheme } from './schemes/walk';
import type { UpdateContext } from './shared';

/**
 * Coordinator that wires together input devices (keyboard-mouse, touch,
 * trackpad, gamepad) and input-driven interaction helpers (mode shortcuts, nav
 * interaction, pointer lock), and exposes the resulting per-frame `InputFrame`
 * for the camera manager to consume.
 */
class InputController {
    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

    private _global: Global;

    private _trackpad = new TrackpadDevice();

    private _keyboardMouse = new KeyboardMouseDevice();

    private _touch = new TouchDevice();

    private _gamepad = new GamepadDevice();

    private _domSource = new DomEventSource();

    private _navInteraction: NavInteraction;

    private _pointerLock = new PointerLockManager();

    private _modeShortcuts = new ModeShortcuts();

    /** Layer-1 device readers, passed to the active control scheme. */
    private _devices: Devices;

    /** Per-mode control schemes (layer 2); `anim` has none. */
    private _schemes: Partial<Record<CameraMode, ControlScheme>>;

    /** Previous active camera mode, to fire scheme.enter() on a change. */
    private _prevMode: CameraMode | null = null;

    // The central DOM event source (so viewer-level consumers can subscribe).
    get domSource(): DomEventSource {
        return this._domSource;
    }

    set collision(value: Collision | null) {
        this._navInteraction.collision = value;
    }

    get collision(): Collision | null {
        return this._navInteraction.collision;
    }

    constructor(global: Global, picker: Picker) {
        this._global = global;
        this._navInteraction = new NavInteraction(picker);

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

        const { app, events } = global;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        const src = this._domSource;

        // central DOM event source — binds the canvas/window listeners up front
        src.attach(canvas);

        // interrupt / interact: raw-input "activity" signals (consumed by the UI).
        // Registered FIRST so interrupt fires for every wheel even when trackpad
        // claims it below. (keydown interrupt is on window — keys now count as
        // activity; the canvas isn't focusable so its keydown never fired.)
        const interrupt = (event: Event) => {
            events.fire('inputEvent', 'interrupt', event);
        };
        const interact = (event: Event) => {
            events.fire('inputEvent', 'interact', event);
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

        // forward the virtual-joystick value into the touch reader
        events.on('joystickInput', (value: { x: number; y: number }) => {
            this._touch.setJoystick(value.x, value.y);
        });

        // interaction helpers route their canvas events through the source
        this._navInteraction.attach(canvas, global, src);
        this._pointerLock.attach(canvas, global, this._keyboardMouse, src);
        this._modeShortcuts.attach(global, this._pointerLock, src);
    }

    update(dt: number, distance: number) {
        const { state, events } = this._global;
        const cameraComponent = this._global.camera.camera!;

        // layer 1: read the pure, mode-agnostic device readers.
        this._touch.update();
        this._keyboardMouse.update();
        this._trackpad.update();
        this._gamepad.update();

        // requestFirstPerson is the one cross-mode intent the per-mode schemes
        // can't own — it fires in orbit AND anim (neither has a first-person
        // scheme) and switches the mode synchronously via the DOM source. The
        // decision uses the pre-switch mode.
        const preMode = state.cameraMode;
        if (preMode !== 'fly' && preMode !== 'walk' && this._keyboardMouse.axis.length() > 0) {
            events.fire('inputEvent', 'requestFirstPerson');
        }

        // Read the mode AFTER requestFirstPerson so the context matches the
        // scheme we actually run (e.g. an orbit→fly switch above) — otherwise a
        // stale orbit context flips forward/back for the first fly frame.
        const mode = state.cameraMode;
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
            gamingControls: state.gamingControls,
            touchCount: this._touch.touchCount,
            events
        };
        this._schemes[mode]?.map(this._devices, ctx, this.frame);
    }
}

export { InputController };
