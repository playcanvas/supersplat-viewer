import type { Collision } from './collision';
import { InputModeTracker } from './input/app/input-mode-tracker';
import { ModeShortcuts } from './input/app/mode-shortcuts';
import { NavInteraction } from './input/app/nav-interaction';
import { PointerLockManager } from './input/app/pointer-lock';
import { GamepadDevice } from './input/devices/gamepad';
import { KeyboardMouseDevice } from './input/devices/keyboard-mouse';
import { TouchDevice } from './input/devices/touch';
import { TrackpadDevice } from './input/devices/trackpad';
import type { ControlScheme, Devices } from './input/schemes/control-scheme';
import { FlyScheme } from './input/schemes/fly';
import { OrbitScheme } from './input/schemes/orbit';
import { WalkScheme } from './input/schemes/walk';
import type { UpdateContext } from './input/shared';
import { InputFrame } from './input/sources/input-frame';
import type { Picker } from './picker';
import type { CameraMode, Global } from './types';

/**
 * Coordinator that wires together input devices (keyboard-mouse, touch,
 * trackpad, gamepad) and app-level UX helpers (mode shortcuts, nav
 * interaction, pointer lock, input-mode tracker), and exposes the
 * resulting per-frame `InputFrame` for the camera manager to consume.
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

    private _navInteraction: NavInteraction;

    private _pointerLock = new PointerLockManager();

    private _modeShortcuts = new ModeShortcuts();

    private _inputModeTracker = new InputModeTracker();

    /** Layer-1 device readers, passed to the active control scheme. */
    private _devices: Devices;

    /** Per-mode control schemes (layer 2); `anim` has none. */
    private _schemes: Partial<Record<CameraMode, ControlScheme>>;

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

        // Trackpad MUST attach before KeyboardMouseDevice so its wheel
        // handler runs first; otherwise stopImmediatePropagation can't
        // block KeyboardMouseSource from also accumulating the wheel delta.
        this._trackpad.attach(canvas, global);
        this._keyboardMouse.attach(canvas, global);
        this._touch.attach(canvas, global);
        this._gamepad.attach(canvas, global);

        this._navInteraction.attach(canvas, global);
        this._pointerLock.attach(canvas, global, this._keyboardMouse);
        this._modeShortcuts.attach(global, this._pointerLock);
        this._inputModeTracker.attach(global);

        // canvas-level signals: anything that interrupts an animation /
        // closes the settings panel / dismisses the walk hint
        ['wheel', 'pointerdown', 'contextmenu', 'keydown'].forEach((eventName) => {
            canvas.addEventListener(eventName, (event) => {
                events.fire('inputEvent', 'interrupt', event);
            });
        });
        canvas.addEventListener('pointermove', (event) => {
            events.fire('inputEvent', 'interact', event);
        });
    }

    update(dt: number, distance: number) {
        const { state } = this._global;
        const cameraComponent = this._global.camera.camera!;

        const isOrbit = state.cameraMode === 'orbit';
        const isFly = state.cameraMode === 'fly';
        const isWalk = state.cameraMode === 'walk';
        const isFirstPerson = isFly || isWalk;

        const ctx: UpdateContext = {
            dt,
            distance,
            cameraComponent,
            mode: state.cameraMode,
            isOrbit,
            isFly,
            isWalk,
            isFirstPerson,
            gamingControls: state.gamingControls,
            // Touch must update first so the count is current; the running
            // count is also used by the keyboard-mouse pan flag.
            touchCount: this._touch.touchCount
        };

        // layer 1: read devices + held-state + discrete intents. Order: touch
        // first (so touchCount in ctx reflects this frame's count delta), then
        // everyone else.
        this._touch.update(ctx);
        ctx.touchCount = this._touch.touchCount;
        this._keyboardMouse.update(ctx);
        this._trackpad.update(ctx);
        this._gamepad.update(ctx);

        // layer 2: map the active mode's control scheme into the frame.
        // `anim` has no scheme — the frame is left empty (the anim controller
        // drains it).
        this._schemes[state.cameraMode]?.map(this._devices, ctx, this.frame);
    }
}

export { InputController };
