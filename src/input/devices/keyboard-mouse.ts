import { KeyboardMouseSource, Vec3 } from 'playcanvas';

import type { Global } from '../../types';
import {
    DISPLACEMENT_SCALE,
    flipZForOrbit,
    screenToWorld
} from '../shared';
import type { CameraInputFrame, InputDevice, UpdateContext } from '../shared';

const tmpV1 = new Vec3();
const keyMove = new Vec3();
const panMove = new Vec3();
const mouseRotate = new Vec3();
const wheelMove = new Vec3();

// Patch keydown / keyup so meta-key combinations don't leave keys stuck on
// macOS (the OS swallows keyup for any key released while Cmd is held).
const patchKeyboardMeta = (desktopInput: any) => {
    const origOnKeyDown = desktopInput._onKeyDown;
    desktopInput._onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        } else if (!event.metaKey) {
            origOnKeyDown(event);
        }
    };

    const origOnKeyUp = desktopInput._onKeyUp;
    desktopInput._onKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        } else if (!event.metaKey) {
            origOnKeyUp(event);
        }
    };
};

class KeyboardMouseDevice implements InputDevice {
    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    wheelSpeed: number = 0.06;

    mouseRotateSensitivity: number = 0.5;

    private _source: KeyboardMouseSource = new KeyboardMouseSource();

    private _global: Global | null = null;

    /** Running WASD/QE/arrow direction (sum of key states). */
    private _axis = new Vec3();

    /** Running button-held state per index: [LMB, MMB, RMB]. */
    private _buttons: [number, number, number] = [0, 0, 0];

    private _shift = 0;

    private _ctrl = 0;

    private _jump = 0;

    /**
     * Get the underlying source so other code (PointerLockManager) can
     * toggle its private pointer-lock flag, which gates how it consumes
     * mouse-delta events.
     *
     * @returns The PlayCanvas KeyboardMouseSource backing this device.
     */
    get source(): KeyboardMouseSource {
        return this._source;
    }

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        patchKeyboardMeta(this._source);
        this._source.attach(canvas);
    }

    detach(): void {
        // KeyboardMouseSource does not expose a detach; nothing to undo for
        // its DOM listeners here.
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { keyCode } = KeyboardMouseSource;
        const { key, button, mouse, wheel } = this._source.read();
        const { events } = this._global!;

        // accumulate running input state
        this._axis.add(tmpV1.set(
            (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
            (key[keyCode.E] - key[keyCode.Q]),
            (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
        ));
        this._jump += key[keyCode.SPACE];
        this._shift += key[keyCode.SHIFT];
        this._ctrl += key[keyCode.CTRL];
        const n = Math.min(button.length, this._buttons.length);
        for (let i = 0; i < n; i++) {
            this._buttons[i] += button[i];
        }

        const { isFly, isWalk, isFirstPerson, dt, distance, cameraComponent, mode, touchCount } = ctx;

        // auto-move cancellation and requestFirstPerson events (driven by keyboard axes)
        if (isWalk && (this._axis.x !== 0 || this._axis.z !== 0)) {
            events.fire('walkCancel');
        }
        if (isFly && (this._axis.x !== 0 || this._axis.y !== 0 || this._axis.z !== 0)) {
            events.fire('flyCancel');
        }
        if (!isFirstPerson && this._axis.length() > 0) {
            events.fire('inputEvent', 'requestFirstPerson');
        }

        // pan flag: RMB held, RMB just released this frame, or 2+ touches active
        const pan = this._buttons[2] || +(button[2] === -1) || +(touchCount > 1);
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;

        const { deltas } = frame;

        // move (WASD + mouse-drag pan + wheel)
        const v = tmpV1.set(0, 0, 0);
        keyMove.copy(this._axis);
        if (isWalk) {
            // In walk mode normalize only horizontal axes so jump doesn't
            // reduce horizontal speed.
            keyMove.y = 0;
        }
        keyMove.normalize();
        const shiftMul = isWalk ? 2 : 4;
        const ctrlMul = isWalk ? 0.5 : 0.25;
        const speed = this.moveSpeed * (this._shift ? shiftMul : this._ctrl ? ctrlMul : 1);
        v.add(keyMove.mulScalar((isFirstPerson ? 1 : 0) * speed * dt));
        if (isWalk) {
            // Pass jump signal as raw Y; WalkController uses move[1] > 0 as
            // a boolean trigger.
            v.y = this._jump > 0 ? 1 : 0;
        }
        screenToWorld(cameraComponent, mouse[0], mouse[1], distance, panMove);
        v.add(panMove.mulScalar(pan));
        wheelMove.set(0, 0, -wheel[0]);
        v.add(wheelMove.mulScalar(this.wheelSpeed * DISPLACEMENT_SCALE));
        deltas.move.append([v.x, v.y, flipZForOrbit(mode, v.z)]);

        // rotate (mouse-drag, masked when in pan mode)
        v.set(0, 0, 0);
        mouseRotate.set(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - pan) * this.orbitSpeed * orbitFactor * this.mouseRotateSensitivity * DISPLACEMENT_SCALE));
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

export { KeyboardMouseDevice };
