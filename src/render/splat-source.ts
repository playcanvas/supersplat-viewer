// How per-splat data reaches the projector. The renderer is the same for every source; only
// the wgsl that reads a splat and the way the projector is bound and dispatched differ, so the
// data paths in the plan (engine work buffer, direct sog reads, a light work buffer) can be
// swapped and profiled against each other.
import type { Compute, GraphicsDevice } from 'playcanvas';

import type { EngineManager, ResidentSet } from './resident-set';

type SplatSourceKind = 'workbuffer' | 'direct' | 'light';

/** One projector dispatch: a contiguous run of the chunk table. */
type DispatchGroup = {
    /** Index into the resident set's files for per-file bindings, or -1 for a single dispatch. */
    fileIndex: number;
    chunkBase: number;
    chunkCount: number;
};

type SplatSource = {
    readonly kind: SplatSourceKind;

    /**
     * Wgsl declaring this source's bindings from `bindingBase` upward and defining
     * `getCenter()` (world space; call first), `getOpacity()`, `getColor()`, `getRotation()`
     * (w, x, y, z) and `getScale()` for the splat set by `setSplat(index)`.
     */
    readChunk(bindingBase: number): string;

    /** The bind group entries matching {@link readChunk}, in binding order. */
    bindFormats(): unknown[];

    /** Called once per world-state version, before the frame's dispatch. */
    update(set: ResidentSet, manager: EngineManager): void;

    /** How the projector is dispatched this frame. */
    dispatchPlan(set: ResidentSet, numChunks: number): DispatchGroup[];

    /** Bind the source's textures and per-group constants on the projector compute. */
    bind(compute: Compute, group: DispatchGroup, set: ResidentSet): void;

    /** Width of the texel grid `setSplat` indexes into for this group's data. */
    textureSize(group: DispatchGroup): number;

    /** Bytes owned by this source, excluding the engine's resident sog textures. */
    gpuBytes(): number;

    /** A key that changes whenever {@link readChunk} would produce different code. */
    shaderKey(): string;

    destroy(): void;
};

type SplatSourceFactory = (device: GraphicsDevice) => SplatSource;

export type { DispatchGroup, SplatSource, SplatSourceFactory, SplatSourceKind };
