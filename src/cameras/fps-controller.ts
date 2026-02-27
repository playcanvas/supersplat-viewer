import { math, Vec3, Quat } from 'playcanvas';

import { damp } from '../core/math';
import type { PushOut, VoxelCollider } from '../voxel-collider';
import type { CameraFrame, Camera, CameraController } from './camera';

/** Pre-allocated push-out vector for capsule collision */
const out: PushOut = { x: 0, y: 0, z: 0 };

const v = new Vec3();
const d = new Vec3();

const forward = new Vec3();
const right = new Vec3();

const offset = new Vec3();
const rotation = new Quat();

/** Radians-to-degrees constant */
const RAD_TO_DEG = 180 / Math.PI;

/** XZ distance below which the walker considers itself arrived */
const WALK_ARRIVAL_DIST = 0.5;

/** Minimum XZ progress per frame (meters) to not count as blocked */
const WALK_PROGRESS_EPSILON = 0.01;

/** Number of consecutive low-progress frames before stopping the walk */
const WALK_BLOCKED_THRESHOLD = 10;

/**
 * First-person shooter style camera controller with gravity and capsule collision.
 *
 * Movement is constrained to the horizontal plane (XZ) relative to the camera yaw.
 * Vertical motion is driven by gravity and resolved by capsule collision with the
 * voxel grid. The camera is positioned at eye height within the capsule.
 */
class FpsController implements CameraController {
    /**
     * Optional voxel collider for capsule collision with sliding
     */
    collider: VoxelCollider | null = null;

    /**
     * Total capsule height in meters (default: human proportion)
     */
    capsuleHeight = 1.8;

    /**
     * Capsule radius in meters
     */
    capsuleRadius = 0.3;

    /**
     * Camera height from the bottom of the capsule in meters
     */
    eyeHeight = 1.6;

    /**
     * Gravity acceleration in m/s^2
     */
    gravity = 9.8;

    /**
     * Jump velocity in m/s
     */
    jumpSpeed = 5;

    /**
     * Movement speed in m/s when grounded
     */
    moveGroundSpeed = 10;

    /**
     * Movement speed in m/s when in the air (for air control)
     */
    moveAirSpeed = 1;

    /**
     * Movement damping factor (0 = no damping, 1 = full damping)
     */
    moveDamping = 0.97;

    /**
     * Rotation damping factor (0 = no damping, 1 = full damping)
     */
    rotateDamping = 0.97;

    /**
     * Velocity damping factor when grounded (0 = no damping, 1 = full damping)
     */
    velocityDampingGround = 0.99;

    /**
     * Velocity damping factor when in the air (0 = no damping, 1 = full damping)
     */
    velocityDampingAir = 0.99925;

    /**
     * Forward input scale for auto-walk (matches InputController.moveSpeed for
     * consistent speed with regular WASD walking).
     */
    walkSpeed = 4;

    /**
     * Yaw rotation damping while auto-walking toward a target.
     */
    walkRotateDamping = 0.95;

    /**
     * Callback fired when an auto-walk completes (arrival or obstacle).
     */
    onWalkComplete: (() => void) | null = null;

    private _position = new Vec3();

    private _angles = new Vec3();

    private _velocity = new Vec3();

    private _grounded = false;

    private _jumping = false;

    private _walkTarget: Vec3 | null = null;

    private _walkBlockedFrames = 0;

    onEnter(camera: Camera): void {
        this.goto(camera);
        if (this.collider) {
            this._checkCollision(this._position, d);
            if (d.y > 0) {
                this._grounded = true;
                this._velocity.y = 0;
            }
        }
    }

    /**
     * Whether the controller is currently auto-walking toward a target.
     *
     * @returns True if walking toward a target.
     */
    get isWalking(): boolean {
        return this._walkTarget !== null;
    }

    /**
     * Begin auto-walking toward a world-space target position.
     *
     * @param target - The destination in PlayCanvas world space (XZ used for navigation).
     */
    walkTo(target: Vec3) {
        if (!this._walkTarget) {
            this._walkTarget = new Vec3();
        }
        this._walkTarget.copy(target);
        this._walkBlockedFrames = 0;
    }

    /**
     * Cancel any active auto-walk.
     */
    cancelWalk() {
        if (this._walkTarget) {
            this._walkTarget = null;
            this._walkBlockedFrames = 0;
            this._velocity.x = 0;
            this._velocity.z = 0;
            this.onWalkComplete?.();
        }
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        if (this._walkTarget) {
            this._updateWalk(deltaTime, camera);
            return;
        }

        // jump
        if (this._velocity.y < 0) {
            this._jumping = false;
        }
        if (move[1] && !this._jumping && this._grounded) {
            this._jumping = true;
            this._velocity.y = this.jumpSpeed;
            this._grounded = false;
        }

        // gravity
        this._velocity.y -= this.gravity * deltaTime;

        // rotate
        this._angles.add(v.set(-rotate[1], -rotate[0], 0));
        this._angles.x = math.clamp(this._angles.x, -90, 90);

        // move
        rotation.setFromEulerAngles(0, this._angles.y, 0);
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        offset.set(0, 0, 0);
        offset.add(forward.mulScalar(move[2]));
        offset.add(right.mulScalar(move[0]));
        this._velocity.add(offset.mulScalar(this._grounded ? this.moveGroundSpeed : this.moveAirSpeed));
        const alpha = damp(this._grounded ? this.velocityDampingGround : this.velocityDampingAir, deltaTime);
        this._velocity.x = math.lerp(this._velocity.x, 0, alpha);
        this._velocity.z = math.lerp(this._velocity.z, 0, alpha);
        this._position.add(v.copy(this._velocity).mulScalar(deltaTime));

        // collision check
        this._checkCollision(this._position, d);

        // update camera
        camera.position.copy(this._position);
        camera.angles.set(this._angles.x, this._angles.y, 0);
    }

