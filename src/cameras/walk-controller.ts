import { math, Vec3, Quat } from 'playcanvas';

import { damp } from '../core/math';
import type { PushOut, VoxelCollider } from '../voxel-collider';
import type { CameraFrame, Camera, CameraController } from './camera';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 10;

/** Pre-allocated push-out vector for capsule collision */
const out: PushOut = { x: 0, y: 0, z: 0 };

const v = new Vec3();
const d = new Vec3();

const forward = new Vec3();
const right = new Vec3();
const moveStep = [0, 0, 0];

const offset = new Vec3();
const rotation = new Quat();

/**
 * First-person camera controller with spring-damper suspension over voxel terrain.
 *
 * Movement is constrained to the horizontal plane (XZ) relative to the camera yaw.
 * Vertical positioning uses a spring-damper system that hovers the capsule above the
 * voxel surface, filtering out terrain noise for smooth camera motion. Capsule
 * collision handles walls and obstacles. When airborne, normal gravity applies.
 */
class WalkController implements CameraController {
    /**
     * Optional voxel collider for capsule collision with sliding
     */
    collider: VoxelCollider | null = null;

    /**
     * Field of view in degrees for walk mode.
     */
    fov = 96;

    /**
     * Total capsule height in meters (default: human proportion)
     */
    capsuleHeight = 1.5;

    /**
     * Capsule radius in meters
     */
    capsuleRadius = 0.2;

    /**
     * Camera height from the bottom of the capsule in meters
     */
    eyeHeight = 1.3;

    /**
     * Gravity acceleration in m/s^2
     */
    gravity = 9.8;

    /**
     * Jump velocity in m/s
     */
    jumpSpeed = 4;

    /**
     * Movement speed in m/s when grounded
     */
    moveGroundSpeed = 7;

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
    velocityDampingAir = 0.998;

    /**
     * Target clearance from capsule bottom to ground surface in meters.
     * The capsule hovers this far above terrain to avoid bouncing on noisy voxels.
     */
    hoverHeight = 0.2;

    /**
     * Spring stiffness for ground-following suspension (higher = stiffer tracking).
     */
    springStiffness = 800;

    /**
     * Damping coefficient for ground-following suspension.
     * Critical damping is approximately 2 * sqrt(springStiffness).
     */
    springDamping = 57;

    /**
     * Maximum downward raycast distance to search for ground below the capsule.
     */
    groundProbeRange = 1.0;

    private _position = new Vec3();

    private _prevPosition = new Vec3();

    private _angles = new Vec3();

    private _velocity = new Vec3();

    private _pendingMove = [0, 0, 0];

    private _accumulator = 0;

    private _grounded = false;

    private _jumping = false;

    private _jumpHeld = false;

    onEnter(camera: Camera): void {
        this.goto(camera);
        if (this.collider) {
            const groundY = this._probeGround(this._position);
            if (groundY !== null) {
                this._grounded = true;
                this._velocity.y = 0;
                this._position.y = groundY + this.hoverHeight + this.eyeHeight;
                this._prevPosition.copy(this._position);
            }
        }
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        // apply rotation at display rate for responsive mouse look
        this._angles.add(v.set(-rotate[1], -rotate[0], 0));
        this._angles.x = math.clamp(this._angles.x, -90, 90);

        // accumulate movement input so frames without a physics step don't lose input
        this._pendingMove[0] += move[0];
        this._pendingMove[1] = this._pendingMove[1] || move[1];
        this._pendingMove[2] += move[2];

        this._accumulator = Math.min(this._accumulator + deltaTime, MAX_SUBSTEPS * FIXED_DT);

        const numSteps = Math.floor(this._accumulator / FIXED_DT);

        if (numSteps > 0) {
            const invSteps = 1 / numSteps;
            moveStep[0] = this._pendingMove[0] * invSteps;
            moveStep[1] = this._pendingMove[1];
            moveStep[2] = this._pendingMove[2] * invSteps;

            for (let i = 0; i < numSteps; i++) {
                this._prevPosition.copy(this._position);
                this._step(FIXED_DT, moveStep);
                this._accumulator -= FIXED_DT;
            }

            this._pendingMove[0] = 0;
            this._pendingMove[1] = 0;
            this._pendingMove[2] = 0;
        }

        const alpha = this._accumulator / FIXED_DT;
        camera.position.lerp(this._prevPosition, this._position, alpha);
        camera.angles.set(this._angles.x, this._angles.y, 0);
        camera.fov = this.fov;
    }

