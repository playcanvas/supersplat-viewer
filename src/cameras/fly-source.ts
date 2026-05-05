import { math, Quat, Vec3 } from 'playcanvas';

import type { CameraFrame } from './camera';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/** Target-space radius to keep visible at the stopping distance */
const STOP_VIEW_RADIUS = 0.75;

/** Minimum standoff from the target */
const MIN_STOP_DIST = 0.75;

/** Maximum standoff from the target */
const MAX_STOP_DIST = 4.0;

/** Minimum progress speed (m/s) to not count as blocked */
const BLOCKED_SPEED = 0.25;

/** Seconds of continuous low-progress before stopping the flight */
const BLOCKED_DURATION = 0.5;

const toTarget = new Vec3();
const forward = new Vec3();
const rotation = new Quat();

const shortestAngle = (angle: number) => ((angle % 360) + 540) % 360 - 180;

const getStopDistance = (fov: number) => {
    const halfFov = math.clamp(fov, 15, 120) * DEG_TO_RAD * 0.5;
    return math.clamp(STOP_VIEW_RADIUS / Math.tan(halfFov), MIN_STOP_DIST, MAX_STOP_DIST);
};

const approach = (value: number, target: number, maxDelta: number) => {
    if (value < target) {
        return Math.min(target, value + maxDelta);
    }

    return Math.max(target, value - maxDelta);
};

const smoothstep = (edge0: number, edge1: number, value: number) => {
    const t = math.clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
};

const clampStep = (rate: number, remaining: number, dt: number) => {
    const step = rate * dt;
    if (Math.abs(remaining) < 1e-4) {
        return 0;
    }

    return Math.sign(step) === Math.sign(remaining) && Math.abs(step) > Math.abs(remaining) ?
        remaining :
        step;
};

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
    maxTurnRate = 180;

    /**
     * Proportional gain mapping angular error (degrees) to desired turn rate.
     */
    turnGain = 4;

    /**
     * Maximum pitch/yaw turn acceleration in degrees per second squared.
     */
    turnAcceleration = 720;

    /**
     * Maximum forward acceleration in meters per second squared.
     */
    moveAcceleration = 6;

    /**
     * Maximum forward braking in meters per second squared.
     */
    moveDeceleration = 8;

    /**
     * Callback fired when an auto-flight completes or is cancelled.
     */
    onComplete: (() => void) | null = null;

    private _target: Vec3 | null = null;

    private _yawRate = 0;

    private _pitchRate = 0;

    private _speed = 0;

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
        this._yawRate = 0;
        this._pitchRate = 0;
        this._speed = 0;
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
            this._speed = 0;
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
     * @param cameraFov - Camera vertical field-of-view in degrees.
     * @param frame - The shared CameraFrame to append deltas to.
     */
    update(dt: number, cameraPosition: Vec3, cameraAngles: Vec3, cameraFov: number, frame: CameraFrame) {
        if (!this._target) return;

        const target = this._target;
        toTarget.sub2(target, cameraPosition);
        const dist = toTarget.length();
        const stopDistance = getStopDistance(cameraFov);
        const remainingDist = dist - stopDistance;

        if (remainingDist <= 0) {
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

        this._yawRate = approach(this._yawRate, desiredYawRate, this.turnAcceleration * dt);
        this._pitchRate = approach(this._pitchRate, desiredPitchRate, this.turnAcceleration * dt);

        const yawStep = clampStep(this._yawRate, yawDiff, dt);
        const pitchStep = clampStep(this._pitchRate, pitchDiff, dt);
        this._yawRate = yawStep / dt;
        this._pitchRate = pitchStep / dt;

        // FlyController applies: _angles += [-rotateY, -rotateX, 0]
        frame.deltas.rotate.append([-yawStep, -pitchStep, 0]);

        rotation.setFromEulerAngles(cameraAngles.x + pitchStep, cameraAngles.y + yawStep, 0);
        rotation.transformVector(Vec3.FORWARD, forward);

        const alignment = math.clamp(forward.x * dirX + forward.y * dirY + forward.z * dirZ, 0, 1);
        const alignmentScale = smoothstep(0.05, 0.95, alignment);
        const brakeSpeed = Math.sqrt(Math.max(0, 2 * this.moveDeceleration * remainingDist));
        const desiredSpeed = Math.min(this.flySpeed, brakeSpeed) * alignmentScale;
        const speedDelta = (desiredSpeed > this._speed ? this.moveAcceleration : this.moveDeceleration) * dt;
        this._speed = approach(this._speed, desiredSpeed, speedDelta);

        const moveDist = Math.min(this._speed * dt, remainingDist);
        if (moveDist > 0) {
            frame.deltas.move.append([0, 0, moveDist]);
        }

        // Only treat low progress as blocked once the camera is substantially
        // facing the target; otherwise a large turn-in-place would cancel early.
        if (alignment > 0.5 && this._speed > BLOCKED_SPEED && this._prevDist !== Infinity) {
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
