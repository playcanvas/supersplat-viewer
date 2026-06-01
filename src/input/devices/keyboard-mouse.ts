import { Vec3 } from 'playcanvas';

import { damp } from '../../core/math';
import type { Global } from '../../types';
import type { InputDevice, UpdateContext } from '../shared';
import { KeyboardMouseSource } from '../sources/keyboard-mouse';

const tmpV1 = new Vec3();
const keyMove = new Vec3();
const flyKeyVelocity = new Vec3();

/**
 * Keyboard + mouse reader. Reads the raw source, maintains the held-state
 * shared across camera modes, fires the (mode-aware) discrete intents, and
 * exposes normalized signals + tuning constants for the control schemes to map.
 * The schemes write the move/rotate frame — not this class.
 */
class KeyboardMouseDevice implements InputDevice {
    // tuning constants (read by the schemes)
    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    wheelSpeed: number = 0.06;

    mouseRotateSensitivity: number = 0.5;

    flyMoveAccelerationDamping: number = 0.992;

    flyMoveDecelerationDamping: number = 0.993;

    /** Held WASD/QE/arrow direction (running sum of key deltas). */
    axis = new Vec3();

    shift = 0;

    ctrl = 0;

    jump = 0;

    /** Held button state per index: [LMB, MMB, RMB]. */
    buttons: [number, number, number] = [0, 0, 0];

    /** This-frame mouse delta [dx, dy]. */
    mouse: [number, number] = [0, 0];

    /** This-frame wheel delta. */
    wheel = 0;

    /** Pan-active flag (RMB held / released this frame / 2+ touches). */
    pan = 0;

    /** Smoothed fly-mode WASD velocity (zeroed outside fly mode). */
    flyVelocity = new Vec3();

    private _source: KeyboardMouseSource = new KeyboardMouseSource();

    private _global: Global | null = null;

    /** This-frame button edge per index: 1 pressed, -1 released, 0 unchanged. */
    private _buttonEdge: [number, number, number] = [0, 0, 0];

    /**
     * The underlying source so PointerLockManager can toggle pointer-lock
     * mouse-delta sourcing via its public setter.
     *
     * @returns The KeyboardMouseSource backing this device.
     */
    get source(): KeyboardMouseSource {
        return this._source;
    }

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._source.attach(canvas);
    }

    detach(): void {
        this._source.detach();
    }

    update(ctx: UpdateContext): void {
        const { keyCode } = KeyboardMouseSource;
        const { key, button, mouse, wheel } = this._source.read();
        const { events } = this._global!;

        // accumulate running input state
        this.axis.add(tmpV1.set(
            (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
            (key[keyCode.E] - key[keyCode.Q]),
            (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
        ));
        this.jump += key[keyCode.SPACE];
        this.shift += key[keyCode.SHIFT];
        this.ctrl += key[keyCode.CTRL];
        const n = Math.min(button.length, this.buttons.length);
        for (let i = 0; i < n; i++) {
            this.buttons[i] += button[i];
            this._buttonEdge[i] = button[i];
        }

        const { isFly, isWalk, isFirstPerson, gamingControls, dt, touchCount } = ctx;
        const pan = this.buttons[2] || +(this._buttonEdge[2] === -1) || +(touchCount > 1);
        this.pan = pan;

        // expose this-frame mouse / wheel deltas
        this.mouse[0] = mouse[0];
        this.mouse[1] = mouse[1];
        this.wheel = wheel[0];

        // auto-move cancellation and requestFirstPerson events (driven by keyboard axes)
        if (isWalk && (this.axis.x !== 0 || this.axis.z !== 0)) {
            events.fire('navigateCancel');
        }
        if (isFly && (this.axis.x !== 0 || this.axis.y !== 0 || this.axis.z !== 0)) {
            events.fire('navigateCancel');
        }
        if (isFly && wheel[0] !== 0) {
            events.fire('navigateCancel');
        }
        if (isFly && (gamingControls || pan) && (mouse[0] !== 0 || mouse[1] !== 0)) {
            events.fire('navigateCancel');
        }
        if (!isFirstPerson && this.axis.length() > 0) {
            events.fire('inputEvent', 'requestFirstPerson');
        }

        // Fly-mode WASD velocity (smoothed, accel/decel damping). Computed here
        // (every frame, mode-aware) so it resets each non-fly frame and starts
        // from rest when fly is re-entered; the fly scheme applies it.
        if (isFly) {
            keyMove.copy(this.axis);
            keyMove.normalize();
            const speed = this.moveSpeed * (this.shift ? 4 : this.ctrl ? 0.25 : 1);
            keyMove.mulScalar(speed);
            flyKeyVelocity.copy(keyMove);
            const damping = flyKeyVelocity.lengthSq() > this.flyVelocity.lengthSq() ?
                this.flyMoveAccelerationDamping :
                this.flyMoveDecelerationDamping;
            this.flyVelocity.lerp(this.flyVelocity, flyKeyVelocity, damp(damping, dt));
            if (flyKeyVelocity.lengthSq() === 0 && this.flyVelocity.lengthSq() < 1e-4) {
                this.flyVelocity.set(0, 0, 0);
            }
        } else {
            this.flyVelocity.set(0, 0, 0);
        }
    }
}

export { KeyboardMouseDevice };
