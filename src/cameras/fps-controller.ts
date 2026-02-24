import { math, Vec3, Quat } from 'playcanvas';

import { damp } from '../core/math';
import type { PushOut, VoxelCollider } from '../voxel-collider';
import type { CameraFrame, Camera, CameraController } from './camera';

/** Pre-allocated push-out vector for capsule collision */
const out: PushOut = { x: 0, y: 0, z: 0 };

const v = new Vec3();

const forward = new Vec3();
const right = new Vec3();

const offset = new Vec3();
const rotation = new Quat();

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
    moveGroundSpeed = 5;

    /**
     * Movement speed in m/s when in the air (for air control)
     */
    moveAirSpeed = 0.5;

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

    private _position = new Vec3();

    private _angles = new Vec3();

    private _velocity = new Vec3();

    private _grounded = false;

    private _jumping = false;

    onEnter(camera: Camera): void {
        this.goto(camera);
    }

    update(dt: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

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
        this._velocity.y -= this.gravity * dt;

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
        const alpha = damp(this._grounded ? this.velocityDampingGround : this.velocityDampingAir, dt);
        this._velocity.x = math.lerp(this._velocity.x, 0, alpha);
        this._velocity.z = math.lerp(this._velocity.z, 0, alpha);
        this._position.add(v.copy(this._velocity).mulScalar(dt));

        // collision check
        this._checkCollision(this._position);

        // update camera
        camera.position.copy(this._position);
        camera.angles.set(this._angles.x, this._angles.y, 0);
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
        // position
        this._position.copy(camera.position);

        // angles (clamp pitch to avoid gimbal lock)
        this._angles.set(camera.angles.x, camera.angles.y, 0);

        // reset velocity and state
        this._velocity.set(0, 0, 0);
        this._grounded = false;
        this._jumping = false;
    }

    /**
     * Check for collision and apply displacement to the position.
     *
     * @param position - eye position in playcanvas world space
     * @returns - the adjusted position after collision resolution
     */
    private _checkCollision(position: Vec3) {
        // derive capsule center from eye position in PlayCanvas space:
        // bottom of capsule = eyePos.y - eyeHeight
        // capsule center    = eyePos.y - eyeHeight + capsuleHeight / 2
        const center = position.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;

        // convert to voxel space (negate X, negate Y, keep Z)
        const vx = -position.x;
        const vy = -center;
        const vz = position.z;

        if (this.collider!.queryCapsule(vx, vy, vz, half, this.capsuleRadius, out)) {
            // push out vector to playcanvas space
            const dx = -out.x;
            const dy = -out.y;
            const dz = out.z;

            // apply displacement
            position.x += dx;
            position.y += dy;
            position.z += dz;

            // ground collision: if pushed upward and falling, cancel downward velocity and set grounded
            if (dy > 0 && this._velocity.y < 0) {
                this._velocity.y = 0;
                this._grounded = true;
            }

            // ceiling collision: if pushed downward and rising, cancel upward velocity
            if (dy < 0 && this._velocity.y > 0) {
                this._velocity.y = 0;
            }
        }

        return position;
    }
}

export { FpsController };
