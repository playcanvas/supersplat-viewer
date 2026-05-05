import { math, Vec3 } from 'playcanvas';

import type { Collision, PushOut } from '../collision';
import type { CameraFrame, Camera, CameraController } from './camera';
import { applyFrameRotation, setBasisOffset, setYawBasis } from './camera-utils';
import { damp } from '../core/math';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 10;
const SPAWN_HIT_EPSILON = 1e-3;
const SPAWN_SEARCH_MIN_STEP = 0.05;

/** Pre-allocated push-out vector for capsule collision */
const out: PushOut = { x: 0, y: 0, z: 0 };

const v = new Vec3();
const d = new Vec3();

const forward = new Vec3();
const right = new Vec3();
const moveStep = [0, 0, 0];

const offset = new Vec3();
const spawnProbe = new Vec3();

/**
 * First-person camera controller with spring-damper suspension over collision terrain.
 *
 * Movement is constrained to the horizontal plane (XZ) relative to the camera yaw.
 * Vertical positioning uses a spring-damper system that hovers the capsule above the
 * collision surface, filtering out terrain noise for smooth camera motion. Capsule
 * collision handles walls and obstacles. When airborne, normal gravity applies.
 */
class WalkController implements CameraController {
    /**
     * Optional collision for capsule collision with sliding
     */
    collision: Collision | null = null;

    /**
     * Field of view in degrees for walk mode.
     */
    fov = 90;

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
     * The capsule hovers this far above terrain to avoid bouncing on noisy surfaces.
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

    /**
     * Maximum vertical raycast distance to search for walk spawn ground.
     */
    spawnSearchRange = 1000;

    private _position = new Vec3();

    private _prevPosition = new Vec3();

    private _angles = new Vec3();

    private _spawnPosition = new Vec3();

    private _spawnAngles = new Vec3();

    private _velocity = new Vec3();

    private _pendingMove = [0, 0, 0];

    private _accumulator = 0;

    private _grounded = false;

    private _jumping = false;

    private _jumpHeld = false;

    private _spawnGrounded = false;

    private _hasSpawn = false;

    onEnter(camera: Camera): void {
        this.goto(camera);
        if (this.collision) {
            if (this._findSpawnPosition(camera.position, spawnProbe)) {
                this._position.copy(spawnProbe);
                this._grounded = true;
                this._velocity.y = 0;
                this._resolveSpawnCollision();
            }

            this._prevPosition.copy(this._position);
            this._storeSpawn();
        }
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        // apply rotation at display rate for responsive mouse look
        applyFrameRotation(this._angles, rotate);

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
        setYawBasis(this._angles.y, forward, right);
        setBasisOffset(offset, move[0], 0, move[2], forward, right, Vec3.UP);
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
        this._resetMotion();
    }

    /**
     * Reset the controller to the spawn pose captured on the last walk-mode entry.
     *
     * @param camera - Camera state to update with the spawn pose.
     * @returns True if a spawn pose was available.
     */
    resetToSpawn(camera: Camera): boolean {
        if (!this._hasSpawn) {
            return false;
        }

        this._position.copy(this._spawnPosition);
        this._prevPosition.copy(this._position);
        this._angles.copy(this._spawnAngles);
        this._resetMotion();
        this._grounded = this._spawnGrounded;

        camera.position.copy(this._position);
        camera.angles.copy(this._angles);
        camera.fov = this.fov;

        return true;
    }

    private _storeSpawn() {
        this._spawnPosition.copy(this._position);
        this._spawnAngles.copy(this._angles);
        this._spawnGrounded = this._grounded;
        this._hasSpawn = true;
    }

    private _resetMotion() {
        this._velocity.set(0, 0, 0);
        this._grounded = false;
        this._jumping = false;
        this._jumpHeld = false;
        this._pendingMove[0] = 0;
        this._pendingMove[1] = 0;
        this._pendingMove[2] = 0;
        this._accumulator = 0;
    }

    /**
     * Resolve the capsule out of solid geometry at spawn time. This is only used
     * when walk mode activates inside collision.
     */
    private _resolveSpawnCollision() {
        for (let i = 0; i < 100; i++) {
            if (!this._queryCapsule(this._position)) {
                break;
            }
            this._position.add(v.set(out.x, out.y, out.z));
        }
    }

    /**
     * Find an eye position for spawning into walk mode. Prefer ground directly
     * below the camera; if that is not usable, search down and then up for the
     * first clear walk placement with ground below it.
     *
     * @param pos - Incoming camera position.
     * @param outPos - Receives the resolved eye position.
     * @returns True if a spawn position was found.
     */
    private _findSpawnPosition(pos: Vec3, outPos: Vec3): boolean {
        const insideSolid = this._isInsideSolid(pos);

        if (this._findClearSpawnGroundBelow(pos, this.spawnSearchRange, !insideSolid, outPos)) {
            return true;
        }

        return this._searchSpawnGround(pos, -1, outPos) || this._searchSpawnGround(pos, 1, outPos);
    }

