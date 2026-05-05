import { math, Vec3 } from 'playcanvas';

import type { Collision, PushOut } from '../collision';

/** Extra resolve passes above the collider's internal iteration for tight corners */
const MAX_COLLISION_PASSES = 4;

/** Small clearance that keeps the sphere from resting exactly on a voxel face */
const COLLISION_SKIN = 1e-3;

/** Maximum surface planes to slide along in a single frame */
const MAX_SLIDE_ITERATIONS = 3;

const MIN_MOVE_SQ = 1e-10;

const v = new Vec3();
const remainingMove = new Vec3();
const collisionPush = new Vec3();
const sweepDir = new Vec3();
const sweepNormal = new Vec3();

/** Pre-allocated push-out vector for sphere collision */
const pushOut: PushOut = { x: 0, y: 0, z: 0 };

class SphereMover {
    collision: Collision | null = null;

    readonly radius: number;

    private _lastClearPosition = new Vec3();

    private _hasLastClearPosition = false;

    constructor(radius: number) {
        this.radius = radius;
    }

    reset(position: Vec3) {
        this._setLastClearPosition(position);
    }

    move(position: Vec3, move: Vec3) {
        if (!this.collision) {
            position.add(move);
            this._setLastClearPosition(position);
            return;
        }

        remainingMove.copy(move);

        if (this._isMoveComplete(remainingMove)) {
            this.resolve(position);
            return;
        }

        for (let i = 0; i < MAX_SLIDE_ITERATIONS; i++) {
            if (this._isMoveComplete(remainingMove)) {
                break;
            }

            if (!this._moveAndSlide(position, remainingMove)) {
                break;
            }
        }
    }

    resolve(position: Vec3) {
        if (!this.collision) {
            this._setLastClearPosition(position);
            return;
        }

        this._resolveSphere(position, collisionPush);
        if (!this._isSphereClear(position) && this._hasLastClearPosition) {
            position.copy(this._lastClearPosition);
        }

        if (this._isSphereClear(position)) {
            this._setLastClearPosition(position);
        }
    }

    private _moveAndSlide(position: Vec3, move: Vec3): boolean {
        const moveSq = move.x * move.x + move.y * move.y + move.z * move.z;
        const distance = Math.sqrt(moveSq);
        sweepDir.copy(move).mulScalar(1 / distance);

        const hit = this.collision!.queryRay(
            position.x, position.y, position.z,
            sweepDir.x, sweepDir.y, sweepDir.z,
            distance + this.radius + COLLISION_SKIN
        );

        if (!hit) {
            position.add(move);
            this.resolve(position);
            return false;
        }

        const hx = hit.x - position.x;
        const hy = hit.y - position.y;
        const hz = hit.z - position.z;
        const hitDistance = Math.max(0, hx * sweepDir.x + hy * sweepDir.y + hz * sweepDir.z);
        const travel = math.clamp(hitDistance - this.radius - COLLISION_SKIN, 0, distance);

        position.add(v.copy(sweepDir).mulScalar(travel));
        this.resolve(position);

        const surfaceNormal = this.collision!.querySurfaceNormal(
            hit.x, hit.y, hit.z,
            sweepDir.x, sweepDir.y, sweepDir.z
        );
        sweepNormal.set(surfaceNormal.nx, surfaceNormal.ny, surfaceNormal.nz);

        move.add(v.copy(sweepDir).mulScalar(-travel));
        this._clipMove(move, sweepNormal);

        return true;
    }

    private _resolveSphere(position: Vec3, push: Vec3): boolean {
        let collided = false;
        push.set(0, 0, 0);

        for (let i = 0; i < MAX_COLLISION_PASSES; i++) {
            if (!this.collision!.querySphere(position.x, position.y, position.z, this.radius, pushOut)) {
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
        return !this.collision!.querySphere(position.x, position.y, position.z, this.radius, pushOut);
    }

    private _setLastClearPosition(position: Vec3) {
        this._lastClearPosition.copy(position);
        this._hasLastClearPosition = !this.collision || this._isSphereClear(position);
    }
}

export { SphereMover };
