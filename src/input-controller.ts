import { InputFrame } from 'playcanvas';

import type { Collision } from './collision';
import { InputModeTracker } from './input/app/input-mode-tracker';
import { ModeShortcuts } from './input/app/mode-shortcuts';
import { PointerLockManager } from './input/app/pointer-lock';
import { WalkInteraction } from './input/app/walk-interaction';
import { GamepadDevice } from './input/devices/gamepad';
import { KeyboardMouseDevice } from './input/devices/keyboard-mouse';
import { TouchDevice } from './input/devices/touch';
import { TrackpadDevice } from './input/devices/trackpad';
import type { UpdateContext } from './input/shared';
import type { Picker } from './picker';
import type { Global } from './types';

/**
 * Coordinator that wires together input devices (keyboard-mouse, touch,
 * trackpad, gamepad) and app-level UX helpers (mode shortcuts, walk
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

    private _walkInteraction: WalkInteraction;

    private _pointerLock = new PointerLockManager();

    private _modeShortcuts = new ModeShortcuts();

    private _inputModeTracker = new InputModeTracker();

    set collision(value: Collision | null) {
        this._walkInteraction.collision = value;
    }

    get collision(): Collision | null {
        return this._walkInteraction.collision;
    }

    constructor(global: Global, picker: Picker) {
        this._global = global;
        this._walkInteraction = new WalkInteraction(picker);

        const { app, events } = global;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        // Trackpad MUST attach before KeyboardMouseDevice so its wheel
        // handler runs first; otherwise stopImmediatePropagation can't
        // block KeyboardMouseSource from also accumulating the wheel delta.
        this._trackpad.attach(canvas, global);
        this._keyboardMouse.attach(canvas, global);
        this._touch.attach(canvas, global);
        this._gamepad.attach(canvas, global);

        this._walkInteraction.attach(canvas, global);
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

        // order: touch first (so touchCount in ctx reflects this frame's
        // count delta), then everyone else.
        this._touch.update(ctx, this.frame);
        ctx.touchCount = this._touch.touchCount;
        this._keyboardMouse.update(ctx, this.frame);
        this._trackpad.update(ctx, this.frame);
        this._gamepad.update(ctx, this.frame);
    }
}

export { InputController };