    /**
     * Search vertically for a clear walk spawn placement with ground below it.
     *
     * @param pos - Starting position.
     * @param direction - Vertical search direction: -1 down, 1 up.
     * @param outPos - Receives the resolved eye position.
     * @returns True if a spawn position was found.
     */
    private _searchSpawnGround(pos: Vec3, direction: -1 | 1, outPos: Vec3): boolean {
        const step = Math.max(this.capsuleRadius, this.hoverHeight, SPAWN_SEARCH_MIN_STEP);
        const endY = pos.y + direction * this.spawnSearchRange;

        for (let y = pos.y + direction * step; direction < 0 ? y >= endY : y <= endY; y += direction * step) {
            spawnProbe.set(pos.x, y, pos.z);

            if (this._findClearSpawnGroundBelow(spawnProbe, this.spawnSearchRange, false, outPos)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Find the first collision surface below a point that can hold a clear walk
     * capsule.
     *
     * @param pos - Ray origin.
     * @param range - Maximum ray distance.
     * @param allowInitialHit - Whether a hit at the ray origin is valid.
     * @param outPos - Receives the resolved eye position.
     * @returns True if a usable ground position was found.
     */
    private _findClearSpawnGroundBelow(pos: Vec3, range: number, allowInitialHit: boolean, outPos: Vec3): boolean {
        const hit = this.collision!.queryRay(pos.x, pos.y, pos.z, 0, -1, 0, range);
        if (!hit) {
            return false;
        }

        if (!allowInitialHit && Math.abs(pos.y - hit.y) <= SPAWN_HIT_EPSILON) {
            return false;
        }

        outPos.set(pos.x, this._getEyeYFromGround(hit.y), pos.z);
        const clear = !this._queryCapsule(outPos);
        const accepted = clear || this._resolveSpawnCandidate(outPos);

        return accepted;
    }

    /**
     * Convert a ground height to the walk controller's eye position.
     *
     * @param groundY - Ground surface height.
     * @returns Eye position Y.
     */
    private _getEyeYFromGround(groundY: number): number {
        return groundY + this.hoverHeight + this.eyeHeight;
    }

    /**
     * Test whether the incoming camera point starts inside solid collision.
     *
     * @param pos - Point to test.
     * @returns True if the point overlaps solid collision.
     */
    private _isInsideSolid(pos: Vec3): boolean {
        return this.collision!.querySphere(pos.x, pos.y, pos.z, SPAWN_HIT_EPSILON, out);
    }

    /**
     * Try to resolve a spawn candidate and verify it remains supported by ground.
     *
     * @param pos - Candidate eye position to resolve in place.
     * @returns True if the candidate can be made clear and still stand on ground.
     */
    private _resolveSpawnCandidate(pos: Vec3): boolean {
        const startX = pos.x;
        const startY = pos.y;
        const startZ = pos.z;
        const maxResolveDistance = this.capsuleRadius + this.hoverHeight;
        const maxResolveDistanceSq = maxResolveDistance * maxResolveDistance;

        for (let i = 0; i < 100; i++) {
            if (!this._queryCapsule(pos)) {
                return this._hasSpawnGroundSupport(pos);
            }

            pos.add(v.set(out.x, out.y, out.z));

            const dx = pos.x - startX;
            const dy = pos.y - startY;
            const dz = pos.z - startZ;
            if (dx * dx + dy * dy + dz * dz > maxResolveDistanceSq) {
                return false;
            }
        }

        return false;
    }

    /**
     * Verify the resolved spawn candidate is still standing close to ground.
     *
     * @param pos - Resolved candidate eye position.
     * @returns True if ground support is still valid.
     */
    private _hasSpawnGroundSupport(pos: Vec3): boolean {
        const groundY = this._probeGround(pos);
        if (groundY === null) {
            return false;
        }

        const clearance = pos.y - this.eyeHeight - groundY;
        return clearance >= -SPAWN_HIT_EPSILON &&
            clearance <= this.hoverHeight + this.capsuleRadius + SPAWN_HIT_EPSILON;
    }

    /**
     * Query the current walk capsule at the supplied eye position.
     *
     * @param pos - Eye position in PlayCanvas world space.
     * @returns True if the capsule overlaps collision.
     */
    private _queryCapsule(pos: Vec3): boolean {
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;
        const center = pos.y - this.eyeHeight + this.capsuleHeight * 0.5;

        return this.collision!.queryCapsule(pos.x, center, pos.z, half, this.capsuleRadius, out);
    }

    /**
     * Cast multiple rays downward to find the average ground surface height.
     * Uses 5 rays (center + 4 cardinal at capsule radius) to spatially filter
     * noisy collision heights, giving the spring a smoother target.
     *
     * @param pos - Eye position in PlayCanvas world space.
     * @returns Average ground surface Y in PlayCanvas space, or null if no ground found.
     */
    private _probeGround(pos: Vec3): number | null {
        if (!this.collision) return null;

        const oy = pos.y - this.eyeHeight;
        const r = this.capsuleRadius;
        const range = this.groundProbeRange;

        let totalY = 0;
        let hitCount = 0;

        for (let i = 0; i < 5; i++) {
            let ox = pos.x;
            let oz = pos.z;
            if (i === 1) ox -= r;
            else if (i === 2) ox += r;
            else if (i === 3) oz += r;
            else if (i === 4) oz -= r;

            const hit = this.collision.queryRay(ox, oy, oz, 0, -1, 0, range);
            if (hit) {
                totalY += hit.y;
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

        if (this.collision!.queryCapsule(pos.x, center, pos.z, half, this.capsuleRadius, out)) {
            disp.set(out.x, out.y, out.z);
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
