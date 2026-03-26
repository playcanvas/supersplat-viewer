/**
 * Push-out vector returned by querySphere / queryCapsule.
 */
interface PushOut {
    x: number;
    y: number;
    z: number;
}

/**
 * Hit result returned by queryRay.
 */
interface RayHit {
    x: number;
    y: number;
    z: number;
}

/**
 * Abstract collision interface operating in PlayCanvas world space (Y-up, right-handed).
 * Implementations convert to/from their internal coordinate systems internally.
 */
interface Collision {
    queryRay(
        ox: number, oy: number, oz: number,
        dx: number, dy: number, dz: number,
        maxDist: number
    ): RayHit | null;

    querySphere(
        cx: number, cy: number, cz: number,
        radius: number,
        out: PushOut
    ): boolean;

    queryCapsule(
        cx: number, cy: number, cz: number,
        halfHeight: number, radius: number,
        out: PushOut
    ): boolean;

    querySurfaceNormal(
        x: number, y: number, z: number,
        rdx: number, rdy: number, rdz: number
    ): { nx: number; ny: number; nz: number };
}

/** Minimum penetration depth to report (avoids floating-point noise) */
const PENETRATION_EPSILON = 1e-4;

/** Maximum iterations for iterative sphere/capsule resolution */
const MAX_RESOLVE_ITERATIONS = 4;

/**
 * Iteratively resolve penetrations by repeatedly querying the deepest overlap,
 * projecting against previous constraint normals, and accumulating the push-out.
 * Shared by both MeshCollision and VoxelCollision for sphere and capsule queries.
 *
 * @param cx - Initial query center X.
 * @param cy - Initial query center Y.
 * @param cz - Initial query center Z.
 * @param findPenetration - Callback that finds the deepest penetration from (cx, cy, cz)
 * and writes the push vector into `scratch`. Returns true if a penetration was found.
 * @param constraintNormals - Pre-allocated array of at least 3 normal vectors (mutated).
 * @param scratch - Pre-allocated PushOut for the callback to write into (mutated).
 * @param out - Receives the total accumulated push-out vector on success.
 * @returns True if a meaningful push-out was computed.
 */
function resolveIterative(
    cx: number, cy: number, cz: number,
    findPenetration: (cx: number, cy: number, cz: number, out: PushOut) => boolean,
    constraintNormals: { x: number; y: number; z: number }[],
    scratch: PushOut,
    out: PushOut
): boolean {
    let resolvedX = cx;
    let resolvedY = cy;
    let resolvedZ = cz;
    let totalPushX = 0;
    let totalPushY = 0;
    let totalPushZ = 0;
    let hadCollision = false;
    let numNormals = 0;

    for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
        if (!findPenetration(resolvedX, resolvedY, resolvedZ, scratch)) break;
        hadCollision = true;

        let px = scratch.x;
        let py = scratch.y;
        let pz = scratch.z;

        for (let i = 0; i < numNormals; i++) {
            const n = constraintNormals[i];
            const dot = px * n.x + py * n.y + pz * n.z;
            if (dot < 0) {
                px -= dot * n.x;
                py -= dot * n.y;
                pz -= dot * n.z;
            }
        }

        const len = Math.sqrt(scratch.x * scratch.x + scratch.y * scratch.y + scratch.z * scratch.z);
        if (len > PENETRATION_EPSILON && numNormals < 3) {
            const invLen = 1.0 / len;
            const n = constraintNormals[numNormals];
            n.x = scratch.x * invLen;
            n.y = scratch.y * invLen;
            n.z = scratch.z * invLen;
            numNormals++;
        }

        resolvedX += px;
        resolvedY += py;
        resolvedZ += pz;
        totalPushX += px;
        totalPushY += py;
        totalPushZ += pz;
    }

    const totalPushSq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
    const hasSignificantPush = hadCollision && totalPushSq > PENETRATION_EPSILON * PENETRATION_EPSILON;

    if (hasSignificantPush) {
        out.x = totalPushX;
        out.y = totalPushY;
        out.z = totalPushZ;
    }

    return hasSignificantPush;
}

export { PENETRATION_EPSILON, resolveIterative };
export type { Collision, PushOut, RayHit };
