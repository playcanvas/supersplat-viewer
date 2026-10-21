import { math, Vec3 } from 'playcanvas';

import type { Collision, PushOut } from '../collision';
import type { CameraFrame, Camera, CameraController } from './camera';
import {
    DEFAULT_CONTROLLER_DAMPING,
    applyFrameRotation,
    dampAngles,
    setBasisOffset,
    setYawBasis
} from './camera-utils';
import { SpawnState } from './spawn-state';
import { damp } from '../core/math';

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 10;

/**
 * How far below the capsule a floor must be for collision to engage. With none in reach the
 * capsule is over a hole in the collision, or far above anything it could land on, and engaged
 * collision would drop it out of the scene, so collision is held instead.
 */
const FLOOR_SEARCH_DIST = 10;

/**
 * How far below the camera entry looks for a floor to stand on. Unbounded in practice, unlike
 * `FLOOR_SEARCH_DIST`: entering from high up, from an orbit view, should land on the floor below.
 */
const ENTRY_FLOOR_DIST = 1000;

/**
 * How far above the camera entry looks for a floor, when there is none to stand on below it: a
 * camera sunk into the ground or just under it stands on the surface above instead.
 */
const ENTRY_RISE_REACH = 2;

/**
 * Spacing of the rays that look for a floor above the camera. Each is cast down from its own
 * height, so a surface between two floors cannot hide the lower one from all of them.
 */
const ENTRY_RISE_STEP = 0.25;

/**
 * Reach of the entry un-clip, in capsule radii, as `FlyController`'s: enough to free a capsule
 * that clips a surface, not to relocate one deep inside geometry, which holds collision instead.
 */
const UNCLIP_REACH_RADII = 3;

/** Pre-allocated push-out vector for capsule collision */
const out: PushOut = { x: 0, y: 0, z: 0 };

const v = new Vec3();
const d = new Vec3();
const nudged = new Vec3();

const forward = new Vec3();
const right = new Vec3();
const moveStep = [0, 0, 0];

