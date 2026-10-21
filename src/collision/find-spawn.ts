import type { Collision } from './collision';

/**
 * Reach of the sphere search, in multiples of the sphere's radius.
 *
 * Its job is to un-clip a sphere that is intersecting a surface, not to relocate one that is deep
 * inside geometry — `FlyController` holds collision until the camera is clear rather than relying
 * on a rescue — so reaching a few radii is enough. Bounding the reach is what makes the search
 * cheap: at radius 0.2 on a 0.05 m grid the worst case, finding nothing, is 7,153 probes, where
 * reaching 5 m cost 8,120,601. A sphere deep inside geometry never finds a free cell
 * to tighten `bestDistSq`, so nothing breaks the search early and it pays for every shell.
 *
 * The lattice still steps by `collision.voxelResolution`, deliberately. A coarser step is not
 * safe: the valid positions for a collider's centre are free space eroded by its radius, which
 * can be far narrower than the free space itself. A 0.45 m passage admits a 0.2 m sphere across
 * only a 0.05 m band of centres, so a 0.1 m lattice steps straight over it and reports no
 * placement at all.
 */
const SPHERE_SEARCH_REACH_RADII = 3;

type SpawnOut = {
    x: number;
    y: number;
    z: number;
};

// Scratch values reused across calls — these helpers run only at spawn time
// so the lack of re-entrancy is fine.
const scratchPush = { x: 0, y: 0, z: 0 };

/**
 * Find the closest sphere placement to (ox, oy, oz) where a sphere of `radius`
 * fits clear of geometry. Output is the sphere centre. Used for fly-camera
 * spawn — fly cameras have no ground constraint.
 *
 * Lattice search across voxel-spaced offsets from the origin (step =
 * `collision.voxelResolution`), ordered by Chebyshev shell with Euclidean
 * tie-break within a shell. Reach is derived from `radius` — see
 * `SPHERE_SEARCH_REACH_RADII`.
 *
 * @param collision - Active collision implementation.
 * @param ox - Origin X (world space).
 * @param oy - Origin Y (world space).
 * @param oz - Origin Z (world space).
 * @param radius - Sphere radius.
 * @param out - Receives the sphere centre on success.
 * @returns True if a valid placement was found.
 */
const findSphereSpawn = (
    collision: Collision,
    ox: number,
    oy: number,
    oz: number,
    radius: number,
    out: SpawnOut
): boolean => {
    const step = collision.voxelResolution;
    const reach = radius * SPHERE_SEARCH_REACH_RADII;
    const reachSq = reach * reach;
    const maxCells = Math.ceil(reach / step);

    let bestDistSq = Infinity;
    let found = false;

    for (let r = 0; r <= maxCells; r++) {
        const shellMinDistSq = r * step * (r * step);
        if (shellMinDistSq >= bestDistSq) break;

        for (let dy = -r; dy <= r; dy++) {
            const absDy = dy < 0 ? -dy : dy;
            for (let dz = -r; dz <= r; dz++) {
                const absDz = dz < 0 ? -dz : dz;

                // Enumerate the Chebyshev shell of radius r directly instead of scanning the
                // whole cube and skipping its interior. A row is fully on the shell when dy or dz
                // is already at the extreme; otherwise only its two end cells are, so dx jumps
                // straight across the interior. `full` is always true at r = 0, so the stride is
                // never zero.
                const full = absDy === r || absDz === r;
                const dxStep = full ? 1 : 2 * r;

                for (let dx = -r; dx <= r; dx += dxStep) {
                    const distSq = (dx * dx + dy * dy + dz * dz) * step * step;
                    if (distSq >= bestDistSq || distSq > reachSq) continue;

                    const cx = ox + dx * step;
                    const cy = oy + dy * step;
                    const cz = oz + dz * step;

                    if (collision.querySphere(cx, cy, cz, radius, scratchPush)) continue;

                    bestDistSq = distSq;
                    out.x = cx;
                    out.y = cy;
                    out.z = cz;
                    found = true;
                }
            }
        }
    }

    return found;
};

export { findSphereSpawn };
