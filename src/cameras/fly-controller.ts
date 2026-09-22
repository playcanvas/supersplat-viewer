import { Vec3 } from 'playcanvas';

import type { Collision } from '../collision';
import type { CameraFrame, Camera, CameraController } from './camera';
import {
    DEFAULT_CONTROLLER_DAMPING,
    applyFrameRotation,
    dampAngles,
    setBasisOffset,
    setCameraBasis
} from './camera-utils';
import { SpawnState } from './spawn-state';
import { SphereMover } from './sphere-mover';
import { findSphereSpawn } from '../collision/find-spawn';

/** Radius of the camera collision sphere (meters) */
const CAMERA_RADIUS = 0.2;

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();
const spawnProbe = new Vec3();
const clearProbe = { x: 0, y: 0, z: 0 };

// Whether the camera sphere fits at `position` without intersecting collision geometry.
const isClear = (collision: Collision, position: Vec3) =>
    !collision.querySphere(position.x, position.y, position.z, CAMERA_RADIUS, clearProbe);

class FlyController implements CameraController {
    fov = 90;

    rotateDamping = DEFAULT_CONTROLLER_DAMPING;

    private _position = new Vec3();

    private _angles = new Vec3();

    private _targetAngles = new Vec3();

    private _distance = 1;

    private _spawn = new SpawnState();

    private _mover = new SphereMover(CAMERA_RADIUS);

    // Collision that arrived while the camera was inside geometry, held until it is somewhere
    // valid. See the `collision` setter.
    private _pendingCollision: Collision | null = null;

    // False until `goto` seeds `_position` from a real camera. Collision is normally attached
    // before this controller has ever been entered, and testing clearance against an unseeded
    // position would hold the attachment for no reason and skip the spawn search in `onEnter`.
    private _hasPosition = false;

    /** Optional collision for sphere collision with sliding */
    set collision(value: Collision | null) {
        // The viewer reveals the scene before the collision data has downloaded, so fly mode has
        // no collision response until it lands and the camera may already be inside geometry by
        // then. The mover cannot escape a solid region: push-out has nothing to push against and
        // `_clipMove` cancels the movement every frame, so the camera sticks. Hold the
        // attachment until the camera is somewhere valid and let `update` engage it, which keeps
        // the flight the user is already making instead of teleporting them out. `onEnter` falls
        // back to the same hold when its spawn search cannot place the camera.
        if (value && this._hasPosition && !isClear(value, this._position)) {
            this._pendingCollision = value;
            return;
        }

        this._pendingCollision = null;
        this._mover.collision = value;
        this._mover.reset(this._position);
    }

    get collision(): Collision | null {
        return this._mover.collision;
    }

    onEnter(camera: Camera): void {
        this.goto(camera);

        const { collision } = this;
        if (collision) {
            if (
                findSphereSpawn(
                    collision,
                    this._position.x,
                    this._position.y,
                    this._position.z,
                    CAMERA_RADIUS,
                    spawnProbe
                )
            ) {
                this._position.copy(spawnProbe);
                this._mover.reset(this._position);
            } else {
                // The search starts at the camera's own cell, so failing means the camera is
                // inside geometry with no free space within `SEARCH_RADIUS` to nudge it to. The
                // mover cannot escape that on its own, so hold collision and let `update` engage
                // it once the camera is clear, as it does for a late attachment.
                this._mover.collision = null;
                this._mover.reset(this._position);
                this._pendingCollision = collision;
            }
        }

        this._storeSpawn();
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        // engage a held attachment as soon as the camera flies back into valid space
        if (this._pendingCollision && isClear(this._pendingCollision, this._position)) {
            this.collision = this._pendingCollision;
        }

        const { move, rotate } = inputFrame.read();

        applyFrameRotation(this._targetAngles, rotate);
        dampAngles(this._angles, this._targetAngles, this.rotateDamping, deltaTime);

        this._step(move);

        camera.position.copy(this._position);
        camera.angles.set(this._angles.x, this._angles.y, 0);
        camera.distance = this._distance;
        camera.fov = this.fov;
    }

    onExit(_camera: Camera) {
        // no cleanup needed
    }

    goto(camera: Camera) {
        this._hasPosition = true;
        this._position.copy(camera.position);
        this._angles.set(camera.angles.x, camera.angles.y, 0);
        this._targetAngles.copy(this._angles);
        this._distance = camera.distance;
        this._mover.reset(this._position);
    }

    resetToSpawn(camera: Camera): boolean {
        if (!this._spawn.has) {
            return false;
        }

        this._distance = this._spawn.restore(this._position, this._angles);
        this._targetAngles.copy(this._angles);
        this._mover.reset(this._position);

        camera.position.copy(this._position);
        camera.angles.copy(this._angles);
        camera.distance = this._distance;
        camera.fov = this.fov;

        return true;
    }

    private _storeSpawn() {
        this._spawn.store(this._position, this._angles, this._distance);
    }

    private _step(move: number[]) {
        setCameraBasis(this._angles, forward, right, up);

        setBasisOffset(offset, move[0], move[1], move[2], forward, right, up);
        this._mover.move(this._position, offset);
    }
}

export { FlyController };
