import { resolveIterative } from './collision';
import type { Collision, PushOut, RayHit } from './collision';
import { loadVoxelCollision } from './voxel-collision';
import type { VoxelCollision, VoxelMetadata } from './voxel-collision';

type Bounds3 = { min: [number, number, number]; max: [number, number, number] };

type VoxelTileEntry = {
    id: string;
    ix: number;
    iz: number;
    coreBounds: Bounds3;
    dataBounds: Bounds3;
    url: string;
};

/** World-space XZ tiles. Each URL references an ordinary voxel 1.1 JSON/bin pair. */
type VoxelTileManifest = {
    version: 1;
    voxelResolution: number;
    tileSize: number;
    overlap: number;
    fullBounds: Bounds3;
    tiles: VoxelTileEntry[];
};

const contains = (bounds: Bounds3, x: number, z: number) =>
    x >= bounds.min[0] && x < bounds.max[0] && z >= bounds.min[2] && z < bounds.max[2];

const validBounds = (bounds: Bounds3) =>
    bounds &&
    Array.isArray(bounds.min) &&
    Array.isArray(bounds.max) &&
    bounds.min.length === 3 &&
    bounds.max.length === 3 &&
    bounds.min.every((v, i) => Number.isFinite(v) && Number.isFinite(bounds.max[i]) && v < bounds.max[i]);

const encloses = (outer: Bounds3, inner: Bounds3) =>
    inner.min.every((v, i) => v >= outer.min[i] && inner.max[i] <= outer.max[i]);

/** Reject malformed manifests before issuing tile requests. */
const validateVoxelTileManifest = (manifest: VoxelTileManifest): void => {
    if (
        manifest?.version !== 1 ||
        !Number.isFinite(manifest.voxelResolution) ||
        manifest.voxelResolution <= 0 ||
        !Number.isFinite(manifest.tileSize) ||
        manifest.tileSize <= 0 ||
        !Number.isFinite(manifest.overlap) ||
        manifest.overlap < 0 ||
        !validBounds(manifest.fullBounds) ||
        !Array.isArray(manifest.tiles)
    ) {
        throw new Error('Invalid voxel tile manifest');
    }
    const ids = new Set<string>();
    const cells = new Set<string>();
    for (const tile of manifest.tiles) {
        const cell = `${tile?.ix},${tile?.iz}`;
        if (
            !tile ||
            typeof tile.id !== 'string' ||
            !tile.id ||
            ids.has(tile.id) ||
            !Number.isSafeInteger(tile.ix) ||
            !Number.isSafeInteger(tile.iz) ||
            tile.ix < 0 ||
            tile.iz < 0 ||
            cells.has(cell) ||
            typeof tile.url !== 'string' ||
            !tile.url ||
            !validBounds(tile.coreBounds) ||
            !validBounds(tile.dataBounds) ||
            !encloses(tile.dataBounds, tile.coreBounds) ||
            !encloses(manifest.fullBounds, tile.coreBounds)
        ) {
            throw new Error(`Invalid voxel tile: ${tile?.id ?? '(missing id)'}`);
        }
        // Grid indices drive the 3x3 neighborhood and readiness assumes disjoint cores.
        // Validate their geometry rather than trusting labels on arbitrary rectangles.
        for (const [axis, index] of [
            [0, tile.ix],
            [2, tile.iz]
        ]) {
            const min = manifest.fullBounds.min[axis] + index * manifest.tileSize;
            const max = Math.min(manifest.fullBounds.max[axis], min + manifest.tileSize);
            const tolerance = manifest.voxelResolution * 1e-6;
            if (
                Math.abs(tile.coreBounds.min[axis] - min) > tolerance ||
                Math.abs(tile.coreBounds.max[axis] - max) > tolerance
            ) {
                throw new Error(`Invalid voxel tile grid bounds: ${tile.id}`);
            }
        }
        ids.add(tile.id);
        cells.add(cell);
    }
};

/** Bounded collision working set, independent of splat LOD and the rendering backend. */
class TiledVoxelCollision implements Collision {
    private readonly urls = new Map<string, string>();

    private readonly loaded = new Map<string, VoxelCollision>();

    private readonly loading = new Map<string, AbortController>();

    private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();

    private readonly attempts = new Map<string, number>();

    private active: VoxelTileEntry[] = [];

    private center: VoxelTileEntry | undefined;

    private destroyed = false;

    private readonly scratch: PushOut = { x: 0, y: 0, z: 0 };

    private readonly push: PushOut = { x: 0, y: 0, z: 0 };

