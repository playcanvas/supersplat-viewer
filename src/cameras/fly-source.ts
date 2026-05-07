import { math, Vec3 } from 'playcanvas';

import type { Camera, CameraFrame } from './camera';
import { setCameraForward } from './camera-utils';
import {
    ProgressTracker,
    type TargetSource,
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
class FlySource implements TargetSource {
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

    private _speedMul = 1;

    get isActive(): boolean {
        return this._target !== null;
    }

    /**
     * Begin auto-flying toward a world-space target position.
     *
     * @param target - The destination.
     * @param speedMul - Forward-speed multiplier (mirrors gaming-controls
     * shift/ctrl: 4 for boost, 0.25 for slow). Defaults to 1.
     */
    navigateTo(target: Vec3, speedMul = 1) {
        const wasFlying = this._target !== null;
        if (!this._target) {
            this._target = new Vec3();
        }
        this._target.copy(target);
        this._speedMul = speedMul;
        if (!wasFlying) {
            this._yawRate = 0;
            this._pitchRate = 0;
            this._speed = 0;
        }
        this._progress.reset();
    }

    /**
     * Cancel any active auto-flight.
     */
    cancel() {
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
     * @param camera - The current camera state (read-only).
     * @param frame - The shared CameraFrame to append deltas to.
     */
    update(dt: number, camera: Camera, frame: CameraFrame) {
        if (!this._target) return;

        const target = this._target;
        const cameraPosition = camera.position;
        const cameraAngles = camera.angles;
        toTarget.sub2(target, cameraPosition);
        const dist = toTarget.length();
        const stopDistance = getStopDistance(camera.fov);
        const remainingDist = dist - stopDistance;
        const activeRemainingDist = Math.max(0, remainingDist);

        if (activeRemainingDist <= ARRIVAL_EPSILON && this._speed <= ARRIVAL_SPEED) {
            this.cancel();
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
        const maxSpeed = Math.min(this.flySpeed * this._speedMul, brakeSpeed, arrivalSpeed);

        if (maxSpeed > this._speed) {
            this._speed = approach(this._speed, maxSpeed, this.moveAcceleration * alignmentScale * dt);
        } else {
            this._speed = approach(this._speed, maxSpeed, this.moveDeceleration * dt);
        }

        const arrivalMove = activeRemainingDist * (1 - Math.exp(-ARRIVAL_RATE * dt));
        const moveDist = Math.min(this._speed * dt, arrivalMove);
        if (moveDist > 0) {
            frame.deltas.move.append([0, 0, moveDist]);
        }

        // Only treat low progress as blocked once the camera is substantially
        // facing the target; otherwise a large turn-in-place would cancel early.
        if (this._progress.update(dist, dt, BLOCKED_SPEED, BLOCKED_DURATION, alignment > 0.5 && this._speed > BLOCKED_SPEED)) {
            this.cancel();
        }
    }
}

export { FlySource };
