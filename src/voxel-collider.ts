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
 * Push-out vector returned by querySphere / queryCapsule.
 */
interface PushOut {
    x: number;
    y: number;
    z: number;
}

/**
 * Solid leaf node marker: childMask = 0xFF, baseOffset = 0.
 * Unambiguous because BFS layout guarantees children always come after their parent,
 * so baseOffset = 0 is never valid for an interior node.
 */
const SOLID_LEAF_MARKER = 0xFF000000 >>> 0;

/** Minimum penetration depth to report a collision (avoids floating-point noise at corners) */
const PENETRATION_EPSILON = 1e-4;

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
 * splat-transform's writeVoxel and provides point and sphere collision queries.
 */
class VoxelCollider {
    /** Grid-aligned bounds (min xyz) */
    private _gridMinX: number;

    private _gridMinY: number;

    private _gridMinZ: number;

    /** Number of voxels along each axis */
    private _numVoxelsX: number;

    private _numVoxelsY: number;

    private _numVoxelsZ: number;

    /** Size of each voxel in world units */
    private _voxelResolution: number;

    /** Voxels per leaf dimension (always 4) */
    private _leafSize: number;

    /** Maximum tree depth (number of octree levels above the leaf level) */
    private _treeDepth: number;

    /** Flat Laine-Karras node array */
    private _nodes: Uint32Array;

    /** Leaf voxel masks: pairs of (lo, hi) Uint32 per mixed leaf */
    private _leafData: Uint32Array;

    /** Pre-allocated scratch push-out vector to avoid per-frame allocations */
    private readonly _push: PushOut = { x: 0, y: 0, z: 0 };