    private _step(dt: number, move: number[]) {
        // ground probe: cast a ray downward to find the terrain surface
        const groundY = this._probeGround(this._position);
        const hasGround = groundY !== null;

        // jump (require release before re-triggering)
        if (this._velocity.y < 0) {
            this._jumping = false;
        }
        if (move[1] && !this._jumping && this._grounded && !this._jumpHeld) {
            this._jumping = true;
            this._velocity.y = this.jumpSpeed;
            this._grounded = false;
        }
        this._jumpHeld = !!move[1];

        // vertical force: spring-damper when ground is detected, gravity when airborne
        if (hasGround && !this._jumping) {
            const targetY = groundY + this.hoverHeight + this.eyeHeight;
            const displacement = this._position.y - targetY;

            if (displacement > 0.1) {
                // well above target (jump/ledge): freefall, snap to rest height on arrival
                this._velocity.y -= this.gravity * dt;
                const nextY = this._position.y + this._velocity.y * dt;
                if (nextY <= targetY) {
                    this._position.y = targetY;
                    this._velocity.y = 0;
                }
                this._grounded = false;
            } else {
                // at or near target (walking/slopes): spring tracks terrain
                const springForce = -this.springStiffness * displacement - this.springDamping * this._velocity.y;
                this._velocity.y += springForce * dt;
                this._grounded = true;
            }
        } else {
            this._velocity.y -= this.gravity * dt;
            this._grounded = false;
        }

        // move
        rotation.setFromEulerAngles(0, this._angles.y, 0);
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        offset.set(0, 0, 0);
        offset.add(forward.mulScalar(move[2]));
        offset.add(right.mulScalar(move[0]));
        this._velocity.add(offset.mulScalar(this._grounded ? this.moveGroundSpeed : this.moveAirSpeed));

        const dampFactor = this._grounded ? this.velocityDampingGround : this.velocityDampingAir;
        const alpha = damp(dampFactor, dt);
        this._velocity.x = math.lerp(this._velocity.x, 0, alpha);
        this._velocity.z = math.lerp(this._velocity.z, 0, alpha);

        this._position.add(v.copy(this._velocity).mulScalar(dt));

        // capsule collision: walls, ceiling, and fallback floor contact
        this._checkCollision(this._position, d);
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
        this._prevPosition.copy(this._position);

        // angles (clamp pitch to avoid gimbal lock)
        this._angles.set(camera.angles.x, camera.angles.y, 0);

        // reset velocity and state
        this._velocity.set(0, 0, 0);
        this._grounded = false;
        this._jumping = false;
        this._pendingMove[0] = 0;
        this._pendingMove[1] = 0;
        this._pendingMove[2] = 0;
        this._accumulator = 0;
    }

    /**
     * Cast multiple rays downward to find the average ground surface height.
     * Uses 5 rays (center + 4 cardinal at capsule radius) to spatially filter
     * noisy voxel heights, giving the spring a smoother target.
     *
     * @param pos - Eye position in PlayCanvas world space.
     * @returns Average ground surface Y in PlayCanvas space, or null if no ground found.
     */
    private _probeGround(pos: Vec3): number | null {
        if (!this.collider) return null;

        const vy = -(pos.y - this.eyeHeight);
        const r = this.capsuleRadius;
        const range = this.groundProbeRange;

        let totalY = 0;
        let hitCount = 0;

        for (let i = 0; i < 5; i++) {
            let vx = -pos.x;
            let vz = pos.z;
            if (i === 1) vx -= r;
            else if (i === 2) vx += r;
            else if (i === 3) vz += r;
            else if (i === 4) vz -= r;

            const hit = this.collider.queryRay(vx, vy, vz, 0, 1, 0, range);
            if (hit) {
                totalY += -hit.y;
                hitCount++;
            }
        }

        return hitCount > 0 ? totalY / hitCount : null;
    }

    /**
     * Check for capsule collision and apply push-out displacement.
     * Handles walls, ceiling hits, and fallback floor contact when airborne.
     *
     * @param pos - Eye position in PlayCanvas world space.
     * @param disp - Pre-allocated vector to receive the collision push-out displacement.
     */
    private _checkCollision(pos: Vec3, disp: Vec3) {
        const center = pos.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;

        // convert to voxel space (negate X, negate Y, keep Z)
        const vx = -pos.x;
        const vy = -center;
        const vz = pos.z;

        if (this.collider!.queryCapsule(vx, vy, vz, half, this.capsuleRadius, out)) {
            disp.set(-out.x, -out.y, out.z);
            pos.add(disp);

            // ceiling collision: cancel upward velocity
            if (disp.y < 0 && this._velocity.y > 0) {
                this._velocity.y = 0;
            }

            // airborne floor collision: transition to grounded as a fallback safety net
            if (!this._grounded && disp.y > 0 && this._velocity.y < 0) {
                this._velocity.y = 0;
                this._grounded = true;
            }
        }
    }
}

export { WalkController };
