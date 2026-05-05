import { math, Quat, Vec3 } from 'playcanvas';

import type { CameraFrame } from './camera';

const RAD_TO_DEG = 180 / Math.PI;

/** 3D distance below which the flyer considers itself arrived */
const ARRIVAL_DIST = 0.5;

/** Minimum progress speed (m/s) to not count as blocked */
const BLOCKED_SPEED = 0.25;

/** Seconds of continuous low-progress before stopping the flight */
const BLOCKED_DURATION = 0.5;

const toTarget = new Vec3();
const forward = new Vec3();
const rotation = new Quat();

const shortestAngle = (angle: number) => ((angle % 360) + 540) % 360 - 180;

/**
 * Generates synthetic move/rotate input to auto-fly toward a target position.
 */
class FlySource {
    /**
     * Forward input scale (matches InputController.moveSpeed).
     */
    flySpeed = 4;

    /**
     * Maximum pitch/yaw turn rate in degrees per second.
     */
    maxTurnRate = 240;

    /**
     * Proportional gain mapping angular error (degrees) to desired turn rate.
     */
    turnGain = 5;

    /**
     * Callback fired when an auto-flight completes or is cancelled.
     */
    onComplete: (() => void) | null = null;

    private _target: Vec3 | null = null;

    private _yawRate = 0;

    private _pitchRate = 0;

    private _blockedTime = 0;

    private _prevDist = Infinity;

    get isFlying(): boolean {
        return this._target !== null;
    }

    /**
     * Begin auto-flying toward a world-space target position.
     *
     * @param target - The destination.
     */
    flyTo(target: Vec3) {
        if (!this._target) {
            this._target = new Vec3();
        }
        this._target.copy(target);
        this._blockedTime = 0;
        this._prevDist = Infinity;
    }

    /**
     * Cancel any active auto-flight.
     */
    cancelFly() {
        if (this._target) {
            this._target = null;
            this._yawRate = 0;
            this._pitchRate = 0;
            this._blockedTime = 0;
            this._prevDist = Infinity;
            this.onComplete?.();
        }
    }

    /**
     * Compute fly deltas and append them to the frame. Must be called before
     * the camera controller reads the frame.
     *
     * @param dt - Frame delta time in seconds.
     * @param cameraPosition - Camera world position.
     * @param cameraAngles - Camera Euler angles in degrees.
     * @param frame - The shared CameraFrame to append deltas to.
     */
    update(dt: number, cameraPosition: Vec3, cameraAngles: Vec3, frame: CameraFrame) {
        if (!this._target) return;

        const target = this._target;
        toTarget.sub2(target, cameraPosition);
        const dist = toTarget.length();

        if (dist < ARRIVAL_DIST) {
            this.cancelFly();
            return;
        }

        if (dt <= 0) {
            return;
        }

        const invDist = 1 / dist;
        const dirX = toTarget.x * invDist;
        const dirY = toTarget.y * invDist;
        const dirZ = toTarget.z * invDist;

        const targetPitch = Math.asin(math.clamp(dirY, -1, 1)) * RAD_TO_DEG;
        const targetYaw = Math.atan2(-dirX, -dirZ) * RAD_TO_DEG;

        const yawDiff = shortestAngle(targetYaw - cameraAngles.y);
        const pitchDiff = targetPitch - cameraAngles.x;

        const desiredYawRate = math.clamp(yawDiff * this.turnGain, -this.maxTurnRate, this.maxTurnRate);
        const desiredPitchRate = math.clamp(pitchDiff * this.turnGain, -this.maxTurnRate, this.maxTurnRate);
        const smoothing = 1 - Math.exp(-4 * this.turnGain * dt);

        this._yawRate += (desiredYawRate - this._yawRate) * smoothing;
        this._pitchRate += (desiredPitchRate - this._pitchRate) * smoothing;

        // FlyController applies: _angles += [-rotateY, -rotateX, 0]
        frame.deltas.rotate.append([-(this._yawRate * dt), -(this._pitchRate * dt), 0]);

        rotation.setFromEulerAngles(cameraAngles);
        rotation.transformVector(Vec3.FORWARD, forward);

        const alignment = math.clamp(forward.x * dirX + forward.y * dirY + forward.z * dirZ, 0, 1);
        const moveDist = Math.min(this.flySpeed * dt * alignment, Math.max(0, dist - ARRIVAL_DIST));
        if (moveDist > 0) {
            frame.deltas.move.append([0, 0, moveDist]);
        }

        // Only treat low progress as blocked once the camera is substantially
        // facing the target; otherwise a large turn-in-place would cancel early.
        if (alignment > 0.5 && this._prevDist !== Infinity) {
            const speed = (this._prevDist - dist) / dt;
            if (speed < BLOCKED_SPEED) {
                this._blockedTime += dt;
                if (this._blockedTime >= BLOCKED_DURATION) {
                    this.cancelFly();
                    return;
                }
            } else {
                this._blockedTime = 0;
            }
        }
        this._prevDist = dist;
    }
}

export { FlySource };