    /** Pre-allocated constraint normals for iterative corner resolution (max 3 walls) */
    private readonly _constraintNormals = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
    ];

    constructor(
        metadata: VoxelMetadata,
        nodes: Uint32Array,
        leafData: Uint32Array
    ) {
        this._gridMinX = metadata.gridBounds.min[0];
        this._gridMinY = metadata.gridBounds.min[1];
        this._gridMinZ = metadata.gridBounds.min[2];
        const res = metadata.voxelResolution;
        this._numVoxelsX = Math.round((metadata.gridBounds.max[0] - metadata.gridBounds.min[0]) / res);
        this._numVoxelsY = Math.round((metadata.gridBounds.max[1] - metadata.gridBounds.min[1]) / res);
        this._numVoxelsZ = Math.round((metadata.gridBounds.max[2] - metadata.gridBounds.min[2]) / res);
        this._voxelResolution = res;
        this._leafSize = metadata.leafSize;
        this._treeDepth = metadata.treeDepth;
        this._nodes = nodes;
        this._leafData = leafData;
    }

    /**
     * Grid-aligned bounds minimum X in world units.
     *
     * @returns {number} The minimum X coordinate.
     */
    get gridMinX(): number {
        return this._gridMinX;
    }

    /**
     * Grid-aligned bounds minimum Y in world units.
     *
     * @returns {number} The minimum Y coordinate.
     */
    get gridMinY(): number {
        return this._gridMinY;
    }

    /**
     * Grid-aligned bounds minimum Z in world units.
     *
     * @returns {number} The minimum Z coordinate.
     */
    get gridMinZ(): number {
        return this._gridMinZ;
    }

    /**
     * Number of voxels along the X axis.
     *
     * @returns {number} The voxel count on X.
     */
    get numVoxelsX(): number {
        return this._numVoxelsX;
    }

    /**
     * Number of voxels along the Y axis.
     *
     * @returns {number} The voxel count on Y.
     */
    get numVoxelsY(): number {
        return this._numVoxelsY;
    }

    /**
     * Number of voxels along the Z axis.
     *
     * @returns {number} The voxel count on Z.
     */
    get numVoxelsZ(): number {
        return this._numVoxelsZ;
    }

    /**
     * Size of each voxel in world units.
     *
     * @returns {number} The voxel resolution.
     */
    get voxelResolution(): number {
        return this._voxelResolution;
    }

    /**
     * Voxels per leaf dimension (always 4).
     *
     * @returns {number} The leaf size.
     */
    get leafSize(): number {
        return this._leafSize;
    }

    /**
     * Maximum tree depth (number of octree levels above the leaf level).
     *
     * @returns {number} The tree depth.
     */
    get treeDepth(): number {
        return this._treeDepth;
    }

    /**
     * Flat Laine-Karras node array (read-only access for GPU upload).
     *
     * @returns {Uint32Array} The node array.
     */
    get nodes(): Uint32Array {
        return this._nodes;
    }

    /**
     * Leaf voxel masks: pairs of (lo, hi) Uint32 per mixed leaf (read-only access for GPU upload).
     *
     * @returns {Uint32Array} The leaf data array.
     */
    get leafData(): Uint32Array {
        return this._leafData;
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
     * Query whether a world-space point lies inside a solid voxel.
     *
     * @param x - World X coordinate.
     * @param y - World Y coordinate.
     * @param z - World Z coordinate.
     * @returns True if the point is inside a solid voxel.
     */
    queryPoint(x: number, y: number, z: number): boolean {
        const ix = Math.floor((x - this.gridMinX) / this.voxelResolution);
        const iy = Math.floor((y - this.gridMinY) / this.voxelResolution);
        const iz = Math.floor((z - this.gridMinZ) / this.voxelResolution);
        return this.isVoxelSolid(ix, iy, iz);
    }

    /**
     * Query a sphere against the voxel grid and write a push-out vector to resolve penetration.
     * Uses iterative single-voxel resolution: each iteration finds the deepest penetrating voxel,
     * resolves it, then re-checks. This avoids over-push from summing multiple voxels and
     * naturally handles corners (2 iterations) and flat walls (1 iteration).
     *
     * @param cx - Sphere center X in world units.
     * @param cy - Sphere center Y in world units.
     * @param cz - Sphere center Z in world units.
     * @param radius - Sphere radius in world units.
     * @param out - Object to receive the push-out vector.
     * @returns True if a collision was detected and out was written.
     */
    querySphere(
        cx: number, cy: number, cz: number,
        radius: number,
        out: PushOut
    ): boolean {
        if (this.nodes.length === 0) {
            return false;
        }

        const maxIterations = 4;
        let resolvedX = cx;
        let resolvedY = cy;
        let resolvedZ = cz;
        let totalPushX = 0;
        let totalPushY = 0;
        let totalPushZ = 0;
        let hadCollision = false;

        const push = this._push;

        // Constraint normals from previous iterations - prevents oscillation at corners
        // by ensuring subsequent pushes don't undo previous ones
        const normals = this._constraintNormals;
        let numNormals = 0;

        for (let iter = 0; iter < maxIterations; iter++) {
            if (!this.resolveDeepestPenetration(resolvedX, resolvedY, resolvedZ, radius)) {
                break;
            }
            hadCollision = true;

            let px = push.x;
            let py = push.y;
            let pz = push.z;

            // Project out components that contradict previous constraint normals
            for (let i = 0; i < numNormals; i++) {
                const n = normals[i];
                const dot = px * n.x + py * n.y + pz * n.z;
                if (dot < 0) {
                    px -= dot * n.x;
                    py -= dot * n.y;
                    pz -= dot * n.z;
                }
            }

            // Record this push direction as a constraint normal
            const len = Math.sqrt(push.x * push.x + push.y * push.y + push.z * push.z);
            if (len > PENETRATION_EPSILON && numNormals < 3) {
                const invLen = 1.0 / len;
                const n = normals[numNormals];
                n.x = push.x * invLen;
                n.y = push.y * invLen;
                n.z = push.z * invLen;
                numNormals++;
            }

            resolvedX += px;
            resolvedY += py;
            resolvedZ += pz;
            totalPushX += px;
            totalPushY += py;
            totalPushZ += pz;
        }

        // Only report collision if the total push is meaningful
        const totalPushSq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
        const hasSignificantPush = hadCollision && totalPushSq > PENETRATION_EPSILON * PENETRATION_EPSILON;

        if (hasSignificantPush) {
            out.x = totalPushX;
            out.y = totalPushY;
            out.z = totalPushZ;
        }

        return hasSignificantPush;
    }

    /**
     * Query a vertical capsule against the voxel grid and write a push-out vector to resolve
     * penetration. The capsule is a line segment from (cx, cy - halfHeight, cz) to
     * (cx, cy + halfHeight, cz) swept by radius. Uses the same iterative deepest-penetration
     * approach as querySphere.
     *
     * @param cx - Capsule center X in world units.
     * @param cy - Capsule center Y in world units.
     * @param cz - Capsule center Z in world units.
     * @param halfHeight - Half-height of the capsule's inner line segment in world units.
     * @param radius - Capsule radius in world units.
     * @param out - Object to receive the push-out vector.
     * @returns True if a collision was detected and out was written.
     */
    queryCapsule(
        cx: number, cy: number, cz: number,
        halfHeight: number,
        radius: number,
        out: PushOut
    ): boolean {
        if (this.nodes.length === 0) {
            return false;
        }

        const maxIterations = 4;
        let resolvedX = cx;
        let resolvedY = cy;
        let resolvedZ = cz;
        let totalPushX = 0;
        let totalPushY = 0;
        let totalPushZ = 0;
        let hadCollision = false;

        const push = this._push;

        // Constraint normals from previous iterations - prevents oscillation at corners
        // by ensuring subsequent pushes don't undo previous ones
        const normals = this._constraintNormals;
        let numNormals = 0;

        for (let iter = 0; iter < maxIterations; iter++) {
            if (!this.resolveDeepestPenetrationCapsule(resolvedX, resolvedY, resolvedZ, halfHeight, radius)) {
                break;
            }
            hadCollision = true;

            let px = push.x;
            let py = push.y;
            let pz = push.z;

            // Project out components that contradict previous constraint normals
            for (let i = 0; i < numNormals; i++) {
                const n = normals[i];
                const dot = px * n.x + py * n.y + pz * n.z;
                if (dot < 0) {
                    px -= dot * n.x;
                    py -= dot * n.y;
                    pz -= dot * n.z;
                }
            }

            // Record this push direction as a constraint normal
            const len = Math.sqrt(push.x * push.x + push.y * push.y + push.z * push.z);
            if (len > PENETRATION_EPSILON && numNormals < 3) {
                const invLen = 1.0 / len;
                const n = normals[numNormals];
                n.x = push.x * invLen;
                n.y = push.y * invLen;
                n.z = push.z * invLen;
                numNormals++;
            }

            resolvedX += px;
            resolvedY += py;
            resolvedZ += pz;
            totalPushX += px;
            totalPushY += py;
            totalPushZ += pz;
        }

        // Only report collision if the total push is meaningful
        const totalPushSq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
        const hasSignificantPush = hadCollision && totalPushSq > PENETRATION_EPSILON * PENETRATION_EPSILON;

        if (hasSignificantPush) {
            out.x = totalPushX;
            out.y = totalPushY;
            out.z = totalPushZ;
        }

        return hasSignificantPush;
    }

    /**
     * Find the single deepest penetrating voxel for the given sphere.
     * Writes the push-out vector into this._push.
     *
     * @param cx - Sphere center X.
     * @param cy - Sphere center Y.
     * @param cz - Sphere center Z.
     * @param radius - Sphere radius.
     * @returns True if a penetrating voxel was found.
     */
    private resolveDeepestPenetration(
        cx: number, cy: number, cz: number,
        radius: number
    ): boolean {
        const { voxelResolution, gridMinX, gridMinY, gridMinZ } = this;
        const radiusSq = radius * radius;

        // Compute bounding box of the sphere in voxel indices
        const ixMin = Math.floor((cx - radius - gridMinX) / voxelResolution);
        const iyMin = Math.floor((cy - radius - gridMinY) / voxelResolution);
        const izMin = Math.floor((cz - radius - gridMinZ) / voxelResolution);
        const ixMax = Math.floor((cx + radius - gridMinX) / voxelResolution);
        const iyMax = Math.floor((cy + radius - gridMinY) / voxelResolution);
        const izMax = Math.floor((cz + radius - gridMinZ) / voxelResolution);

        let bestPushX = 0;
        let bestPushY = 0;
        let bestPushZ = 0;
        let bestPenetration = PENETRATION_EPSILON;
        let found = false;

        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) {
                        continue;
                    }

                    // Compute the world-space AABB of this voxel
                    const vMinX = gridMinX + ix * voxelResolution;
                    const vMinY = gridMinY + iy * voxelResolution;
                    const vMinZ = gridMinZ + iz * voxelResolution;
                    const vMaxX = vMinX + voxelResolution;
                    const vMaxY = vMinY + voxelResolution;
                    const vMaxZ = vMinZ + voxelResolution;

                    // Find the nearest point on the voxel AABB to the sphere center
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(cy, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));

                    // Vector from nearest point to sphere center
                    const dx = cx - nearX;
                    const dy = cy - nearY;
                    const dz = cz - nearZ;
                    const distSq = dx * dx + dy * dy + dz * dz;

                    if (distSq >= radiusSq) {
                        continue;
                    }

                    let px: number;
                    let py: number;
                    let pz: number;
                    let penetration: number;

                    if (distSq > 1e-12) {
                        // Center is outside the voxel: push radially outward
                        const dist = Math.sqrt(distSq);
                        penetration = radius - dist;
                        const invDist = 1.0 / dist;
                        px = dx * invDist * penetration;
                        py = dy * invDist * penetration;
                        pz = dz * invDist * penetration;
                    } else {
                        // Center is inside the voxel: push to nearest face + radius
                        // so the sphere surface ends up flush with the face
                        const distNegX = cx - vMinX;
                        const distPosX = vMaxX - cx;
                        const distNegY = cy - vMinY;
                        const distPosY = vMaxY - cy;
                        const distNegZ = cz - vMinZ;
                        const distPosZ = vMaxZ - cz;

                        const escapeX = distNegX < distPosX ? -(distNegX + radius) : (distPosX + radius);
                        const escapeY = distNegY < distPosY ? -(distNegY + radius) : (distPosY + radius);
                        const escapeZ = distNegZ < distPosZ ? -(distNegZ + radius) : (distPosZ + radius);

                        const absX = Math.abs(escapeX);
                        const absY = Math.abs(escapeY);
                        const absZ = Math.abs(escapeZ);

                        px = 0;
                        py = 0;
                        pz = 0;
                        if (absX <= absY && absX <= absZ) {
                            px = escapeX;
                            penetration = absX;
                        } else if (absY <= absZ) {
                            py = escapeY;
                            penetration = absY;
                        } else {
                            pz = escapeZ;
                            penetration = absZ;
                        }
                    }

                    if (penetration > bestPenetration) {
                        bestPenetration = penetration;
                        bestPushX = px;
                        bestPushY = py;
                        bestPushZ = pz;
                        found = true;
                    }
                }
            }
        }

        if (found) {
            this._push.x = bestPushX;
            this._push.y = bestPushY;
            this._push.z = bestPushZ;
        }

        return found;
    }

    /**
     * Find the single deepest penetrating voxel for the given vertical capsule.
     * The capsule is a line segment from (cx, cy - halfHeight, cz) to (cx, cy + halfHeight, cz)
     * swept by radius. For each voxel, the closest point on the segment to the AABB is found,
     * then a sphere-AABB penetration test is performed from that point.
     * Writes the push-out vector into this._push.
     *
     * @param cx - Capsule center X.
     * @param cy - Capsule center Y.
     * @param cz - Capsule center Z.
     * @param halfHeight - Half-height of the capsule's inner line segment.
     * @param radius - Capsule radius.
     * @returns True if a penetrating voxel was found.
     */
    private resolveDeepestPenetrationCapsule(
        cx: number, cy: number, cz: number,
        halfHeight: number,
        radius: number
    ): boolean {
        const { voxelResolution, gridMinX, gridMinY, gridMinZ } = this;
        const radiusSq = radius * radius;

        const segBottomY = cy - halfHeight;
        const segTopY = cy + halfHeight;

        // Compute bounding box of the capsule in voxel indices
        const ixMin = Math.floor((cx - radius - gridMinX) / voxelResolution);
        const iyMin = Math.floor((segBottomY - radius - gridMinY) / voxelResolution);
        const izMin = Math.floor((cz - radius - gridMinZ) / voxelResolution);
        const ixMax = Math.floor((cx + radius - gridMinX) / voxelResolution);
        const iyMax = Math.floor((segTopY + radius - gridMinY) / voxelResolution);
        const izMax = Math.floor((cz + radius - gridMinZ) / voxelResolution);

        let bestPushX = 0;
        let bestPushY = 0;
        let bestPushZ = 0;
        let bestPenetration = PENETRATION_EPSILON;
        let found = false;

        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) {
                        continue;
                    }

                    // Compute the world-space AABB of this voxel
                    const vMinX = gridMinX + ix * voxelResolution;
                    const vMinY = gridMinY + iy * voxelResolution;
                    const vMinZ = gridMinZ + iz * voxelResolution;
                    const vMaxX = vMinX + voxelResolution;
                    const vMaxY = vMinY + voxelResolution;
                    const vMaxZ = vMinZ + voxelResolution;

                    // Find the closest Y on the capsule segment to this AABB.
                    // For a vertical segment, X and Z are fixed so we only optimize Y.
                    let segY: number;
                    if (segTopY < vMinY) {
                        // segment entirely below AABB
                        segY = segTopY;
                    } else if (segBottomY > vMaxY) {
                        // segment entirely above AABB
                        segY = segBottomY;
                    } else {
                        // ranges overlap - pick segment Y closest to AABB center
                        const aabbCenterY = (vMinY + vMaxY) * 0.5;
                        segY = Math.max(segBottomY, Math.min(segTopY, aabbCenterY));
                    }

                    // Now do sphere-AABB penetration from (cx, segY, cz)
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(segY, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));

                    // Vector from nearest point to sphere center on segment
                    const dx = cx - nearX;
                    const dy = segY - nearY;
                    const dz = cz - nearZ;
                    const distSq = dx * dx + dy * dy + dz * dz;

                    if (distSq >= radiusSq) {
                        continue;
                    }

                    let px: number;
                    let py: number;
                    let pz: number;
                    let penetration: number;

                    if (distSq > 1e-12) {
                        // Sphere center is outside the voxel: push radially outward
                        const dist = Math.sqrt(distSq);
                        penetration = radius - dist;
                        const invDist = 1.0 / dist;
                        px = dx * invDist * penetration;
                        py = dy * invDist * penetration;
                        pz = dz * invDist * penetration;
                    } else {
                        // Segment point is inside the voxel: push to nearest face + radius
                        // so the capsule surface ends up flush with the face
                        const distNegX = cx - vMinX;
                        const distPosX = vMaxX - cx;
                        const distNegY = segY - vMinY;
                        const distPosY = vMaxY - segY;
                        const distNegZ = cz - vMinZ;
                        const distPosZ = vMaxZ - cz;

                        const escapeX = distNegX < distPosX ? -(distNegX + radius) : (distPosX + radius);
                        const escapeY = distNegY < distPosY ? -(distNegY + radius) : (distPosY + radius);
                        const escapeZ = distNegZ < distPosZ ? -(distNegZ + radius) : (distPosZ + radius);

                        const absX = Math.abs(escapeX);
                        const absY = Math.abs(escapeY);
                        const absZ = Math.abs(escapeZ);

                        px = 0;
                        py = 0;
                        pz = 0;
                        if (absX <= absY && absX <= absZ) {
                            px = escapeX;
                            penetration = absX;
                        } else if (absY <= absZ) {
                            py = escapeY;
                            penetration = absY;
                        } else {
                            pz = escapeZ;
                            penetration = absZ;
                        }
                    }

                    if (penetration > bestPenetration) {
                        bestPenetration = penetration;
                        bestPushX = px;
                        bestPushY = py;
                        bestPushZ = pz;
                        found = true;
                    }
                }
            }
        }

        if (found) {
            this._push.x = bestPushX;
            this._push.y = bestPushY;
            this._push.z = bestPushZ;
        }

        return found;
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
        if (this.nodes.length === 0 ||
            ix < 0 || iy < 0 || iz < 0 ||
            ix >= this.numVoxelsX || iy >= this.numVoxelsY || iz >= this.numVoxelsZ) {
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

            // Check for solid leaf sentinel first (has nonzero high byte)
            if (node === SOLID_LEAF_MARKER) {
                return true;
            }

            const childMask = (node >>> 24) & 0xFF;

            // If childMask is 0, this is a mixed leaf node
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
        if (node === SOLID_LEAF_MARKER) {
            return true;
        }
        return this.checkLeafByIndex(node, ix, iy, iz);
    }

    /**
     * Check a mixed leaf node using voxel grid indices.
     * The solid leaf sentinel must be checked before calling this method.
     *
     * @param node - The mixed leaf node value (lower 24 bits = leafData index).
     * @param ix - Global voxel X index.
     * @param iy - Global voxel Y index.
     * @param iz - Global voxel Z index.
     * @returns True if the voxel is solid.
     */
    private checkLeafByIndex(node: number, ix: number, iy: number, iz: number): boolean {
        const leafDataIndex = node & 0x00FFFFFF;

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
}

export { VoxelCollider };
export type { PushOut };
