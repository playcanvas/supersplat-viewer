import { Vec3 } from 'playcanvas';

import type { CameraFrame } from './camera';
import { damp } from '../core/math';

const RAD_TO_DEG = 180 / Math.PI;

/** XZ distance below which the walker considers itself arrived */
const ARRIVAL_DIST = 0.5;

/** Minimum XZ speed (m/s) to not count as blocked */
const BLOCKED_SPEED = 0.6;

/** Seconds of continuous low-progress before stopping the walk */
const BLOCKED_DURATION = 0.2;

/**
 * Generates synthetic move/rotate input to auto-walk toward a target position.
 *
 * Designed to feed into FpsController's existing update path so there is no
 * duplicated physics. Each frame it appends yaw-rotation and forward-movement
 * deltas to the shared CameraFrame, and monitors arrival / blocked conditions.
 */
class WalkSource {
    /**
     * Forward input scale (matches InputController.moveSpeed for consistent
     * speed with regular WASD walking).
     */
    walkSpeed = 4;

    /**
     * Yaw rotation damping while auto-walking toward a target.
     */
    rotateDamping = 0.99;

    /**
     * Callback fired when an auto-walk completes (arrival or obstacle).
     */
    onComplete: (() => void) | null = null;

    private _target: Vec3 | null = null;

    private _blockedTime = 0;

    private _prevDist = Infinity;

    get isWalking(): boolean {
        return this._target !== null;
    }

    /**
     * Begin auto-walking toward a world-space target position.
     *
     * @param target - The destination (XZ used for navigation).
     */
    walkTo(target: Vec3) {
        if (!this._target) {
            this._target = new Vec3();
        }
        this._target.copy(target);
        this._blockedTime = 0;
        this._prevDist = Infinity;
    }

    /**
     * Cancel any active auto-walk.
     */
    cancelWalk() {
        if (this._target) {
            this._target = null;
            this._blockedTime = 0;
            this.onComplete?.();
        }
    }

    /**
     * Compute walk deltas and append them to the frame. Must be called
     * before* the camera controller reads the frame.
     *
     * @param dt - Frame delta time in seconds.
     * @param cameraPosition - Camera world position (previous frame output).
     * @param cameraAngles - Camera Euler angles in degrees (previous frame output).
     * @param frame - The shared CameraFrame to append deltas to.
     */
    update(dt: number, cameraPosition: Vec3, cameraAngles: Vec3, frame: CameraFrame) {
        if (!this._target) return;

        const target = this._target;

        const dx = target.x - cameraPosition.x;
        const dz = target.z - cameraPosition.z;
        const xzDist = Math.sqrt(dx * dx + dz * dz);

        // arrival
        if (xzDist < ARRIVAL_DIST) {
            this.cancelWalk();
            return;
        }

        // blocked detection: compare with previous frame's distance
        if (this._prevDist !== Infinity && dt > 0) {
            const speed = (this._prevDist - xzDist) / dt;
            if (speed < BLOCKED_SPEED) {
                this._blockedTime += dt;
                if (this._blockedTime >= BLOCKED_DURATION) {
                    this.cancelWalk();
                    return;
                }
            } else {
                this._blockedTime = 0;
            }
        }
        this._prevDist = xzDist;

        // yaw toward target
        const targetYaw = Math.atan2(-dx, -dz) * RAD_TO_DEG;
        let yawDiff = targetYaw - cameraAngles.y;
        yawDiff = ((yawDiff % 360) + 540) % 360 - 180;
        const rotAlpha = damp(this.rotateDamping, dt);

        // FpsController applies: _angles.y += -rotate[0]
        frame.deltas.rotate.append([-(yawDiff * rotAlpha), 0, 0]);

        // scale forward speed by alignment: turn in place first, then accelerate
        const alignment = Math.max(0, Math.cos(yawDiff * Math.PI / 180));
        frame.deltas.move.append([0, 0, this.walkSpeed * dt * alignment]);
    }
}

export { WalkSource };
