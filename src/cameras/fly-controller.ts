import {
    math,
    Quat,
    Vec3
} from 'playcanvas';

import type { Collision, PushOut } from '../collision';
import type { CameraFrame, Camera, CameraController } from './camera';

/** Radius of the camera collision sphere (meters) */
const CAMERA_RADIUS = 0.2;

/** Extra resolve passes above the collider's internal iteration for tight corners */
const MAX_COLLISION_PASSES = 4;

/** Small clearance that keeps the camera from resting exactly on a voxel face */
const COLLISION_SKIN = 1e-3;

/** Maximum surface planes to slide along in a single frame */
const MAX_SLIDE_ITERATIONS = 3;

const MIN_MOVE_SQ = 1e-10;

const v = new Vec3();
const remainingMove = new Vec3();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();
const collisionPush = new Vec3();
const sweepDir = new Vec3();
const sweepNormal = new Vec3();
const rotation = new Quat();

/** Pre-allocated push-out vector for sphere collision */
const pushOut: PushOut = { x: 0, y: 0, z: 0 };

class FlyController implements CameraController {
    fov = 90;

    /** Optional collision for sphere collision with sliding */
    collision: Collision | null = null;

    private _position = new Vec3();

    private _angles = new Vec3();

    private _distance = 1;

    private _spawnPosition = new Vec3();

    private _spawnAngles = new Vec3();

    private _spawnDistance = 1;

    private _lastClearPosition = new Vec3();

    private _hasLastClearPosition = false;

    private _hasSpawn = false;

    onEnter(camera: Camera): void {
        this.goto(camera);
        this._resolveCurrentPosition();
        this._storeSpawn();
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        this._angles.add(v.set(-rotate[1], -rotate[0], 0));
        this._angles.x = math.clamp(this._angles.x, -90, 90);

        this._step(move);

        camera.position.copy(this._position);
        camera.angles.set(this._angles.x, this._angles.y, 0);
        camera.distance = this._distance;
        camera.fov = this.fov;
    }

    onExit(_camera: Camera): void {

    }

    goto(camera: Camera) {
        this._position.copy(camera.position);
        this._angles.set(camera.angles.x, camera.angles.y, 0);
        this._distance = camera.distance;
        this._setLastClearPosition(this._position);
    }

    resetToSpawn(camera: Camera): boolean {
        if (!this._hasSpawn) {
            return false;
        }

        this._position.copy(this._spawnPosition);
        this._angles.copy(this._spawnAngles);
        this._distance = this._spawnDistance;
        this._setLastClearPosition(this._position);

        camera.position.copy(this._position);
        camera.angles.copy(this._angles);
        camera.distance = this._distance;
        camera.fov = this.fov;

        return true;
    }

    private _storeSpawn() {
        this._spawnPosition.copy(this._position);
        this._spawnAngles.copy(this._angles);
        this._spawnDistance = this._distance;
        this._hasSpawn = true;
    }

    private _step(move: number[]) {
        rotation.setFromEulerAngles(this._angles);
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        rotation.transformVector(Vec3.UP, up);

        offset.set(0, 0, 0);
        offset.add(forward.mulScalar(move[2]));
        offset.add(right.mulScalar(move[0]));
        offset.add(up.mulScalar(move[1]));

        if (this.collision) {
            this._moveWithCollision(offset);
        } else {
            this._position.add(offset);
        }
    }

    private _moveWithCollision(move: Vec3) {
        remainingMove.copy(move);

        if (this._isMoveComplete(remainingMove)) {
            this._resolveCurrentPosition();
            return;
        }

        for (let i = 0; i < MAX_SLIDE_ITERATIONS; i++) {
            if (this._isMoveComplete(remainingMove)) {
                break;
            }

            if (!this._moveAndSlide(remainingMove)) {
                break;
            }
        }
    }

    private _moveAndSlide(move: Vec3): boolean {
        const moveSq = move.x * move.x + move.y * move.y + move.z * move.z;
        const distance = Math.sqrt(moveSq);
        sweepDir.copy(move).mulScalar(1 / distance);

        const hit = this.collision!.queryRay(
            this._position.x, this._position.y, this._position.z,
            sweepDir.x, sweepDir.y, sweepDir.z,
            distance + CAMERA_RADIUS + COLLISION_SKIN
        );

        if (!hit) {
            this._position.add(move);
            this._resolveCurrentPosition();
            return false;
        }

        const hx = hit.x - this._position.x;
        const hy = hit.y - this._position.y;
        const hz = hit.z - this._position.z;
        const hitDistance = Math.max(0, hx * sweepDir.x + hy * sweepDir.y + hz * sweepDir.z);
        const travel = math.clamp(hitDistance - CAMERA_RADIUS - COLLISION_SKIN, 0, distance);

        this._position.add(v.copy(sweepDir).mulScalar(travel));
        this._resolveCurrentPosition();

        const surfaceNormal = this.collision!.querySurfaceNormal(
            hit.x, hit.y, hit.z,
            sweepDir.x, sweepDir.y, sweepDir.z
        );
        sweepNormal.set(surfaceNormal.nx, surfaceNormal.ny, surfaceNormal.nz);

        move.add(v.copy(sweepDir).mulScalar(-travel));
        this._clipMove(move, sweepNormal);

        return true;
    }

    private _resolveCurrentPosition() {
        if (!this.collision) {
            this._setLastClearPosition(this._position);
            return;
        }

        this._resolveSphere(this._position, collisionPush);
        if (!this._isSphereClear(this._position) && this._hasLastClearPosition) {
            this._position.copy(this._lastClearPosition);
        }

        if (this._isSphereClear(this._position)) {
            this._setLastClearPosition(this._position);
        }
    }

    private _resolveSphere(position: Vec3, push: Vec3): boolean {
        let collided = false;
        push.set(0, 0, 0);

        for (let i = 0; i < MAX_COLLISION_PASSES; i++) {
            if (!this.collision!.querySphere(position.x, position.y, position.z, CAMERA_RADIUS, pushOut)) {
                break;
            }

            position.x += pushOut.x;
            position.y += pushOut.y;
            position.z += pushOut.z;
            push.x += pushOut.x;
            push.y += pushOut.y;
            push.z += pushOut.z;
            collided = true;
        }

        return collided;
    }

    private _clipMove(move: Vec3, push: Vec3) {
        const normalSq = push.x * push.x + push.y * push.y + push.z * push.z;
        if (normalSq <= MIN_MOVE_SQ) {
            return;
        }

        const invPushLen = 1 / Math.sqrt(normalSq);
        const nx = push.x * invPushLen;
        const ny = push.y * invPushLen;
        const nz = push.z * invPushLen;
        const dot = move.x * nx + move.y * ny + move.z * nz;

        if (dot < 0) {
            move.x -= dot * nx;
            move.y -= dot * ny;
            move.z -= dot * nz;
        }
    }

    private _isMoveComplete(move: Vec3): boolean {
        return move.x * move.x + move.y * move.y + move.z * move.z <= MIN_MOVE_SQ;
    }

    private _isSphereClear(position: Vec3): boolean {
        return !this.collision!.querySphere(position.x, position.y, position.z, CAMERA_RADIUS, pushOut);
    }

    private _setLastClearPosition(position: Vec3) {
        this._lastClearPosition.copy(position);
        this._hasLastClearPosition = !this.collision || this._isSphereClear(position);
    }
}

export { FlyController };
