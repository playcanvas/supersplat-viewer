import type { Collision } from './collision';

/**
 * Maximum Euclidean distance (metres) from the spawn origin to search for a valid placement.
 * Used by the cylinder search, which has to reach far enough to find a standable floor. The
 * sphere search sizes itself from its own radius instead — see `SPHERE_SEARCH_REACH_RADII`.
 */
const SEARCH_RADIUS = 5;
const SEARCH_RADIUS_SQ = SEARCH_RADIUS * SEARCH_RADIUS;

/**
 * The sphere search is sized from the sphere itself, in multiples of its radius.
 *
 * Its job is to un-clip a sphere that is intersecting a surface, not to relocate one that is
 * deep inside geometry — `FlyController` holds collision until the camera is clear rather than
 * relying on a rescue — so reaching a few radii is enough. Stepping by half a radius cannot skip
 * a free region the sphere would fit in, since such a region spans at least a diameter and so
 * gets sampled at least four times across.
 *
 * Deriving both from the radius makes the cost independent of the grid. The step never goes below
 * half a radius, so the lattice spans about six cells either side of the origin however fine the
 * voxel grid is: at radius 0.2 on a 0.05 m grid the worst case, finding nothing, is 925 probes.
 * Sizing the search from `voxelResolution` instead cost 8,120,601 probes on that same grid,
 * because a sphere deep inside geometry never finds a free cell to tighten `bestDistSq`, so
 * nothing breaks the search early and it pays for every shell out to `SEARCH_RADIUS`.
 */
const SPHERE_SEARCH_REACH_RADII = 3;
const LATTICE_STEP_RADII = 0.5;

/** Ray budget when probing for ground/ceiling under or above a candidate column. */
const RAY_MAX_DIST = 1000;

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
 * Lattice search outwards from the origin, ordered by Chebyshev shell with
 * Euclidean tie-break within a shell. Both the step and the reach are derived
 * from `radius` — see `SPHERE_SEARCH_REACH_RADII` — so the cost does not depend
 * on the voxel grid. The step never goes finer than the grid, since sampling
 * below `collision.voxelResolution` cannot find anything new.
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
    const step = Math.max(collision.voxelResolution, radius * LATTICE_STEP_RADII);
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

/**
 * Find the closest standable cylinder placement to (ox, oy, oz). Output is the
 * floor world position the cylinder rests on (highest geometry hit across the
 * footprint). Used for walk-camera spawn.
 *
 * The algorithm:
 *
 * 1. Lattice search for the closest free voxel `C` (per `isFreeAt`) that has
 *    geometry somewhere below — i.e. a downward ray from `C` hits.
 * 2. At `(C.x, C.z)`, fan rays up and down from `C.y` through every cell
 *    (step = `collision.voxelResolution`) within the xz footprint disc.
 *    Compute, across columns:
 *      - `floor = max(yDown_i)`         (highest ground in the footprint)
 *      - `ceiling = min(yUp_i)`         (lowest obstruction overhead, or ∞)
 *    Every column must have a `yDown` hit; otherwise the cylinder is partly
 *    unsupported and the candidate is discarded.
 * 3. The cylinder fits iff `floor + halfHeight ≤ ceiling - halfHeight`,
 *    i.e. enough vertical clearance for the full cylinder above the floor.
 *    The "resting on ground" placement has centre at `floor + halfHeight`.
 *
 * Cylinder math (flat ends, no hemispheres) intentionally matches the carve,
 * which used a separable XYZ dilation.
 *
 * @param collision - Active collision implementation.
 * @param ox - Origin X (world space).
 * @param oy - Origin Y (world space).
 * @param oz - Origin Z (world space).
 * @param halfHeight - Cylinder half-height (full height = 2 × halfHeight).
 * @param radius - Cylinder radius.
 * @param out - Receives the floor position the cylinder rests on.
 * @returns True if a valid placement was found.
 */
const findCylinderSpawn = (
    collision: Collision,
    ox: number,
    oy: number,
    oz: number,
    halfHeight: number,
    radius: number,
    out: SpawnOut
): boolean => {
    const step = collision.voxelResolution;

    // The candidate lattice does not need the grid's granularity: a placement the cylinder fits
    // in spans at least a diameter, so sampling every half radius cannot step over one. The
    // footprint fan below deliberately keeps the full voxel resolution — a coarser fan could
    // step over a hole in the floor and call an unsupported placement supported.
    const latticeStep = Math.max(step, radius * LATTICE_STEP_RADII);
    const maxCells = Math.ceil(SEARCH_RADIUS / latticeStep);

    // Round up so float division (e.g. 0.2 / 0.05) can't accidentally drop
    // the outer ring of footprint cells; the Euclidean check below trims any
    // overshoot back to the true radius.
    const footCells = Math.ceil(radius / step);
    const radiusSq = radius * radius;

    let bestDistSq = Infinity;
    let found = false;

    for (let r = 0; r <= maxCells; r++) {
        const shellMinDistSq = r * latticeStep * (r * latticeStep);
        if (shellMinDistSq >= bestDistSq) break;

        for (let dy = -r; dy <= r; dy++) {
            const absDy = dy < 0 ? -dy : dy;
            for (let dz = -r; dz <= r; dz++) {
                const absDz = dz < 0 ? -dz : dz;

                // Enumerate the Chebyshev shell of radius r directly rather than scanning the
                // whole cube and skipping its interior — see `findSphereSpawn`.
                const full = absDy === r || absDz === r;
                const dxStep = full ? 1 : 2 * r;

                for (let dx = -r; dx <= r; dx += dxStep) {
                    const distSq = (dx * dx + dy * dy + dz * dz) * latticeStep * latticeStep;
                    if (distSq >= bestDistSq || distSq > SEARCH_RADIUS_SQ) continue;

                    const cx = ox + dx * latticeStep;
                    const cy = oy + dy * latticeStep;
                    const cz = oz + dz * latticeStep;

                    // Stage 1: cheap filter — only consider free voxels.
                    // The footprint loop below will reject candidates whose
                    // center column has no ground support, so no separate
                    // down-ray probe is needed here.
                    if (!collision.isFreeAt(cx, cy, cz)) continue;

                    // Stage 2/3: fan rays through the xz footprint.
                    let floor = -Infinity;
                    let ceiling = Infinity;
                    let supported = true;

                    for (let i = -footCells; i <= footCells && supported; i++) {
                        const fxOff = i * step;
                        const fxOffSq = fxOff * fxOff;
                        for (let j = -footCells; j <= footCells; j++) {
                            const fzOff = j * step;
                            if (fxOffSq + fzOff * fzOff > radiusSq) continue;

                            const fx = cx + fxOff;
                            const fz = cz + fzOff;

                            const down = collision.queryRay(fx, cy, fz, 0, -1, 0, RAY_MAX_DIST);
                            if (!down) {
                                supported = false;
                                break;
                            }
                            if (down.y > floor) floor = down.y;

                            const up = collision.queryRay(fx, cy, fz, 0, 1, 0, RAY_MAX_DIST);
                            if (up && up.y < ceiling) ceiling = up.y;
                        }
                    }

                    if (!supported) continue;

                    // Cylinder vertical extent = 2 × halfHeight. Need that
                    // much room between floor and ceiling.
                    if (floor + 2 * halfHeight > ceiling) continue;

                    bestDistSq = distSq;
                    out.x = cx;
                    out.y = floor;
                    out.z = cz;
                    found = true;
                }
            }
        }
    }

    return found;
};

export { findCylinderSpawn, findSphereSpawn };