    private readonly constraints = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
    ];

    onTilesChanged: (() => void) | null = null;

    constructor(
        readonly manifest: VoxelTileManifest,
        manifestUrl: string
    ) {
        validateVoxelTileManifest(manifest);
        for (const tile of manifest.tiles) this.urls.set(tile.id, new URL(tile.url, manifestUrl).href);
    }

    get voxelResolution(): number {
        return this.manifest.voxelResolution;
    }

    getActiveColliders(): VoxelCollision[] {
        return this.active.flatMap((tile) => {
            const collision = this.loaded.get(tile.id);
            return collision ? [collision] : [];
        });
    }

    updatePosition(x: number, z: number): void {
        if (this.destroyed) return;
        const center = this.manifest.tiles.find((tile) => contains(tile.coreBounds, x, z));
        // A gap means no collision coverage, not the closest available tile.
        if (center === this.center) return;
        this.center = center;
        this.active = center
            ? this.manifest.tiles.filter(
                  (tile) => Math.abs(tile.ix - center.ix) <= 1 && Math.abs(tile.iz - center.iz) <= 1
              )
            : [];
        const desired = new Set(this.active.map((tile) => tile.id));
        for (const id of this.loaded.keys()) {
            if (!desired.has(id)) this.loaded.delete(id);
        }
        for (const [id, controller] of this.loading) {
            if (!desired.has(id)) {
                controller.abort();
                this.loading.delete(id);
            }
        }
        for (const [id, timer] of this.retries) {
            if (!desired.has(id)) {
                clearTimeout(timer);
                this.retries.delete(id);
                this.attempts.delete(id);
            }
        }
        for (const id of this.attempts.keys()) {
            if (!desired.has(id)) this.attempts.delete(id);
        }
        for (const tile of this.active) this.ensureLoaded(tile);
        this.onTilesChanged?.();
    }

    isReadyAt(x: number, z: number, radius = 0): boolean {
        if (this.destroyed || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) {
            return false;
        }
        const center = this.active.find((tile) => contains(tile.coreBounds, x, z));
        if (!center || !this.loaded.has(center.id)) return false;
        if (radius === 0) return true;
        // Cover the whole footprint, including a tile across a seam. Missing/omitted cores
        // are deliberately not traversable. Core rectangles form a disjoint XZ partition.
        let covered = 0;
        for (const tile of this.active) {
            const width = Math.min(x + radius, tile.coreBounds.max[0]) - Math.max(x - radius, tile.coreBounds.min[0]);
            const depth = Math.min(z + radius, tile.coreBounds.max[2]) - Math.max(z - radius, tile.coreBounds.min[2]);
            if (width > 0 && depth > 0) {
                if (!this.loaded.has(tile.id)) return false;
                covered += width * depth;
            }
        }
        return Math.abs(covered - 4 * radius * radius) <= 1e-8 * Math.max(1, radius * radius);
    }

    isFreeAt(x: number, y: number, z: number): boolean {
        if (!this.isReadyAt(x, z)) return false;
        let free = false;
        for (const tile of this.active) {
            if (!contains(tile.dataBounds, x, z)) continue;
            const collision = this.loaded.get(tile.id);
            if (!collision || collision.isSolidAt(x, y, z)) return false;
            free ||= collision.isFreeAt(x, y, z);
        }
        return free;
    }

    queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
        let best: RayHit | null = null;
        let distance = Infinity;
        for (const collision of this.getActiveColliders()) {
            const hit = collision.queryRay(ox, oy, oz, dx, dy, dz, maxDist);
            if (!hit) continue;
            const d = (hit.x - ox) ** 2 + (hit.y - oy) ** 2 + (hit.z - oz) ** 2;
            if (d < distance) {
                best = { x: hit.x, y: hit.y, z: hit.z };
                distance = d;
            }
        }
        return best;
    }

    querySurfaceNormal(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
        const nudge = this.voxelResolution * 0.25;
        for (const collision of this.getActiveColliders()) {
            if (collision.isSolidAt(x + Math.sign(dx) * nudge, y + Math.sign(dy) * nudge, z + Math.sign(dz) * nudge)) {
                return collision.querySurfaceNormal(x, y, z, dx, dy, dz);
            }
        }
        return { nx: 0, ny: 1, nz: 0 };
    }

    querySphere(x: number, y: number, z: number, radius: number, out: PushOut): boolean {
        return this.queryVolume(x, y, z, 0, radius, out, false);
    }

    queryCapsule(x: number, y: number, z: number, halfHeight: number, radius: number, out: PushOut): boolean {
        return this.queryVolume(x, y, z, halfHeight, radius, out, true);
    }

    private queryVolume(x: number, y: number, z: number, half: number, radius: number, out: PushOut, capsule: boolean) {
        const colliders = this.getActiveColliders();
        // Resolve the deepest occupied voxel across the union, not one complete push per
        // tile. Overlapping copies of the same surface must not double the displacement.
        return resolveIterative(
            x,
            y,
            z,
            (cx, cy, cz, push) => {
                let deepest = 0;
                for (const collision of colliders) {
                    const hit = capsule
                        ? collision.resolveDeepestPenetrationCapsule(cx, cy, cz, half, radius, this.scratch)
                        : collision.resolveDeepestPenetration(cx, cy, cz, radius, this.scratch);
                    const length = this.scratch.x ** 2 + this.scratch.y ** 2 + this.scratch.z ** 2;
                    if (hit && length > deepest) {
                        deepest = length;
                        Object.assign(push, this.scratch);
                    }
                }
                return deepest > 0;
            },
            this.constraints,
            this.push,
            out
        );
    }

    private ensureLoaded(tile: VoxelTileEntry): void {
        if (this.destroyed || this.loaded.has(tile.id) || this.loading.has(tile.id) || this.retries.has(tile.id))
            return;
        const controller = new AbortController();
        this.loading.set(tile.id, controller);
        const url = this.urls.get(tile.id);
        loadVoxelCollision(url, controller.signal)
            .then((collision) => {
                if (this.destroyed || this.loading.get(tile.id) !== controller) return;
                if (collision.formatVersion !== '1.1' || collision.voxelResolution !== this.voxelResolution) {
                    throw new Error('Tiles must use world-space voxel 1.1 data at the manifest resolution');
                }
                const min = [collision.gridMinX, collision.gridMinY, collision.gridMinZ];
                const count = [collision.numVoxelsX, collision.numVoxelsY, collision.numVoxelsZ];
                if (
                    min.some(
                        (value, axis) =>
                            Math.abs(value - tile.dataBounds.min[axis]) > this.voxelResolution * 1e-6 ||
                            Math.abs(value + count[axis] * this.voxelResolution - tile.dataBounds.max[axis]) >
                                this.voxelResolution * 1e-6
                    )
                ) {
                    throw new Error(`Voxel tile grid does not match dataBounds: ${tile.id}`);
                }
                this.loading.delete(tile.id);
                this.loaded.set(tile.id, collision);
                this.attempts.delete(tile.id);
                this.onTilesChanged?.();
            })
            .catch((error: Error) => {
                if (this.destroyed || this.loading.get(tile.id) !== controller) return;
                this.loading.delete(tile.id);
                const attempt = (this.attempts.get(tile.id) ?? 0) + 1;
                this.attempts.set(tile.id, attempt);
                if (attempt === 1) console.warn(`Failed to load voxel tile ${tile.id}; retrying:`, error);
                // A stationary camera must also recover. Back off to one retry per 30s and
                // clear the timer when leaving the neighborhood or destroying the viewer.
                this.retries.set(
                    tile.id,
                    setTimeout(
                        () => {
                            this.retries.delete(tile.id);
                            this.ensureLoaded(tile);
                        },
                        Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30000)
                    )
                );
                this.onTilesChanged?.();
            });
    }

    destroy(): void {
        this.destroyed = true;
        this.onTilesChanged = null;
        for (const controller of this.loading.values()) controller.abort();
        for (const timer of this.retries.values()) clearTimeout(timer);
        this.loading.clear();
        this.retries.clear();
        this.attempts.clear();
        this.loaded.clear();
        this.active = [];
    }
}

/** Load either ordinary voxel metadata or a tiled manifest through the same collision URL. */
const loadVoxelCollisionAsset = async (
    url: string,
    signal?: AbortSignal
): Promise<VoxelCollision | TiledVoxelCollision> => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Failed to fetch voxel collision: ${response.statusText}`);
    const metadata = await response.json();
    signal?.throwIfAborted();
    if (metadata && typeof metadata === 'object' && 'tiles' in metadata) {
        return new TiledVoxelCollision(metadata, response.url || url);
    }
    return loadVoxelCollision(url, signal, metadata as VoxelMetadata);
};

export { TiledVoxelCollision, loadVoxelCollisionAsset, validateVoxelTileManifest };
export type { VoxelTileEntry, VoxelTileManifest };
