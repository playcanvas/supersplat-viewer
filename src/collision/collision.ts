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

export type { Collision, PushOut, RayHit };
