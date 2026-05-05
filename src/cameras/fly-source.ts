import { math, Vec3 } from 'playcanvas';

import type { CameraFrame } from './camera';
import { setCameraForward } from './camera-utils';
import {
    ProgressTracker,
    approach,
    clampTurnStep,
    getPitchToDirection,
    getYawDiffToTarget,
    smoothTurnRate,
    smoothstep
} from './target-navigation';

const DEG_TO_RAD = Math.PI / 180;

/** Target-space radius to keep visible at the stopping distance */
const STOP_VIEW_RADIUS = 0.75;

/** Minimum standoff from the target */
const MIN_STOP_DIST = 0.75;

/** Maximum standoff from the target */
const MAX_STOP_DIST = 4.0;

/** Distance from the standoff point below which arrival can complete */
const ARRIVAL_EPSILON = 0.03;

/** Forward speed below which arrival can complete */
const ARRIVAL_SPEED = 0.05;

/** Converts remaining standoff distance to final approach speed */
const ARRIVAL_RATE = 1.75;

/** Minimum progress speed (m/s) to not count as blocked */
const BLOCKED_SPEED = 0.25;

/** Seconds of continuous low-progress before stopping the flight */
const BLOCKED_DURATION = 0.5;

const toTarget = new Vec3();
const forward = new Vec3();
const postTurnAngles = new Vec3();

const getStopDistance = (fov: number) => {
    const halfFov = math.clamp(fov, 15, 120) * DEG_TO_RAD * 0.5;
    return math.clamp(STOP_VIEW_RADIUS / Math.tan(halfFov), MIN_STOP_DIST, MAX_STOP_DIST);
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

    private _progress = new ProgressTracker();

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
        this._progress.reset();
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
            this._progress.reset();
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
        const activeRemainingDist = Math.max(0, remainingDist);

        if (activeRemainingDist <= ARRIVAL_EPSILON && this._speed <= ARRIVAL_SPEED) {
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

        const yawDiff = getYawDiffToTarget(toTarget.x, toTarget.z, cameraAngles.y);
        const pitchDiff = getPitchToDirection(dirY) - cameraAngles.x;

        this._yawRate = smoothTurnRate(this._yawRate, yawDiff, this.maxTurnRate, this.turnGain, dt);
        this._pitchRate = smoothTurnRate(this._pitchRate, pitchDiff, this.maxTurnRate, this.turnGain, dt);

        const yawStep = clampTurnStep(this._yawRate, yawDiff, dt);
        const pitchStep = clampTurnStep(this._pitchRate, pitchDiff, dt);
        this._yawRate = yawStep / dt;
        this._pitchRate = pitchStep / dt;

        // FlyController applies: _angles += [-rotateY, -rotateX, 0]
        frame.deltas.rotate.append([-yawStep, -pitchStep, 0]);

        postTurnAngles.set(cameraAngles.x + pitchStep, cameraAngles.y + yawStep, 0);
        setCameraForward(postTurnAngles, forward);

        const alignment = math.clamp(forward.x * dirX + forward.y * dirY + forward.z * dirZ, 0, 1);
        const alignmentScale = smoothstep(0.05, 0.95, alignment);
        const brakeSpeed = Math.sqrt(2 * this.moveDeceleration * activeRemainingDist);
        const arrivalSpeed = activeRemainingDist * ARRIVAL_RATE;
        const desiredSpeed = Math.min(this.flySpeed, brakeSpeed, arrivalSpeed) * alignmentScale;
        const speedDelta = (desiredSpeed > this._speed ? this.moveAcceleration : this.moveDeceleration) * dt;
        this._speed = approach(this._speed, desiredSpeed, speedDelta);

        const arrivalMove = activeRemainingDist * (1 - Math.exp(-ARRIVAL_RATE * dt));
        const moveDist = Math.min(this._speed * dt, arrivalMove);
        if (moveDist > 0) {
            frame.deltas.move.append([0, 0, moveDist]);
        }

        // Only treat low progress as blocked once the camera is substantially
        // facing the target; otherwise a large turn-in-place would cancel early.
        if (this._progress.update(dist, dt, BLOCKED_SPEED, BLOCKED_DURATION, alignment > 0.5 && this._speed > BLOCKED_SPEED)) {
            this.cancelFly();
        }
    }
}

export { FlySource };
