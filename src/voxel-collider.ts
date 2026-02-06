/**
 * Metadata for a voxel octree file (matches the .voxel.json format from splat-transform).
 */
interface VoxelMetadata {
    version: string;
    gridBounds: { min: number[]; max: number[] };
    gaussianBounds: { min: number[]; max: number[] };
    voxelResolution: number;
    leafSize: number;
    treeDepth: number;
    numInteriorNodes: number;
    numMixedLeaves: number;
    nodeCount: number;
    leafDataCount: number;
}

/**
 * Per-axis push-out vector returned by queryAABB.
 */
interface PushOut {
    x: number;
    y: number;
    z: number;
}

/** Solid leaf node marker: high byte = 0x00, no children, no leaf data */
const SOLID_LEAF_MARKER = 0x00000000 >>> 0;

/** Mixed leaf node marker: high byte = 0x00, bit 23 set */
const MIXED_LEAF_FLAG = 0x00800000 >>> 0;

/**
 * Count the number of set bits in a 32-bit integer.
 *
 * @param n - 32-bit integer.
 * @returns Number of bits set to 1.
 */
function popcount(n: number): number {
    n >>>= 0;
    n -= ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

/**
 * Runtime sparse voxel octree collider.
 *
 * Loads the two-file format (.voxel.json + .voxel.bin) produced by
 * splat-transform's writeVoxel and provides point and AABB collision queries.
 */
class VoxelCollider {
    /** Grid-aligned bounds (min xyz) */
    private gridMinX: number;

    private gridMinY: number;

    private gridMinZ: number;

    /** Size of each voxel in world units */
    private voxelResolution: number;

    /** Block size = leafSize * voxelResolution (world units per 4x4x4 block) */
    private blockSize: number;

    /** Voxels per leaf dimension (always 4) */
    private leafSize: number;

    /** Maximum tree depth (number of octree levels above the leaf level) */
    private treeDepth: number;

    /** Flat Laine-Karras node array */
    private nodes: Uint32Array;

    /** Leaf voxel masks: pairs of (lo, hi) Uint32 per mixed leaf */
    private leafData: Uint32Array;

    constructor(
        metadata: VoxelMetadata,
        nodes: Uint32Array,
        leafData: Uint32Array
    ) {
        this.gridMinX = metadata.gridBounds.min[0];
        this.gridMinY = metadata.gridBounds.min[1];
        this.gridMinZ = metadata.gridBounds.min[2];
        this.voxelResolution = metadata.voxelResolution;
        this.leafSize = metadata.leafSize;
        this.blockSize = metadata.leafSize * metadata.voxelResolution;
        this.treeDepth = metadata.treeDepth;
        this.nodes = nodes;
        this.leafData = leafData;
    }

    /**
     * Load a VoxelCollider from a .voxel.json URL.
     * The corresponding .voxel.bin is inferred by replacing the extension.
     *
     * @param jsonUrl - URL to the .voxel.json metadata file.
     * @returns A promise resolving to a VoxelCollider instance.
     */
    static async load(jsonUrl: string): Promise<VoxelCollider> {
        // Fetch metadata
        const metaResponse = await fetch(jsonUrl);
        if (!metaResponse.ok) {
            throw new Error(`Failed to fetch voxel metadata: ${metaResponse.statusText}`);
        }
        const metadata: VoxelMetadata = await metaResponse.json();

        // Fetch binary data
        const binUrl = jsonUrl.replace('.voxel.json', '.voxel.bin');
        const binResponse = await fetch(binUrl);
        if (!binResponse.ok) {
            throw new Error(`Failed to fetch voxel binary: ${binResponse.statusText}`);
        }
        const buffer = await binResponse.arrayBuffer();
        const view = new Uint32Array(buffer);

        const nodes = view.slice(0, metadata.nodeCount);
        const leafData = view.slice(metadata.nodeCount, metadata.nodeCount + metadata.leafDataCount);

        return new VoxelCollider(metadata, nodes, leafData);
    }

    /**
     * Test whether a world-space point lies inside a solid voxel.
     *
     * @param x - World X coordinate.
     * @param y - World Y coordinate.
     * @param z - World Z coordinate.
     * @returns True if the point is inside a solid voxel.
     */
    isPointSolid(x: number, y: number, z: number): boolean {
        const ix = Math.floor((x - this.gridMinX) / this.voxelResolution);
        const iy = Math.floor((y - this.gridMinY) / this.voxelResolution);
        const iz = Math.floor((z - this.gridMinZ) / this.voxelResolution);
        return this.isVoxelSolid(ix, iy, iz);
    }

    /**
     * Query an AABB against the voxel grid and return a push-out vector to resolve penetration.
     *
     * @param minX - AABB minimum X in world space.
     * @param minY - AABB minimum Y in world space.
     * @param minZ - AABB minimum Z in world space.
     * @param maxX - AABB maximum X in world space.
     * @param maxY - AABB maximum Y in world space.
     * @param maxZ - AABB maximum Z in world space.
     * @returns Push-out vector to resolve penetration, or null if no collision.
     */
    queryAABB(
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number
    ): PushOut | null {
        if (this.nodes.length === 0) {
            return null;
        }

        const { voxelResolution, gridMinX, gridMinY, gridMinZ } = this;

        // Convert AABB to voxel index range
        const ixMin = Math.floor((minX - gridMinX) / voxelResolution);
        const iyMin = Math.floor((minY - gridMinY) / voxelResolution);
        const izMin = Math.floor((minZ - gridMinZ) / voxelResolution);
        const ixMax = Math.floor((maxX - gridMinX) / voxelResolution);
        const iyMax = Math.floor((maxY - gridMinY) / voxelResolution);
        const izMax = Math.floor((maxZ - gridMinZ) / voxelResolution);

        let pushX = 0;
        let pushY = 0;
        let pushZ = 0;
        let hasCollision = false;

        // Iterate all voxels overlapping the AABB
        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) {
                        continue;
                    }

                    hasCollision = true;

                    // Compute the voxel-space AABB of this voxel
                    const vMinX = gridMinX + ix * voxelResolution;
                    const vMinY = gridMinY + iy * voxelResolution;
                    const vMinZ = gridMinZ + iz * voxelResolution;
                    const vMaxX = vMinX + voxelResolution;
                    const vMaxY = vMinY + voxelResolution;
                    const vMaxZ = vMinZ + voxelResolution;

                    // Compute overlap depth from both sides on each axis
                    const overlapNegX = maxX - vMinX;
                    const overlapPosX = vMaxX - minX;
                    const overlapNegY = maxY - vMinY;
                    const overlapPosY = vMaxY - minY;
                    const overlapNegZ = maxZ - vMinZ;
                    const overlapPosZ = vMaxZ - minZ;

                    // Pick the minimum overlap side per axis (shortest escape direction)
                    const escapeX = overlapNegX < overlapPosX ? -overlapNegX : overlapPosX;
                    const escapeY = overlapNegY < overlapPosY ? -overlapNegY : overlapPosY;
                    const escapeZ = overlapNegZ < overlapPosZ ? -overlapNegZ : overlapPosZ;

                    // Only push on the axis with the smallest absolute escape (collision normal axis)
                    const absX = Math.abs(escapeX);
                    const absY = Math.abs(escapeY);
                    const absZ = Math.abs(escapeZ);

                    let px = 0;
                    let py = 0;
                    let pz = 0;

                    if (absX <= absY && absX <= absZ) {
                        px = escapeX;
                    } else if (absY <= absZ) {
                        py = escapeY;
                    } else {
                        pz = escapeZ;
                    }

                    // Accumulate maximum absolute push-out per axis across all voxels
                    if (Math.abs(px) > Math.abs(pushX)) {
                        pushX = px;
                    }
                    if (Math.abs(py) > Math.abs(pushY)) {
                        pushY = py;
                    }
                    if (Math.abs(pz) > Math.abs(pushZ)) {
                        pushZ = pz;
                    }
                }
            }
        }

        return hasCollision ? { x: pushX, y: pushY, z: pushZ } : null;
    }

    /**
     * Test whether a voxel at the given grid indices is solid.
     *
     * @param ix - Global voxel X index.
     * @param iy - Global voxel Y index.
     * @param iz - Global voxel Z index.
     * @returns True if the voxel is solid.
     */
    private isVoxelSolid(ix: number, iy: number, iz: number): boolean {
        if (this.nodes.length === 0 || ix < 0 || iy < 0 || iz < 0) {
            return false;
        }

        const { leafSize, treeDepth } = this;

        // Convert voxel indices to block coordinates
        const blockX = Math.floor(ix / leafSize);
        const blockY = Math.floor(iy / leafSize);
        const blockZ = Math.floor(iz / leafSize);

        // Traverse octree from root to leaf
        let nodeIndex = 0;

        for (let level = treeDepth - 1; level >= 0; level--) {
            const node = this.nodes[nodeIndex] >>> 0;
            const childMask = (node >>> 24) & 0xFF;

            // If childMask is 0, this is a leaf node
            if (childMask === 0) {
                return this.checkLeafByIndex(node, ix, iy, iz);
            }

            // Determine which octant the block falls into at this level
            const bitX = (blockX >>> level) & 1;
            const bitY = (blockY >>> level) & 1;
            const bitZ = (blockZ >>> level) & 1;
            const octant = (bitZ << 2) | (bitY << 1) | bitX;

            // Check if this octant has a child
            if ((childMask & (1 << octant)) === 0) {
                return false;
            }

            // Calculate child offset using popcount of lower bits
            const baseOffset = node & 0x00FFFFFF;
            const prefix = (1 << octant) - 1;
            const childOffset = popcount(childMask & prefix);
            nodeIndex = baseOffset + childOffset;
        }

        // We've reached the leaf level
        const node = this.nodes[nodeIndex] >>> 0;
        return this.checkLeafByIndex(node, ix, iy, iz);
    }

    /**
     * Check a leaf node using voxel grid indices.
     *
     * @param node - The leaf node value from the octree.
     * @param ix - Global voxel X index.
     * @param iy - Global voxel Y index.
     * @param iz - Global voxel Z index.
     * @returns True if the voxel is solid.
     */
    private checkLeafByIndex(node: number, ix: number, iy: number, iz: number): boolean {
        // Solid leaf: all voxels in the 4x4x4 block are solid
        if (node === SOLID_LEAF_MARKER) {
            return true;
        }

        // Mixed leaf: check the specific voxel bit
        if ((node & MIXED_LEAF_FLAG) !== 0) {
            const leafDataIndex = node & 0x007FFFFF;

            // Compute voxel coordinates within the 4x4x4 block
            const vx = ix & 3;
            const vy = iy & 3;
            const vz = iz & 3;

            // Bit index within the 64-bit mask: z * 16 + y * 4 + x
            const bitIndex = vz * 16 + vy * 4 + vx;

            // Read the appropriate 32-bit word (lo or hi)
            if (bitIndex < 32) {
                const lo = this.leafData[leafDataIndex * 2] >>> 0;
                return ((lo >>> bitIndex) & 1) === 1;
            }
            const hi = this.leafData[leafDataIndex * 2 + 1] >>> 0;
            return ((hi >>> (bitIndex - 32)) & 1) === 1;
        }

        // Unknown/empty node
        return false;
    }
}

export { VoxelCollider };
export type { PushOut };