const offset = new Vec3();

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
     * Rotation damping factor (0 = no damping, 1 = full damping)
     */
    rotateDamping = DEFAULT_CONTROLLER_DAMPING;

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

    private _position = new Vec3();

    private _prevPosition = new Vec3();

    private _angles = new Vec3();

    private _targetAngles = new Vec3();

    private _distance = 1;

    private _spawn = new SpawnState();

    private _velocity = new Vec3();

    private _pendingMove = [0, 0, 0];

    private _accumulator = 0;

    private _grounded = false;

    private _jumping = false;

    private _jumpHeld = false;

    private _collision: Collision | null = null;

    /**
     * Collision held because the capsule is inside geometry, mirroring `FlyController`, or
     * because there is no floor within `FLOOR_SEARCH_DIST` below it, where engaged collision
     * would fall out of the scene.
     * While held, `_heldFloorY` stands in for the ground probe so the camera walks on the level
     * it was held at instead of falling, and the capsule check is skipped. `_step` engages it for
     * real as soon as the capsule fits over a floor.
     */
    private _pendingCollision: Collision | null = null;

    /**
     * Synthetic ground height. Set while `_pendingCollision` is held, and while walk mode is
     * active with no collision at all: the viewer attaches collision after the scene is
     * interactive, so a host can enter walk before the data has arrived.
     */
    private _heldFloorY: number | null = null;

    // False until `goto` seeds `_position` from a real camera, so an attach before this
    // controller has ever been entered engages directly instead of testing clearance against an
    // unseeded position.
    private _hasPosition = false;

    /**
     * Optional collision for capsule collision with sliding. Assigning while the capsule is
     * inside geometry, or over no floor in reach, holds the attachment instead: engaged collision
     * cannot escape a solid region and has nothing to land on over a void, so the capsule keeps
     * the synthetic floor and `_step` engages it once it fits over a floor. Collision normally
     * lands this way, after walk mode may already be active.
     */
    set collision(value: Collision | null) {
        if (value && this._hasPosition && !this._canEngage(value, this._position)) {
            this._hold(value);
            return;
        }

        this._pendingCollision = null;
        this._heldFloorY = null;
        this._collision = value;
    }

    get collision(): Collision | null {
        return this._collision;
    }

    onEnter(camera: Camera): void {
        this.goto(camera);

        // Entry may follow a previous one that ended with collision held, so start from the
        // collision we have either way. Whether to hold again is decided fresh, from this
        // entry's position.
        const collision = this._collision ?? this._pendingCollision;

        // Stand on the entry level until collision can engage. This covers collision that has not
        // arrived yet as well as an entry inside geometry or over no floor, where engaged
        // collision would strand the camera or drop it. Held, the user can walk out the way they
        // came, and the setter or `_step` engages collision once the capsule fits over a floor.
        this._pendingCollision = null;
        this._collision = null;
        this._heldFloorY = this._position.y - this.eyeHeight - this.hoverHeight;
        this._grounded = true;

        if (collision) {
            if (!this._standOnFloor(collision)) {
                this._fit(collision, this._position);
            }
            this.collision = collision;
        }

        // reset returns to where walk was entered
        this._spawn.store(this._position, this._angles, this._distance);

        this._prevPosition.copy(this._position);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        // apply rotation at display rate for responsive mouse look
        applyFrameRotation(this._targetAngles, rotate);
        dampAngles(this._angles, this._targetAngles, this.rotateDamping, deltaTime);

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
        camera.distance = this._distance;
        camera.fov = this.fov;
    }

    private _step(dt: number, move: number[]) {
        // engage a held attachment as soon as the capsule reaches space it fits in, over a floor
        if (this._pendingCollision && this._canEngage(this._pendingCollision, this._position)) {
            this._collision = this._pendingCollision;
            this._pendingCollision = null;
            this._heldFloorY = null;
        }

        // ground probe: cast a ray downward to find the terrain surface
        let groundY = this._probeGround(this._position);

        // airborne with no floor in reach, over a hole in the collision, would fall out of the
        // scene: hold collision and walk on at this level until there is floor below again
        if (groundY === null && this._collision && !this._floorBelow(this._collision, this._position)) {
            this._hold(this._collision);
            groundY = this._heldFloorY;
        }
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
        this._hasPosition = true;
        this._position.copy(camera.position);
        this._prevPosition.copy(this._position);

        // angles (clamp pitch to avoid gimbal lock)
        this._angles.set(camera.angles.x, camera.angles.y, 0);
        this._targetAngles.copy(this._angles);
        this._distance = camera.distance;

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
        if (!this._spawn.has) {
            return false;
        }

        this._distance = this._spawn.restore(this._position, this._angles);
        this._prevPosition.copy(this._position);
        this._targetAngles.copy(this._angles);
        this._resetMotion();

        // decide afresh at the spawn whether to engage or hold, since a held floor belongs to
        // wherever it was held, mirroring `FlyController`
        const collision = this._collision ?? this._pendingCollision;
        if (collision) {
            this.collision = collision;
        }

        camera.position.copy(this._position);
        camera.angles.copy(this._angles);
        camera.distance = this._distance;
        camera.fov = this.fov;

        return true;
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
     * Whether the walk capsule fits at `pos` without intersecting collision geometry.
     *
     * @param collision - Collision to test against.
     * @param pos - Eye position in PlayCanvas world space.
     * @returns True if the capsule is clear.
     */
    private _capsuleClear(collision: Collision, pos: Vec3): boolean {
        const center = pos.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;
        return !collision.queryCapsule(pos.x, center, pos.z, half, this.capsuleRadius, out);
    }

    /**
     * Whether there is a floor within `FLOOR_SEARCH_DIST` below the capsule.
     *
     * @param collision - Collision to test against.
     * @param pos - Eye position in PlayCanvas world space.
     * @returns True if a downward ray from the capsule's foot hits geometry in reach.
     */
    private _floorBelow(collision: Collision, pos: Vec3): boolean {
        return !!collision.queryRay(pos.x, pos.y - this.eyeHeight, pos.z, 0, -1, 0, FLOOR_SEARCH_DIST);
    }

    private _canEngage(collision: Collision, pos: Vec3): boolean {
        return this._capsuleClear(collision, pos) && this._floorBelow(collision, pos);
    }

    /**
     * Put the eye at standing height on a floor, so the capsule neither sinks into the ground nor
     * hangs over it: the floor below the camera however far down, for a camera flown onto the
     * ground or entering from above, and failing that the nearest floor up to `ENTRY_RISE_REACH`
     * above it, for a camera sunk into the ground or just under it. Below comes first, or an
     * entry from high up could stand on a roof. A floor counts only if the capsule fits standing
     * on it, after `_fit`; with none, the camera stays where it is.
     *
     * @param collision - Collision to test against.
     * @returns True if the camera was moved onto a floor.
     */
    private _standOnFloor(collision: Collision): boolean {
        const pos = this._position;
        if (this._tryStandFrom(collision, pos.y, ENTRY_FLOOR_DIST)) return true;

        for (let rise = ENTRY_RISE_STEP; rise <= ENTRY_RISE_REACH + 1e-6; rise += ENTRY_RISE_STEP) {
            if (this._tryStandFrom(collision, pos.y + rise, rise)) return true;
        }
        return false;
    }

    /**
     * Stand on the floor a downward ray from `fromY` finds within `maxDist`, if the capsule fits
     * there once `_fit` has freed it from a wall it clips. A ray that hits at its origin started
     * inside geometry and finds no floor.
     *
     * @param collision - Collision to test against.
     * @param fromY - Height to cast from, above the camera's column.
     * @param maxDist - Reach of the ray.
     * @returns True if the camera was moved onto a floor.
     */
    private _tryStandFrom(collision: Collision, fromY: number, maxDist: number): boolean {
        const pos = this._position;
        const hit = collision.queryRay(pos.x, fromY, pos.z, 0, -1, 0, maxDist);
        if (!hit || hit.y >= fromY) return false;

        v.set(pos.x, hit.y + this.hoverHeight + this.eyeHeight, pos.z);
        if (!this._fit(collision, v)) return false;

        pos.copy(v);
        return true;
    }

    /**
     * Fit the capsule at `p`, freeing it from a surface it clips: move it by the push-out of one
     * capsule query, if that is within `UNCLIP_REACH_RADII` and leaves it clear. Otherwise `p` is
     * left as it was.
     *
     * @param collision - Collision to test against.
     * @param p - Eye position, moved if the capsule had to be freed.
     * @returns True if the capsule fits at `p`.
     */
    private _fit(collision: Collision, p: Vec3): boolean {
        const center = p.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;
        if (!collision.queryCapsule(p.x, center, p.z, half, this.capsuleRadius, out)) return true;

        const reach = this.capsuleRadius * UNCLIP_REACH_RADII;
        if (out.x * out.x + out.y * out.y + out.z * out.z > reach * reach) return false;

        nudged.set(p.x + out.x, p.y + out.y, p.z + out.z);
        if (!this._capsuleClear(collision, nudged)) return false;

        p.copy(nudged);
        return true;
    }

    /**
     * Hold `collision` rather than engage it, standing on the current level.
     *
     * @param collision - Collision to engage once the capsule can.
     */
    private _hold(collision: Collision) {
        this._pendingCollision = collision;
        this._collision = null;
        this._heldFloorY = this._position.y - this.eyeHeight - this.hoverHeight;
        this._velocity.y = 0;
        this._jumping = false;
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
        // While collision is held the real surface is unreachable, so stand on the level the
        // camera entered at. Without this the camera reads as airborne and falls.
        if (this._heldFloorY !== null) return this._heldFloorY;

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
        if (!this.collision) return;

        const center = pos.y - this.eyeHeight + this.capsuleHeight * 0.5;
        const half = this.capsuleHeight * 0.5 - this.capsuleRadius;

        if (this.collision.queryCapsule(pos.x, center, pos.z, half, this.capsuleRadius, out)) {
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
