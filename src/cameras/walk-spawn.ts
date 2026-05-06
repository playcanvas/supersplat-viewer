import { Vec3 } from 'playcanvas';

import type { Collision, PushOut } from '../collision';

const SPAWN_HIT_EPSILON = 1e-3;
const SPAWN_SEARCH_MIN_STEP = 0.05;
const SPAWN_SEARCH_MAX_STEPS = 128;

interface SpawnParams {
    capsuleHeight: number;
    capsuleRadius: number;
    eyeHeight: number;
    hoverHeight: number;
    spawnSearchRange: number;
}

const out: PushOut = { x: 0, y: 0, z: 0 };
const v = new Vec3();
const probe = new Vec3();

const queryCapsule = (collision: Collision, pos: Vec3, p: SpawnParams): boolean => {
    const half = p.capsuleHeight * 0.5 - p.capsuleRadius;
    const center = pos.y - p.eyeHeight + p.capsuleHeight * 0.5;
    return collision.queryCapsule(pos.x, center, pos.z, half, p.capsuleRadius, out);
};

const eyeYFromGround = (groundY: number, p: SpawnParams) => groundY + p.hoverHeight + p.eyeHeight;

const isInsideSolid = (collision: Collision, pos: Vec3): boolean => {
    return collision.querySphere(pos.x, pos.y, pos.z, SPAWN_HIT_EPSILON, out);
};

const probeGroundY = (collision: Collision, pos: Vec3, p: SpawnParams): number | null => {
    const hit = collision.queryRay(pos.x, pos.y, pos.z, 0, -1, 0, p.spawnSearchRange);
    return hit ? hit.y : null;
};

const hasSpawnGroundSupport = (collision: Collision, pos: Vec3, p: SpawnParams): boolean => {
    const groundY = probeGroundY(collision, pos, p);
    if (groundY === null) {
        return false;
    }

    const clearance = pos.y - p.eyeHeight - groundY;
    return clearance >= -SPAWN_HIT_EPSILON &&
        clearance <= p.hoverHeight + p.capsuleRadius + SPAWN_HIT_EPSILON;
};

// Push a candidate eye position out of solid geometry. Returns true if the
// candidate becomes clear within the allowed budget and remains supported by
// ground beneath it.
const resolveSpawnCandidate = (collision: Collision, pos: Vec3, p: SpawnParams): boolean => {
    const startX = pos.x;
    const startY = pos.y;
    const startZ = pos.z;
    const maxResolveDistance = p.capsuleRadius + p.hoverHeight;
    const maxResolveDistanceSq = maxResolveDistance * maxResolveDistance;

    for (let i = 0; i < 100; i++) {
        if (!queryCapsule(collision, pos, p)) {
            return hasSpawnGroundSupport(collision, pos, p);
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
};

// Find the first collision surface below a point that can hold a clear walk
// capsule. Writes the resolved eye position to outPos on success.
const findClearSpawnGroundBelow = (
    collision: Collision,
    pos: Vec3,
    range: number,
    allowInitialHit: boolean,
    p: SpawnParams,
    outPos: Vec3
): boolean => {
    const hit = collision.queryRay(pos.x, pos.y, pos.z, 0, -1, 0, range);
    if (!hit) {
        return false;
    }

    if (!allowInitialHit && Math.abs(pos.y - hit.y) <= SPAWN_HIT_EPSILON) {
        return false;
    }

    outPos.set(pos.x, eyeYFromGround(hit.y, p), pos.z);
    const clear = !queryCapsule(collision, outPos, p);
    return clear || resolveSpawnCandidate(collision, outPos, p);
};

const searchSpawnGround = (
    collision: Collision,
    pos: Vec3,
    direction: -1 | 1,
    p: SpawnParams,
    outPos: Vec3
): boolean => {
    const step = Math.max(
        p.capsuleRadius,
        p.hoverHeight,
        SPAWN_SEARCH_MIN_STEP,
        p.spawnSearchRange / SPAWN_SEARCH_MAX_STEPS
    );
    const endY = pos.y + direction * p.spawnSearchRange;

    for (let y = pos.y + direction * step; direction < 0 ? y >= endY : y <= endY; y += direction * step) {
        probe.set(pos.x, y, pos.z);

        if (findClearSpawnGroundBelow(collision, probe, p.spawnSearchRange, false, p, outPos)) {
            return true;
        }
    }

    return false;
};

/**
 * Find an eye position for spawning into walk mode. Prefer ground directly
 * below the camera; if that is not usable, search down and then up for the
 * first clear walk placement with ground below it. On success, the resolved
 * eye position is written to outPos.
 *
 * @param collision - The active collision implementation.
 * @param pos - Incoming camera position.
 * @param p - Walk capsule and spawn-search parameters.
 * @param outPos - Receives the resolved eye position.
 * @returns True if a spawn position was found.
 */
const findWalkSpawn = (collision: Collision, pos: Vec3, p: SpawnParams, outPos: Vec3): boolean => {
    const insideSolid = isInsideSolid(collision, pos);

    if (findClearSpawnGroundBelow(collision, pos, p.spawnSearchRange, !insideSolid, p, outPos)) {
        return true;
    }

    return searchSpawnGround(collision, pos, -1, p, outPos) ||
        searchSpawnGround(collision, pos, 1, p, outPos);
};

export { findWalkSpawn };
export type { SpawnParams };
