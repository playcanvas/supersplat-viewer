import { math, Vec3 } from 'playcanvas';

import { damp } from '../core/math';
import type { PushOut, VoxelCollider } from '../voxel-collider';
import type { CameraFrame, Camera, CameraController } from './camera';

/** Pre-allocated push-out vector for capsule collision */
const pushOut: PushOut = { x: 0, y: 0, z: 0 };

/**
 * First-person shooter style camera controller with gravity and capsule collision.
 *
 * Movement is constrained to the horizontal plane (XZ) relative to the camera yaw.
 * Vertical motion is driven by gravity and resolved by capsule collision with the
 * voxel grid. The camera is positioned at eye height within the capsule.
 */
class FpsController implements CameraController {
    /** Optional voxel collider for capsule collision with sliding */
    collider: VoxelCollider | null = null;

    /** Total capsule height in meters (default: human proportion) */
    capsuleHeight = 1.8;

    /** Capsule radius in meters */
    capsuleRadius = 0.3;

    /** Camera height from the bottom of the capsule in meters */
    eyeHeight = 1.6;

    /** Gravity acceleration in m/s^2 */
    gravity = 9.8;

    /** Jump velocity in m/s */
    jumpSpeed = 5;

    /** Movement damping factor (0 = no damping, 1 = full damping) */
    moveDamping = 0.97;

    /** Rotation damping factor (0 = no damping, 1 = full damping) */
    rotateDamping = 0.97;

    // Target state (where input drives)
    private _targetPosition = new Vec3();

    private _targetYaw = 0;

    private _targetPitch = 0;

    // Smoothed state (lerps toward target)
    private _position = new Vec3();

    private _yaw = 0;

    private _pitch = 0;

    // Vertical velocity for gravity
    private _velocityY = 0;

    // Whether the capsule is resting on the ground
    private _onGround = false;

    onEnter(camera: Camera): void {
        this._position.copy(camera.position);
        this._targetPosition.copy(camera.position);

        // angles.x = pitch, angles.y = yaw
        this._pitch = camera.angles.x;
        this._targetPitch = camera.angles.x;
        this._yaw = camera.angles.y;
        this._targetYaw = camera.angles.y;

        this._velocityY = 0;
        this._onGround = false;
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        // --- Rotation ---
        this._targetYaw -= rotate[0];
        this._targetPitch = math.clamp(this._targetPitch - rotate[1], -90, 90);

        const rotateLerp = damp(this.rotateDamping, deltaTime);
        this._yaw = math.lerpAngle(this._yaw, this._targetYaw, rotateLerp);
        this._pitch = math.lerp(this._pitch, this._targetPitch, rotateLerp);

        // Normalize yaw to prevent floating-point drift over long sessions.
        // Shift both values by the same multiple of 360 to preserve their delta.
        const yawOffset = Math.round(this._yaw / 360) * 360;
        if (yawOffset !== 0) {
            this._yaw -= yawOffset;
            this._targetYaw -= yawOffset;
        }

        // --- Horizontal movement ---
        // Compute forward/right from yaw only (ignore pitch for movement)
        const yawRad = this._targetYaw * math.DEG_TO_RAD;
        const sinYaw = Math.sin(yawRad);
        const cosYaw = Math.cos(yawRad);

        // PlayCanvas convention: forward = -Z, right = +X
        const forwardX = -sinYaw;
        const forwardZ = -cosYaw;
        const rightX = cosYaw;
        const rightZ = -sinYaw;

        const moveLerp = damp(this.moveDamping, deltaTime);

        this._targetPosition.x += rightX * move[0] + forwardX * move[2];
        this._targetPosition.z += rightZ * move[0] + forwardZ * move[2];

        // --- Jump ---
        if (move[1] > 0 && this._onGround) {
            this._velocityY = this.jumpSpeed;
            this._onGround = false;
        }

        // --- Gravity ---
        this._velocityY -= this.gravity * deltaTime;
        this._targetPosition.y += this._velocityY * deltaTime;

        // --- Capsule collision on target position ---
        if (this.collider) {
            this._resolveCapsuleCollision(this._targetPosition, true);
        }

        // --- Smooth horizontal position toward target ---
        this._position.x = math.lerp(this._position.x, this._targetPosition.x, moveLerp);
        this._position.z = math.lerp(this._position.z, this._targetPosition.z, moveLerp);
        // No smoothing on Y for crisp ground contact
        this._position.y = this._targetPosition.y;

        // --- Capsule collision on smoothed position ---
        if (this.collider) {
            this._resolveCapsuleCollision(this._position, false);
        }

        // --- Output to camera ---
        camera.position.copy(this._position);
        camera.angles.set(this._pitch, this._yaw, 0);
    }

    onExit(_camera: Camera): void {
        // nothing to clean up
    }

    /**
     * Teleport the controller to a given camera state (used for transitions).
     *
     * @param camera - The camera state to jump to.
     */
    goto(camera: Camera) {
        this._position.copy(camera.position);
        this._targetPosition.copy(camera.position);
        this._pitch = camera.angles.x;
        this._targetPitch = camera.angles.x;
        this._yaw = camera.angles.y;
        this._targetYaw = camera.angles.y;
        this._velocityY = 0;
        this._onGround = false;
    }

    /**
     * Resolve capsule collision for a given eye position, modifying it in place.
     * Converts from PlayCanvas space to voxel space, queries the capsule, and
     * applies the push-out vector back to PlayCanvas space.
     *
     * @param eyePos - Eye position to resolve (modified in place).
     * @param isTarget - Whether this is the target position (updates velocity on ground contact).
     */
    private _resolveCapsuleCollision(eyePos: Vec3, isTarget: boolean) {
        // Derive capsule center from eye position in PlayCanvas space:
        // bottom of capsule = eyePos.y - eyeHeight
        // capsule center    = eyePos.y - eyeHeight + capsuleHeight / 2
        const capsuleCenterPCY = eyePos.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const halfHeight = this.capsuleHeight * 0.5 - this.capsuleRadius;

        // Convert to voxel space (negate X, negate Y, keep Z)
        const vx = -eyePos.x;
        const vy = -capsuleCenterPCY;
        const vz = eyePos.z;

        if (this.collider!.queryCapsule(vx, vy, vz, halfHeight, this.capsuleRadius, pushOut)) {
            // Convert push-out back to PlayCanvas space
            const pushPCX = -pushOut.x;
            const pushPCY = -pushOut.y;
            const pushPCZ = pushOut.z;

            eyePos.x += pushPCX;
            // Push-out applies to capsule center; eye moves by the same amount
            eyePos.y += pushPCY;
            eyePos.z += pushPCZ;

            // Ground detection: if pushed upward and falling, cancel downward velocity
            if (isTarget) {
                if (pushPCY > 0 && this._velocityY < 0) {
                    this._velocityY = 0;
                    this._onGround = true;
                }
                // Ceiling detection: if pushed downward and rising, cancel upward velocity
                if (pushPCY < 0 && this._velocityY > 0) {
                    this._velocityY = 0;
                }
            }
        }
    }
}

export { FpsController };