    onExit(_camera: Camera): void {
        this._walkTarget = null;
        this._walkBlockedFrames = 0;
    }

    /**
     * Teleport the controller to a given camera state (used for transitions).
     *
     * @param camera - The camera state to jump to.
     */
    goto(camera: Camera) {
        // position
        this._position.copy(camera.position);

        // angles (clamp pitch to avoid gimbal lock)
        this._angles.set(camera.angles.x, camera.angles.y, 0);

        // reset velocity and state
        this._velocity.set(0, 0, 0);
        this._grounded = false;
        this._jumping = false;
        this._walkTarget = null;
        this._walkBlockedFrames = 0;
    }

    /**
     * Auto-walk toward `_walkTarget`: rotate to face the target, move forward,
     * and stop on arrival or when blocked by an obstacle.
     *
     * @param deltaTime - Frame delta time in seconds.
     * @param camera - Camera state to update.
     */
    private _updateWalk(deltaTime: number, camera: Camera) {
        const target = this._walkTarget!;

        // gravity
        this._velocity.y -= this.gravity * deltaTime;

        // XZ direction and distance to target
        const dx = target.x - this._position.x;
        const dz = target.z - this._position.z;
        const xzDist = Math.sqrt(dx * dx + dz * dz);

        if (xzDist < WALK_ARRIVAL_DIST) {
            this.cancelWalk();
            this._position.add(v.set(0, this._velocity.y * deltaTime, 0));
            this._checkCollision(this._position, d);
            camera.position.copy(this._position);
            camera.angles.set(this._angles.x, this._angles.y, 0);
            return;
        }

        // smoothly rotate yaw toward target
        const targetYaw = Math.atan2(-dx, -dz) * RAD_TO_DEG;
        let yawDiff = targetYaw - this._angles.y;
        // wrap to [-180, 180]
        yawDiff = ((yawDiff % 360) + 540) % 360 - 180;
        const rotAlpha = damp(this.walkRotateDamping, deltaTime);
        this._angles.y += yawDiff * rotAlpha;

        // move forward along current facing direction
        rotation.setFromEulerAngles(0, this._angles.y, 0);
        rotation.transformVector(Vec3.FORWARD, forward);

        const distBefore = xzDist;

        offset.copy(forward).mulScalar(this.walkSpeed * deltaTime);
        this._velocity.add(offset.mulScalar(this._grounded ? this.moveGroundSpeed : this.moveAirSpeed));
        const alpha = damp(this._grounded ? this.velocityDampingGround : this.velocityDampingAir, deltaTime);
        this._velocity.x = math.lerp(this._velocity.x, 0, alpha);
        this._velocity.z = math.lerp(this._velocity.z, 0, alpha);
        this._position.add(v.copy(this._velocity).mulScalar(deltaTime));

        // collision check
        this._checkCollision(this._position, d);

        // detect horizontal blocking: if we're not making progress toward the
        // target after collision resolution, an obstacle is in the way
        const adx = target.x - this._position.x;
        const adz = target.z - this._position.z;
        const distAfter = Math.sqrt(adx * adx + adz * adz);
        const progress = distBefore - distAfter;

        if (progress < WALK_PROGRESS_EPSILON) {
            this._walkBlockedFrames++;
            if (this._walkBlockedFrames >= WALK_BLOCKED_THRESHOLD) {
                this.cancelWalk();
            }
        } else {
            this._walkBlockedFrames = 0;
        }

        // update camera
        camera.position.copy(this._position);
        camera.angles.set(this._angles.x, this._angles.y, 0);
    }

    /**
     * Check for collision and apply displacement to the position.
     *
     * @param pos - eye position in playcanvas world space
     * @param disp - pre-allocated vector to receive the collision push-out displacement
     * @returns - the displaced position (same as input position vector for chaining)
     */
    private _checkCollision(pos: Vec3, disp: Vec3) {
        // derive capsule center from eye position in PlayCanvas space:
        // bottom of capsule = eyePos.y - eyeHeight
        // capsule center    = eyePos.y - eyeHeight + capsuleHeight / 2
        const center = pos.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;

        // convert to voxel space (negate X, negate Y, keep Z)
        const vx = -pos.x;
        const vy = -center;
        const vz = pos.z;

        if (this.collider!.queryCapsule(vx, vy, vz, half, this.capsuleRadius, out)) {
            // push out vector to playcanvas space
            disp.set(-out.x, -out.y, out.z);

            // apply displacement
            pos.add(disp);

            // ground collision: if pushed upward and falling, cancel downward velocity and set grounded
            if (disp.y > 0 && this._velocity.y < 0) {
                this._velocity.y = 0;
                this._grounded = true;
            }

            // ceiling collision: if pushed downward and rising, cancel upward velocity
            if (disp.y < 0 && this._velocity.y > 0) {
                this._velocity.y = 0;
            }
        }

        return disp;
    }
}

export { FpsController };
