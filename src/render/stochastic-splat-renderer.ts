// The stochastic splat renderer (WebGPU, opt-in). The engine keeps LOD, streaming and the
// work-buffer copy; this owns everything after: per frame it culls nodes on the cpu, projects
// the resident splats in a compute pass into a dense cache, writes the indirect draw arguments,
// rasterises the survivors as opaque depth-tested quads into its own colour + depth target
// (StochasticSplats: keep a fragment with probability alpha, no sort), and composes that target
// over the camera's target from a fullscreen quad in the World layer that also writes depth.
//
// Frame flow: the compute runs inside the engine's gsplat update (the `frame:ready` hook, before
// the frame graph), the raster pass runs from `camera.beforePasses`, and the compose is an
// ordinary mesh instance in the camera's forward pass. See docs/stochastic-renderer.md.
import {
    ADDRESS_CLAMP_TO_EDGE,
    BindGroupFormat,
    BindStorageBufferFormat,
    BindStorageTextureFormat,
    BindTextureFormat,
    BindUniformBufferFormat,
    BLEND_NONE,
    BLEND_PREMULTIPLIED,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_DST_ALPHA,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BlendState,
    BoundingSphere,
    BUFFERUSAGE_COPY_DST,
    BUFFERUSAGE_COPY_SRC,
    Camera,
    Color,
    Compute,
    CULLFACE_NONE,
    FILTER_LINEAR,
    Frustum,
    GraphNode,
    Mat4,
    Mesh,
    MeshInstance,
    FILTER_NEAREST,
    FUNC_ALWAYS,
    FUNC_LESSEQUAL,
    FUNC_NEVER,
    PIXELFORMAT_DEPTH,
    PIXELFORMAT_DEPTH16,
    PIXELFORMAT_DEPTHSTENCIL,
    PIXELFORMAT_R32F,
    PIXELFORMAT_R32U,
    PIXELFORMAT_RGBA16U,
    PIXELFORMAT_RGBA8,
    PRIMITIVE_TRIANGLES,
    PROJECTION_ORTHOGRAPHIC,
    RenderPass,
    RenderTarget,
    SAMPLETYPE_DEPTH,
    SEMANTIC_POSITION,
    Shader,
    SHADER_FORWARD,
    SHADERLANGUAGE_WGSL,
    SHADERSTAGE_COMPUTE,
    ShaderMaterial,
    StorageBuffer,
    Texture,
    TEXTUREDIMENSION_2D,
    UniformBufferFormat,
    UniformFormat,
    UNIFORMTYPE_FLOAT,
    UNIFORMTYPE_MAT4,
    UNIFORMTYPE_UINT,
    UNIFORMTYPE_VEC2,
    UNIFORMTYPE_VEC4,
    Vec2
} from 'playcanvas';
import type { AppBase, CameraComponent, GraphicsDevice, Layer } from 'playcanvas';

import { captureCameraSnapshot, createPickCameraSnapshot } from '../picker';
import type { PickCameraSnapshot } from '../picker';

import { EngineResidentSetProvider } from './resident-set';
import type { EngineManager, ResidentSet } from './resident-set';
import { argsWGSL, setArgsWGSL } from './shaders/args';
import { composeFragmentWGSL, composeVertexWGSL } from './shaders/compose';
import { interleaveFragmentWGSL } from './shaders/interleave';
import { occluderFragmentWGSL, occluderVertexWGSL } from './shaders/occluder';
import { orderScanWGSL, orderScatterSetsWGSL, orderScatterWGSL } from './shaders/order';
import { CACHE_WORDS, CHUNK_SIZE, ORDER_BUCKETS, SPLAT_POLYGON_SIDES, projectorWGSL } from './shaders/projector';
import type { CoverageMode } from './shaders/projector';
import { FAR_CLIP_Z, QUADS_PER_INSTANCE, rasterFragmentWGSL, rasterVertexWGSL } from './shaders/raster';
import { reduceL1WGSL, reduceL2WGSL } from './shaders/reduce';
import {
    buildSampleTables,
    sampleArgsWGSL,
    sampleBatchesWGSL,
    sampleResolveFragmentWGSL,
    sampleResolveVertexWGSL,
    sampleSplatsWGSL
} from './shaders/samples';
import { TAA_MAX_COUNT, taaFragmentWGSL, taaHistoryWGSL, taaVertexWGSL } from './shaders/taa';
import { TILE_SIZE, binCountWGSL, binFillWGSL, tileBlendWGSL, tileScanWGSL } from './shaders/tiles';
import type { DispatchGroup, SplatSource, SplatSourceKind } from './splat-source';
import { DirectSplatSource } from './splat-source-direct';
import { WorkBufferSplatSource } from './splat-source-workbuffer';

/** Experiment switches, all flippable at runtime; `?variant=key:value,key:value` seeds them. */
type Variant = {
    /** Coverage thresholds: plain 1 spp, or stratified over 2x2 pixel quads with a quad-mean compose. */
    spp: '1' | 'quad';
    /** `none` skips the compose, to bound its cost; `depth` shows the splat depth as grey. */
    compose: 'blend' | 'none' | 'depth';
    /**
     * Previous-frame occlusion cull: off, the 8 px grid only, both grid levels, or `auto`: both
     * levels, suspended for a while whenever a frame culled less than 8 % of its splats, since the
     * test then costs more than the raster it saves (large scenes seen from outside).
     */
    cull: 'off' | 'l1' | 'l2' | 'auto';
    /**
     * Draw order: `bucket` (the default), 256 log-spaced depth buckets front to back so early-z
     * rejects most of what the depth test would, or the projector's `append` order.
     */
    order: 'append' | 'bucket';
    /**
     * Contribution cull while the camera moves: splats whose alpha mass in pixels (opacity times
     * projected area) falls below this are skipped on moving frames, and a settled frame at the
     * scene's own threshold follows when the camera stops. 0 leaves the scene threshold alone.
     */
    contribution: number;
    /** Popless depth: every fragment gets the depth of the Gaussian's peak along its ray (paper 3.4). */
    popless: 'on' | 'off';
    /** Quad extent: shrunk by opacity to where alpha falls below the clip (the engine's clipCorner), or the full 2 sqrt(2) sigma. */
    quadClip: 'opacity' | 'off';
    /**
     * Where the coverage threshold varies: per pixel (a discarding fragment shader over the
     * whole quad), or per splat and frame, which makes the kept pixels a solid ellipse drawn as
     * a polygon with no discard (shaders/projector.ts); `interleaved` gives each of the four
     * pixels of a 2x2 quad its own threshold per splat, stratified, drawn as four interleaved
     * pixel sets and copied back (shaders/interleave.ts). All keep each pixel with probability
     * alpha.
     */
    coverage: CoverageMode;
    /**
     * How the splats reach the target: the stochastic raster, or `compute`, a tile renderer that
     * blends every pixel's splats front to back (shaders/tiles.ts), the image the raster
     * converges to, with no noise and no accumulation; `sample`, the stochastic frame itself made in
     * compute, each splat scattering only the pixels it keeps (shaders/samples.ts).
     */
    pipeline: 'raster' | 'compute' | 'sample';
    /**
     * Bench diagnostic for the raster's cost, by subtraction: `none` draws nothing (the pass only
     * clears), `empty` runs the vertex shader but collapses every quad to its centre (no
     * fragments), `discard` discards every fragment (vertex and rasterisation cost), `opaque`
     * keeps every fragment above the alpha clip (no stochastic test, so early depth rejection is
     * not held back by discards), `testonly` keeps the depth test without writing depth and
     * `nodepth` drops both (wrong images; they bound what the late depth update costs), `nohash`
     * swaps the coverage hash for a multiply-free threshold (bounds what the hash costs), `never`
     * fails every depth test (with a discarding shader, a gpu may test late and shade every
     * fragment anyway), `solid` has no discard at all, every quad an opaque square (what early
     * depth rejection does for a shader that never discards), `solidnever` fails every depth
     * test with that shader (the early rejection floor), `nevernowrite` fails every test with the
     * discarding shader and no depth writes (whether discard alone moves the test late), and
     * `mask` makes the stochastic test a sample mask on the single sample instead of a discard,
     * `solidtest` is `solid` without depth writes, and `nodiscard` makes it zero coverage under an
     * under blend with no depth writes, the first kept fragment in draw order claiming the pixel,
     * and `blend` blends the falloff premultiplied over with no discard or depth write, as the sorted
     * renderer does per fragment. With coverage:interleaved, `none` skips the pixel sets' passes
     * too, and `nocopy` skips only the copy back into the full target.
     */
    raster:
        | 'full'
        | 'none'
        | 'empty'
        | 'discard'
        | 'opaque'
        | 'testonly'
        | 'nodepth'
        | 'nohash'
        | 'never'
        | 'solid'
        | 'solidnever'
        | 'nevernowrite'
        | 'mask'
        | 'solidtest'
        | 'nodiscard'
        | 'blend'
        | 'nocopy';
    /** Alpha below which splats, quad extents and fragments are dropped; 0 keeps the scene's. */
    alphaClip: number;
    /**
     * Timing experiment, the image is not composed from it: rasterise into a half-resolution
     * target with 1 sample (`half1`), or with 4 samples and a coverage mask per invocation
     * (`half4`, needs a hash other than full; its depth is stored and resolved), or the same
     * with the multisampled depth left in tile memory, neither stored nor resolved (`half4t`),
     * instead of the full-resolution target.
     */
    msaa: 'off' | 'half1' | 'half4' | 'half4t';
    /** Timing experiment, the image is not composed from it: the raster's depth format. */
    depth: 'd32' | 'd24s8' | 'd16';
    /**
     * Timing experiment, wrong images: `load` starts the raster from the previous frame's depth
     * instead of clearing it, what drawing against dense depth that is already there would cost;
     * `solid` first draws the same quads as discard-free depth-only squares, whether depth a
     * discard-free draw updates early lets the gpu reject the stochastic draw's quads coarsely.
     */
    prefill: 'off' | 'load' | 'solid' | 'core';
    /** prefill:core: the alpha each splat's depth-only core covers (its inscribed square). */
    coreAlpha: number;
    /**
     * The occluder grid (shaders/occluder.ts): the occlusion grid's 8 px blocks, as depth-only
     * quads at the farthest depth the previous frame's nearest samples had, drawn first in the
     * raster pass without a discard, so the gpu can reject the splats' quads behind them before
     * rasterising them finely. Runs on frames the occlusion cull runs (it reduces that grid).
     */
    occluder: 'off' | 'on';
    /**
     * Coverage threshold: `full` mixes pixel and splat per fragment (5 integer multiplies);
     * the others hash the splat's seed once per vertex, then `split` mixes it with the pixel
     * through the full hash (2 multiplies), `lite` through one multiply, and `ign` (the
     * default) rotates interleaved gradient noise by it, with no integer multiplies, which
     * mobile gpus run at a fraction of the float rate.
     */
    hash: 'full' | 'split' | 'lite' | 'ign';
    /** The quad coordinates interpolated in half precision where the device has f16. */
    uvHalf: 'on' | 'off';
    /** Gaussian falloff: the exp form, or a polynomial within 0.0096 of it. */
    falloff: 'exp' | 'poly';
    /** Test the threshold against the opacity, which bounds alpha, before evaluating the falloff. */
    earlyReject: 'on' | 'off';
    /** Temporal accumulation of the stochastic samples (shaders/taa.ts). */
    taa: 'on' | 'off';
    /**
     * Sample cap of the accumulation at rest: the history weight never drops below 1 / taaMax.
     * At most TAA_MAX_COUNT, the most the history's count field holds.
     */
    taaMax: number;
    /** Sample cap while the camera moves, so the history keeps up with the view. */
    taaMoveMax: number;
    /** Colour clamp while moving, in neighbourhood standard deviations (0 disables it). */
    taaClip: number;
    /** Spacing in pixels of the colour clamp's 3x3 neighbourhood taps while moving. */
    taaSpread: number;
    /** History filter while moving: bilinear or Catmull-Rom. */
    taaFilter: 'linear' | 'cubic';
    /** Depth the moving reprojection goes through: this frame's sample or the pixel's accumulated mean. */
    taaReproj: 'sample' | 'history';
    /** Image motion in pixels a frame that halves the moving sample cap (0: fixed cap). */
    taaMotion: number;
    /** 1 shows the accumulation state (count, acceptance, sample) instead of the colour. */
    taaDebug: number;
    /** Overrides the row-order sign of the reprojection (-1 or 1); 0 derives it from the target. */
    taaFlip: number;
    /** Per-channel colour ceiling in the projected cache: 8 (the cache's range) or 1 (the engine's 8-bit cache clamps there). */
    colorMax: number;
    /** Covariance units: true pixels, or the engine's doubled-focal convention (its dilation and culls scale with it). */
    units: 'px' | 'engine';
};

const defaultVariant = (): Variant => ({
    spp: 'quad',
    compose: 'blend',
    cull: 'auto',
    order: 'bucket',
    contribution: 0,
    popless: 'on',
    quadClip: 'opacity',
    coverage: 'pixel',
    pipeline: 'raster',
    raster: 'full',
    alphaClip: 0,
    msaa: 'off',
    depth: 'd32',
    prefill: 'off',
    coreAlpha: 0.5,
    occluder: 'off',
    hash: 'ign',
    uvHalf: 'off',
    falloff: 'exp',
    earlyReject: 'off',
    taa: 'on',
    taaMax: 256,
    taaMoveMax: 16,
    taaClip: 1.25,
    taaSpread: 1,
    taaFilter: 'cubic',
    taaReproj: 'sample',
    taaMotion: 4,
    taaDebug: 0,
    taaFlip: 0,
    colorMax: 8,
    units: 'engine'
});

const taaCount = (value: number) => Math.min(TAA_MAX_COUNT, Math.max(1, Math.round(value)));

const parseVariant = (text: string | undefined): Variant => {
    const variant = defaultVariant();
    for (const part of (text ?? '').split(',')) {
        const [key, value] = part.split(':').map((s) => s.trim());
        if (!key || value === undefined) continue;
        if (key === 'spp' && (value === '1' || value === 'quad')) variant.spp = value;
        if (key === 'compose' && (value === 'blend' || value === 'none' || value === 'depth')) variant.compose = value;
        if (key === 'popless' && (value === 'on' || value === 'off')) variant.popless = value;
        if (key === 'quadClip' && (value === 'opacity' || value === 'off')) variant.quadClip = value;
        if (key === 'coverage' && (value === 'pixel' || value === 'splat' || value === 'interleaved'))
            variant.coverage = value;
        if (key === 'pipeline' && (value === 'raster' || value === 'compute' || value === 'sample'))
            variant.pipeline = value;
        if (
            key === 'raster' &&
            [
                'full',
                'none',
                'empty',
                'discard',
                'opaque',
                'testonly',
                'nodepth',
                'nohash',
                'never',
                'solid',
                'solidnever',
                'nevernowrite',
                'mask',
                'solidtest',
                'nodiscard',
                'blend',
                'nocopy'
            ].includes(value)
        ) {
            variant.raster = value as Variant['raster'];
        }
        if (key === 'alphaClip' && Number.isFinite(Number(value))) variant.alphaClip = Math.max(0, Number(value));
        if (key === 'msaa' && ['off', 'half1', 'half4', 'half4t'].includes(value))
            variant.msaa = value as Variant['msaa'];
        if (key === 'depth' && (value === 'd32' || value === 'd24s8' || value === 'd16')) variant.depth = value;
        if (key === 'prefill' && (value === 'off' || value === 'load' || value === 'solid' || value === 'core'))
            variant.prefill = value;
        if (key === 'coreAlpha' && Number.isFinite(Number(value)))
            variant.coreAlpha = Math.min(1, Math.max(0.01, Number(value)));
        if (key === 'occluder' && (value === 'off' || value === 'on')) variant.occluder = value;
        if (key === 'hash' && ['full', 'split', 'lite', 'ign'].includes(value)) variant.hash = value as Variant['hash'];
        if (key === 'uvHalf' && (value === 'on' || value === 'off')) variant.uvHalf = value;
        if (key === 'falloff' && (value === 'exp' || value === 'poly')) variant.falloff = value;
        if (key === 'earlyReject' && (value === 'on' || value === 'off')) variant.earlyReject = value;
        if (key === 'taa' && (value === 'on' || value === 'off')) variant.taa = value;
        if (key === 'taaMax' && Number.isFinite(Number(value))) variant.taaMax = taaCount(Number(value));
        if (key === 'taaMoveMax' && Number.isFinite(Number(value))) variant.taaMoveMax = taaCount(Number(value));
        if (key === 'taaDebug' && Number.isFinite(Number(value))) variant.taaDebug = Number(value);
        if (key === 'taaClip' && Number.isFinite(Number(value))) variant.taaClip = Math.max(0, Number(value));
        if (key === 'taaSpread' && Number.isFinite(Number(value)))
            variant.taaSpread = Math.max(1, Math.round(Number(value)));
        if (key === 'taaFilter' && (value === 'linear' || value === 'cubic')) variant.taaFilter = value;
        if (key === 'taaReproj' && (value === 'sample' || value === 'history')) variant.taaReproj = value;
        if (key === 'taaMotion' && Number.isFinite(Number(value))) variant.taaMotion = Math.max(0, Number(value));
        if (key === 'taaFlip' && Number.isFinite(Number(value))) variant.taaFlip = Number(value);
        if (key === 'colorMax' && Number.isFinite(Number(value))) variant.colorMax = Math.max(0, Number(value));
        if (key === 'units' && (value === 'px' || value === 'engine')) variant.units = value;
        if (key === 'cull' && (value === 'off' || value === 'l1' || value === 'l2' || value === 'auto')) {
            variant.cull = value;
        }
        if (key === 'order' && (value === 'append' || value === 'bucket')) variant.order = value;
        if (key === 'contribution' && Number.isFinite(Number(value))) variant.contribution = Math.max(0, Number(value));
    }
    return variant;
};

type StochasticRendererOptions = {
    source?: SplatSourceKind;
    variant?: string;
};

// the engine internals this file drives directly
type EngineDevice = GraphicsDevice & {
    computeDispatch(computes: Compute[], name: string): void;
    getIndirectDrawSlot(count?: number): number;
    indirectDrawBuffer: StorageBuffer;
    getIndirectDispatchSlot(count?: number): number;
    indirectDispatchBuffer: StorageBuffer;
};

type EngineForwardRenderer = {
    renderForwardLayer(
        camera: Camera,
        renderTarget: RenderTarget | null,
        layer: Layer | null,
        transparent: boolean | undefined,
        shaderPass: number,
        options: { meshInstances: MeshInstance[] }
    ): void;
};

// Renders an explicit mesh-instance list into the renderer's own target (the raster and the
// taa resolve). Not a layer: a layer in camera.layers is culled once and drawn by every pass
// for the camera, so the scene pass would draw the splats into the camera target as well.
class SplatRasterPass extends RenderPass {
    constructor(
        device: GraphicsDevice,
        private forward: EngineForwardRenderer,
        private camera: CameraComponent,
        public instances: MeshInstance[],
        name = 'sse-splat-raster'
    ) {
        super(device);
        this.name = name;
    }

    /** Draw nothing; the pass still clears its target (variant raster:none). */
    skip = false;

    execute() {
        if (this.skip) return;
        this.forward.renderForwardLayer(this.camera.camera, this.renderTarget, null, undefined, SHADER_FORWARD, {
            meshInstances: this.instances
        });
    }
}

/** The on-screen frame the renderer's depth texture holds: what a pick reads. */
type DepthFrame = {
    /** Changes with every frame drawn to the on-screen target. */
    id: number;
    /** The camera it was drawn with; unprojects its depths whatever the live camera does. */
    camera: PickCameraSnapshot;
    width: number;
    height: number;
    /**
     * clip z = a * viewDepth + b (over w = viewDepth for a perspective camera), for the depth
     * texture's values: the renderer's own mapping, whose far plane is at infinity.
     */
    clipZ: [number, number];
};

const createQuadMesh = (device: GraphicsDevice, quads: number) => {
    const positions = new Float32Array(quads * 4 * 3);
    const indices = new Uint32Array(quads * 6);
    for (let i = 0; i < quads; ++i) {
        // z carries the quad's index within the instance
        positions.set([-1, -1, i, 1, -1, i, 1, 1, i, -1, 1, i], i * 12);
        const v = i * 4;
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const mesh = new Mesh(device);
    mesh.setPositions(positions, 3);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
};

// variant coverage:splat: a polygon per splat on the unit circle, fanned from its first vertex
const createPolygonMesh = (device: GraphicsDevice, polygons: number, sides: number) => {
    const positions = new Float32Array(polygons * sides * 3);
    const indices = new Uint32Array(polygons * (sides - 2) * 3);
    for (let i = 0; i < polygons; ++i) {
        for (let s = 0; s < sides; ++s) {
            const angle = (2 * Math.PI * s) / sides;
            // z carries the polygon's index within the instance
            positions.set([Math.cos(angle), Math.sin(angle), i], (i * sides + s) * 3);
        }
        const v = i * sides;
        for (let s = 1; s < sides - 1; ++s) {
            indices.set([v, v + s, v + s + 1], (i * (sides - 2) + s - 1) * 3);
        }
    }
    const mesh = new Mesh(device);
    mesh.setPositions(positions, 3);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
};

const createFullscreenMesh = (device: GraphicsDevice) => {
    const mesh = new Mesh(device);
    mesh.setPositions(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2);
    mesh.setIndices(new Uint16Array([0, 1, 2, 0, 2, 3]));
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
};

const tmpVec2 = new Vec2();

class StochasticSplatRenderer {
    readonly variant: Variant;

    readonly source: SplatSource;

    private app: AppBase;

    private device: EngineDevice;

    private camera: CameraComponent;

    private worldLayer: Layer;

    private provider: EngineResidentSetProvider;

    private unsubscribe: () => void;

    private enabled = true;

    // the resident set and its chunk table
    private set: ResidentSet | null = null;

    private numChunks = 0;

    private chunkData = new Uint32Array(0);

    private chunkBuffer: StorageBuffer | null = null;

    private nodeVisibleData = new Uint32Array(0);

    private nodeVisibleBuffer: StorageBuffer | null = null;

    private cacheBuffer: StorageBuffer | null = null;

    private cacheSlots = 0;

    private counter: StorageBuffer;

    // compute
    // one projector shader per source and occlusion / order specialisation: the test's code
    // costs a little even when a uniform disables it, so a disabled or suspended cull runs
    // without it. One compute per shader and dispatch group, since a compute owns the uniform
    // buffer its dispatch reads and per-file sources dispatch once per file
    private projectorShaders = new Map<string, Shader>();

    private projectorComputes = new Map<string, Compute>();

    private projectorBindGroupFormat: BindGroupFormat | null = null;

    private projectorSourceKey = '';

    private args: Compute;

    private argsBindGroupFormat: BindGroupFormat;

    // order:bucket: bucket counts then offsets, the ordered slot list, and its two passes
    private orderBuckets: StorageBuffer;

    private orderedBuffer: StorageBuffer | null = null;

    private orderScan: Compute;

    private orderScatter: Compute;

    private orderFormats: BindGroupFormat[] = [];

    // the occlusion grid: farthest depth per 8 px block (level 1) and per 32 px block (level 2)
    private occL1: StorageBuffer;

    private occL2: StorageBuffer;

    private occBlocks = { x1: 0, y1: 0, x2: 0, y2: 0 };

    private reduceL1: Compute;

    private reduceL2: Compute;

    private reduceFormats: BindGroupFormat[] = [];

    // the previous frame the grid and the reprojection describe; valid only when that frame
    // rendered to the same target at the same size from the same world state
    private prevValid = false;

    private prevViewProjection = new Mat4();

    private prevView = new Mat4();

    private prevProjection = new Mat4();

    private prevClipZ = [0, 0, 0, 0];

    private prevViewport = [0, 0];

    private prevFocal = [0, 0];

    private prevFlip = 1;

    private prevWidth = 0;

    private prevHeight = 0;

    private prevVersion = -1;

    // the allocations resident when the previous frame drew, and whether any of them has gone
    // since: only a removed splat can make the previous depth wrong (it may have hidden what is
    // now behind it), so arrivals leave the cull on while a scene streams in
    private residentAllocIds = new Set<number>();

    private nodesRemoved = false;

    private prevOrtho = false;

    /** Whether the last frame ran the occlusion cull, for the debug panel and the harness. */
    culling = false;

    /** Whether cull:auto currently has the test switched off for culling too little. */
    get cullSuspended() {
        return this.variant.cull === 'auto' && (!this.cullActive || this.cullSuspendedFrames > 0);
    }

    // cull:auto bookkeeping. The last decision holds while a readback is in flight: while the
    // test is active every culled frame's counts are read back and a poor one suspends it;
    // while suspended the frames count down, then one probe frame runs the test and the rest
    // wait for its counts
    private cullActive = true;

    private cullSuspendedFrames = 0;

    private cullStatsPending = false;

    /** Frames the test stays off after culling too little (cull:auto). */
    /**
     * Whether the projected cache for `splats` resident splats fits one storage binding on this
     * device. The cache reserves 25% over the resident count; adapters differ in the limit
     * (128 MiB is the WebGPU default), so a viewer checks before opting in.
     */
    static cacheFits(device: GraphicsDevice, splats: number) {
        const limit = (device as { wgpu?: { limits?: { maxStorageBufferBindingSize?: number } } }).wgpu?.limits
            ?.maxStorageBufferBindingSize;
        return !limit || Math.ceil(splats * 1.25) * CACHE_WORDS * 4 <= limit;
    }

    static CULL_SUSPEND_FRAMES = 60;

    /** The culled fraction below which cull:auto suspends the test. */
    static CULL_MIN_FRACTION = 0.08;

    /**
     * Let a capture (query) frame cull against the previous on-screen frame when it renders at
     * the same size. Off by default: a query frame is not culled, since its cull thins what a
     * pick or a thumbnail should see. The harness turns it on to photograph culled frames.
     */
    allowQueryCull = false;

    // raster
    private colorTexture: Texture;

    private depthTexture: Texture;

    private target: RenderTarget;

    // variants msaa and depth: the targets the raster times itself into, per scale, sample count and depth format
    private altTargets = new Map<string, { target: RenderTarget; textures: Texture[] }>();

    private rasterMesh: Mesh;

    // variant coverage:splat
    private polygonMesh: Mesh;

    // variant coverage:interleaved: each pixel set's target, raster pass and draw, the pass that
    // copies them back into the full target, and the passes that order and size each set's draw.
    // (One target with a quadrant and viewport per set, in one pass, measured 1 ms slower on the
    // Pixel 7 Pro: the passes are not what the sets cost.)
    private setTextures: Texture[] = [];

    private setTargets: RenderTarget[] = [];

    private setPasses: SplatRasterPass[] = [];

    private setInstances: MeshInstance[] = [];

    private setRanges: StorageBuffer;

    private setArgs: Compute;

    private orderScatterSets: Compute;

    private interleaveMaterial: ShaderMaterial;

    private interleaveInstance: MeshInstance;

    // entries the ordered list holds: a survivor takes one, or one per pixel set it keeps
    private orderedCapacity = 0;

    // variant pipeline:compute (shaders/tiles.ts): built on first use
    private tilePipeline: {
        binCount: Compute;
        binFill: Compute;
        scan: Compute;
        blend: Compute;
        formats: BindGroupFormat[];
    } | null = null;

    private tiles = { x: 0, y: 0 };

    private tileCounts: StorageBuffer | null = null;

    private tileOffsets: StorageBuffer | null = null;

    private tileEntries: StorageBuffer | null = null;

    private tileEntryCapacity = 0;

    private tileRecordsA: StorageBuffer | null = null;

    private tileRecordsB: StorageBuffer | null = null;

    private tileRecordSlots = 0;

    private tileEntryTotal: StorageBuffer | null = null;

    private tileTotalPending = false;

    private tileColor: Texture | null = null;

    private tileInfo: Texture | null = null;

    // variant pipeline:sample (shaders/samples.ts): built on first use
    private samplePipeline: {
        splats: Compute;
        batches: Compute;
        args: Compute;
        formats: BindGroupFormat[];
        resolveMaterial: ShaderMaterial;
        resolveInstance: MeshInstance;
    } | null = null;

    private samplePixels: StorageBuffer | null = null;

    private samplePixelCount = 0;

    private sampleTotals: StorageBuffer | null = null;

    private sampleRadii: StorageBuffer | null = null;

    private sampleTableClip = -1;

    private sampleBatches: StorageBuffer | null = null;

    private sampleBatchCount: StorageBuffer | null = null;

    private static SAMPLE_BATCH_CAPACITY = 1 << 20;

    private rasterMaterial: ShaderMaterial;

    private rasterInstance: MeshInstance;

    // variant prefill:solid: the raster's quads as discard-free depth-only squares, drawn first
    private solidMaterial: ShaderMaterial;

    private solidInstance: MeshInstance;

    // variant occluder:on: the occluder grid (shaders/occluder.ts), drawn first in the raster pass
    private occluderMaterial: ShaderMaterial;

    private occluderInstance: MeshInstance;

    private prevInvView = new Mat4();

    private rasterPass: SplatRasterPass;

    // taa: ping-pong history (premultiplied colour + coverage as unorm16, and the depth mean and
    // sample count packed in 32 bits; shaders/taa.ts), resolved by a fullscreen pass after the
    // raster. Sized with the target on the first accumulating frame, and shrunk back while taa is off
    private taaColor: Texture[] = [];

    private taaInfo: Texture[] = [];

    private taaTargets: RenderTarget[] = [];

    private taaWrite = 0;

    private taaMesh: Mesh;

    private taaMaterial: ShaderMaterial;

    private taaInstance: MeshInstance;

    private taaPass: SplatRasterPass;

    // whether the history holds the previous on-screen frame at the current size
    private taaHistoryValid = false;

    // the previous taa frame's matrices as the pass reads them, and this frame's, copied over
    // at the start of the next frame: the material holds the data arrays by reference and
    // uploads them when it draws, after this hook has run
    private taaPrevViewProjection = new Mat4();

    private taaPrevView = new Mat4();

    private taaLastViewProjection = new Mat4();

    private taaLastView = new Mat4();

    private taaWidth = 0;

    private taaHeight = 0;

    // the camera's world transform, for the accumulation's reprojection
    private cameraWorld = new Mat4();

    // frames since the camera or the scene last changed, for converging at rest
    private restFrames = 0;

    /** The frame the depth texture holds, null while it holds a capture's or nothing. */
    depthFrame: DepthFrame | null = null;

    private depthFrameCount = 0;

    private depthFrameCamera = createPickCameraSnapshot();

    // a frame requested from inside the render: the engine clears app.renderNextFrame right
    // after render(), so the request is applied on frameend instead
    private frameWanted = false;

    private onFrameEnd = () => {
        if (this.frameWanted) {
            this.frameWanted = false;
            this.app.renderNextFrame = true;
        }
    };

    private frameIndex = 0;

    // the seed the harness sets; the frame index replaces it while taa accumulates
    private userSeed = 0;

    /** Whether the last frame ran the temporal accumulation, for the debug panel. */
    taaActive = false;

    /**
     * Let a capture (query) frame at the on-screen size run the accumulation over the on-screen
     * history, so the harness can photograph converged and moving frames. Off by default.
     */
    allowQueryTaa = false;

    // compose
    private composeMesh: Mesh;

    private composeMaterial: ShaderMaterial;

    private composeInstance: MeshInstance;

    private frustum = new Frustum();

    private sphere = new BoundingSphere();

    private shaderProjection = new Mat4();

    private viewProjection = new Mat4();

    private frameSeed = 0;

    private ready = false;

    /** Byte sizes of the buffers this renderer owns, for the bench harness and the debug panel. */
    /** The renderer's depth texture: the nearest surviving sample per pixel of `depthFrame`. */
    get frameDepthTexture() {
        return this.depthTexture;
    }

    get gpuBytes() {
        const buffers = [
            this.chunkBuffer,
            this.nodeVisibleBuffer,
            this.cacheBuffer,
            this.orderedBuffer,
            this.counter,
            this.orderBuckets,
            this.occL1,
            this.occL2
        ];
        let bytes = 0;
        for (const buffer of buffers) bytes += buffer?.byteSize ?? 0;
        bytes += this.colorTexture.gpuSize + this.depthTexture.gpuSize;
        for (const texture of [...this.taaColor, ...this.taaInfo]) bytes += texture.gpuSize;
        return bytes + this.source.gpuBytes();
    }

    /**
     * The seed mixed into every coverage hash. 0 makes a still camera reproduce its frame;
     * the harness varies it to measure the sampling noise floor, and TAA will animate it.
     */
    get seed() {
        return this.frameSeed;
    }

    set seed(value: number) {
        this.userSeed = value >>> 0;
        this.frameSeed = this.userSeed;
        this.app.renderNextFrame = true;
    }

    /** The last projected frame's survivor count and occlusion-culled count, read back from the gpu. */
    async readStats(): Promise<{ survivors: number; occluded: number }> {
        // without a typed array the engine hands back bytes
        const data = new Uint32Array(2);
        await this.counter.read(0, 8, data, true);
        return { survivors: data[0], occluded: data[1] };
    }

    // variants msaa and depth: point the raster at the full-resolution target, or at one of the
    // timing experiments' targets (another scale, sample count or depth format)
    private selectRasterTarget(width: number, height: number) {
        const { msaa, depth } = this.variant;
        let target = this.target;
        if (msaa !== 'off' || depth !== 'd32') {
            const scale = msaa === 'off' ? 1 : 2;
            const samples = msaa === 'off' || msaa === 'half1' ? 1 : 4;
            // the engine renders a 4x target into its own multisampled depth and resolves it with
            // a shader, which writes a colour format
            const depthFormat =
                samples > 1
                    ? PIXELFORMAT_R32F
                    : depth === 'd24s8'
                      ? PIXELFORMAT_DEPTHSTENCIL
                      : depth === 'd16'
                        ? PIXELFORMAT_DEPTH16
                        : PIXELFORMAT_DEPTH;
            const key = `${scale}:${samples}:${depthFormat}`;
            let alt = this.altTargets.get(key);
            if (!alt) {
                const textures = [
                    new Texture(this.device, {
                        name: `sse-splat-alt-${key}-color`,
                        width: 4,
                        height: 4,
                        format: PIXELFORMAT_RGBA8,
                        mipmaps: false
                    }),
                    new Texture(this.device, {
                        name: `sse-splat-alt-${key}-depth`,
                        width: 4,
                        height: 4,
                        format: depthFormat,
                        mipmaps: false
                    })
                ];
                alt = {
                    target: new RenderTarget({
                        name: `sse-splat-alt-${key}`,
                        colorBuffer: textures[0],
                        depthBuffer: textures[1],
                        samples
                    }),
                    textures
                };
                this.altTargets.set(key, alt);
            }
            const w = Math.ceil(width / scale);
            const h = Math.ceil(height / scale);
            if (alt.target.width !== w || alt.target.height !== h) alt.target.resize(w, h);
            target = alt.target;
        }
        if (this.rasterPass.renderTarget !== target) {
            this.rasterPass.init(target);
            this.rasterPass.setClearColor(new Color(0, 0, 0, 0));
        }
        // variant prefill: load the previous frame's depth rather than clearing it
        this.rasterPass.setClearDepth(this.variant.prefill === 'load' ? undefined : 1);
        // a 4x target's depth is stored and resolved into its depth texture, as a composed
        // version reading depth from it would need; half4t leaves it in tile memory instead
        if (target.samples > 1) {
            const keep = msaa === 'half4';
            this.rasterPass.depthStencilOps.storeDepth = keep;
            this.rasterPass.depthStencilOps.resolveDepth = keep;
        }
    }

    // the occlusion grid's two levels at this size
    private ensureOccGrid(width: number, height: number) {
        const x1 = Math.ceil(width / 8);
        const y1 = Math.ceil(height / 8);
        const x2 = Math.ceil(x1 / 4);
        const y2 = Math.ceil(y1 / 4);
        if (this.occBlocks.x1 !== x1 || this.occBlocks.y1 !== y1) {
            this.occL1.destroy();
            this.occL2.destroy();
            this.occL1 = new StorageBuffer(this.device, x1 * y1 * 4, BUFFERUSAGE_COPY_DST);
            this.occL2 = new StorageBuffer(this.device, x2 * y2 * 4, BUFFERUSAGE_COPY_DST);
            this.occBlocks = { x1, y1, x2, y2 };
        }
    }

    // level 2 from level 1
    private reduceLevel2() {
        const { x1, y1, x2, y2 } = this.occBlocks;
        const l2 = this.reduceL2;
        l2.setParameter('level1', this.occL1);
        l2.setParameter('level2', this.occL2);
        l2.setParameter('blocksX1', x1);
        l2.setParameter('blocksY1', y1);
        l2.setParameter('blocksX2', x2);
        l2.setParameter('blocksY2', y2);
        Compute.calcDispatchSize(Math.ceil((x2 * y2) / 64), tmpVec2);
        l2.setupDispatch(tmpVec2.x, tmpVec2.y, 1);
        this.device.computeDispatch([l2], 'sse-splat-reduce2');
    }

    // reduce the previous frame's depth into the two grid levels
    private reduceDepth(width: number, height: number) {
        const { device } = this;
        this.ensureOccGrid(width, height);
        const { x1, y1 } = this.occBlocks;
        const l1 = this.reduceL1;
        l1.setParameter('prevDepth', this.depthTexture);
        l1.setParameter('blockMax', this.occL1);
        l1.setParameter('width', width);
        l1.setParameter('height', height);
        l1.setParameter('blocksX', x1);
        l1.setParameter('blocksY', y1);
        l1.setupDispatch(x1, y1, 1);
        device.computeDispatch([l1], 'sse-splat-reduce1');
        this.reduceLevel2();
    }

    // Variant pipeline:compute: the binning, scan and blend passes, built on first use
    private ensureTilePipeline() {
        if (this.tilePipeline) return this.tilePipeline;
        const { device } = this;
        const binFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('cache', SHADERSTAGE_COMPUTE, true),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('tileCounts', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('orderedSlots', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('recordsA', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('recordsB', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('entries', SHADERSTAGE_COMPUTE)
        ]);
        const binUniforms = () =>
            new UniformBufferFormat(device, [
                new UniformFormat('viewportW', UNIFORMTYPE_FLOAT),
                new UniformFormat('viewportH', UNIFORMTYPE_FLOAT),
                new UniformFormat('tilesX', UNIFORMTYPE_UINT),
                new UniformFormat('tilesY', UNIFORMTYPE_UINT),
                new UniformFormat('focalX', UNIFORMTYPE_FLOAT),
                new UniformFormat('focalY', UNIFORMTYPE_FLOAT),
                new UniformFormat('flip', UNIFORMTYPE_FLOAT),
                new UniformFormat('alphaClip', UNIFORMTYPE_FLOAT),
                new UniformFormat('isOrtho', UNIFORMTYPE_UINT),
                new UniformFormat('entryCapacity', UNIFORMTYPE_UINT),
                new UniformFormat('pad0', UNIFORMTYPE_UINT),
                new UniformFormat('pad1', UNIFORMTYPE_UINT)
            ]);
        const bin = (name: string, cshader: string) =>
            new Compute(
                device,
                new Shader(device, {
                    name,
                    shaderLanguage: SHADERLANGUAGE_WGSL,
                    cshader,
                    computeUniformBufferFormats: { uniforms: binUniforms() },
                    computeBindGroupFormat: binFormat
                }),
                name
            );
        const scanFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('tileCounts', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('tileOffsets', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('entryTotal', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        const blendFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('tileCounts', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('tileOffsets', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('entries', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('recordsA', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('recordsB', SHADERSTAGE_COMPUTE, true),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE),
            new BindStorageTextureFormat('outColor', PIXELFORMAT_RGBA16U, TEXTUREDIMENSION_2D),
            new BindStorageTextureFormat('outInfo', PIXELFORMAT_R32U, TEXTUREDIMENSION_2D),
            new BindStorageBufferFormat('occL1', SHADERSTAGE_COMPUTE)
        ]);
        this.tilePipeline = {
            binCount: bin('sse-tiles-bin-count', binCountWGSL),
            binFill: bin('sse-tiles-bin-fill', binFillWGSL),
            scan: new Compute(
                device,
                new Shader(device, {
                    name: 'sse-tiles-scan',
                    shaderLanguage: SHADERLANGUAGE_WGSL,
                    cshader: tileScanWGSL,
                    computeUniformBufferFormats: {
                        uniforms: new UniformBufferFormat(device, [new UniformFormat('tileCount', UNIFORMTYPE_UINT)])
                    },
                    computeBindGroupFormat: scanFormat
                }),
                'sse-tiles-scan'
            ),
            blend: new Compute(
                device,
                new Shader(device, {
                    name: 'sse-tiles-blend',
                    shaderLanguage: SHADERLANGUAGE_WGSL,
                    cshader: tileBlendWGSL(taaHistoryWGSL),
                    computeUniformBufferFormats: {
                        uniforms: new UniformBufferFormat(device, [
                            new UniformFormat('viewportW', UNIFORMTYPE_UINT),
                            new UniformFormat('viewportH', UNIFORMTYPE_UINT),
                            new UniformFormat('tilesX', UNIFORMTYPE_UINT),
                            new UniformFormat('blocksX1', UNIFORMTYPE_UINT),
                            new UniformFormat('blocksY1', UNIFORMTYPE_UINT),
                            new UniformFormat('entryCapacity', UNIFORMTYPE_UINT),
                            new UniformFormat('isOrtho', UNIFORMTYPE_UINT),
                            new UniformFormat('alphaClip', UNIFORMTYPE_FLOAT),
                            new UniformFormat('clipA', UNIFORMTYPE_FLOAT),
                            new UniformFormat('clipB', UNIFORMTYPE_FLOAT)
                        ])
                    },
                    computeBindGroupFormat: blendFormat
                }),
                'sse-tiles-blend'
            ),
            formats: [binFormat, scanFormat, blendFormat]
        };
        this.tileEntryTotal = new StorageBuffer(device, 16, BUFFERUSAGE_COPY_SRC);
        return this.tilePipeline;
    }

    // Variant pipeline:sample: the scatter passes and the resolve, built on first use
    private ensureSamplePipeline() {
        if (this.samplePipeline) return this.samplePipeline;
        const { device } = this;
        const format = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('cache', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('orderedSlots', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('totals', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('radii', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('pixels', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('batches', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('batchCount', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        const scatter = (name: string, cshader: string) =>
            new Compute(
                device,
                new Shader(device, {
                    name,
                    shaderLanguage: SHADERLANGUAGE_WGSL,
                    cshader,
                    computeUniformBufferFormats: {
                        uniforms: new UniformBufferFormat(device, [
                            new UniformFormat('viewportW', UNIFORMTYPE_FLOAT),
                            new UniformFormat('viewportH', UNIFORMTYPE_FLOAT),
                            new UniformFormat('focalX', UNIFORMTYPE_FLOAT),
                            new UniformFormat('focalY', UNIFORMTYPE_FLOAT),
                            new UniformFormat('flip', UNIFORMTYPE_FLOAT),
                            new UniformFormat('isOrtho', UNIFORMTYPE_UINT),
                            new UniformFormat('frameSeed', UNIFORMTYPE_UINT),
                            new UniformFormat('batchCapacity', UNIFORMTYPE_UINT)
                        ])
                    },
                    computeBindGroupFormat: format
                }),
                name
            );
        const argsFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('batchCount', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('indirectDispatchArgs', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        const resolveMaterial = new ShaderMaterial({
            uniqueName: 'sse-samples-resolve',
            vertexWGSL: sampleResolveVertexWGSL,
            fragmentWGSL: sampleResolveFragmentWGSL(FAR_CLIP_Z),
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        resolveMaterial.blendType = BLEND_NONE;
        resolveMaterial.depthWrite = true;
        resolveMaterial.depthTest = true;
        resolveMaterial.depthFunc = FUNC_ALWAYS;
        resolveMaterial.cull = CULLFACE_NONE;
        const resolveInstance = new MeshInstance(
            createFullscreenMesh(device),
            resolveMaterial,
            new GraphNode('sse-samples-resolve')
        );
        resolveInstance.cull = false;
        resolveInstance.castShadow = false;
        resolveInstance.receiveShadow = false;
        this.samplePipeline = {
            splats: scatter('sse-samples-splats', sampleSplatsWGSL),
            batches: scatter('sse-samples-batches', sampleBatchesWGSL),
            args: new Compute(
                device,
                new Shader(device, {
                    name: 'sse-samples-args',
                    shaderLanguage: SHADERLANGUAGE_WGSL,
                    cshader: sampleArgsWGSL,
                    computeUniformBufferFormats: {
                        uniforms: new UniformBufferFormat(device, [
                            new UniformFormat('dispatchSlot', UNIFORMTYPE_UINT),
                            new UniformFormat('batchCapacity', UNIFORMTYPE_UINT)
                        ])
                    },
                    computeBindGroupFormat: argsFormat
                }),
                'sse-samples-args'
            ),
            formats: [format, argsFormat],
            resolveMaterial,
            resolveInstance
        };
        this.sampleBatches = new StorageBuffer(device, StochasticSplatRenderer.SAMPLE_BATCH_CAPACITY * 16);
        this.sampleBatchCount = new StorageBuffer(device, 16, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);
        return this.samplePipeline;
    }

    // Variant pipeline:sample: every survivor scatters the pixels it keeps into the key buffer,
    // front to back, and the raster pass resolves the keys into the target (shaders/samples.ts)
    private dispatchSamples(
        width: number,
        height: number,
        dispatchSlot: number,
        alphaClip: number,
        clipZ: number[],
        isOrtho: boolean,
        focal: number[]
    ) {
        const { device } = this;
        const pipeline = this.ensureSamplePipeline();
        if (this.samplePixelCount !== width * height) {
            this.samplePixels?.destroy();
            this.samplePixelCount = width * height;
            this.samplePixels = new StorageBuffer(
                device,
                width * height * 4,
                BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC
            );
        }
        if (this.sampleTableClip !== alphaClip) {
            const { totals, radii } = buildSampleTables(alphaClip);
            this.sampleTotals?.destroy();
            this.sampleRadii?.destroy();
            this.sampleTotals = new StorageBuffer(device, totals.byteLength, BUFFERUSAGE_COPY_DST);
            this.sampleRadii = new StorageBuffer(device, radii.byteLength, BUFFERUSAGE_COPY_DST);
            this.sampleTotals.write(0, totals, 0, totals.length);
            this.sampleRadii.write(0, radii, 0, radii.length);
            this.sampleTableClip = alphaClip;
        }
        this.samplePixels!.clear();
        this.sampleBatchCount!.clear();
        const capacity = StochasticSplatRenderer.SAMPLE_BATCH_CAPACITY;
        for (const compute of [pipeline.splats, pipeline.batches]) {
            compute.setParameter('counter', this.counter);
            compute.setParameter('cache', this.cacheBuffer!);
            compute.setParameter('orderedSlots', this.orderedBuffer!);
            compute.setParameter('totals', this.sampleTotals!);
            compute.setParameter('radii', this.sampleRadii!);
            compute.setParameter('pixels', this.samplePixels!);
            compute.setParameter('batches', this.sampleBatches!);
            compute.setParameter('batchCount', this.sampleBatchCount!);
            compute.setParameter('viewportW', width);
            compute.setParameter('viewportH', height);
            compute.setParameter('focalX', focal[0]);
            compute.setParameter('focalY', focal[1]);
            compute.setParameter('flip', this.target.flipY ? -1 : 1);
            compute.setParameter('isOrtho', isOrtho ? 1 : 0);
            compute.setParameter('frameSeed', this.frameSeed);
            compute.setParameter('batchCapacity', capacity);
        }
        pipeline.splats.setupIndirectDispatch(dispatchSlot);
        const batchSlot = device.getIndirectDispatchSlot(1);
        const args = pipeline.args;
        args.setParameter('batchCount', this.sampleBatchCount!);
        args.setParameter('indirectDispatchArgs', device.indirectDispatchBuffer);
        args.setParameter('dispatchSlot', batchSlot);
        args.setParameter('batchCapacity', capacity);
        args.setupDispatch(1, 1, 1);
        pipeline.batches.setupIndirectDispatch(batchSlot);
        device.computeDispatch([pipeline.splats], 'sse-samples-splats');
        device.computeDispatch([args], 'sse-samples-args');
        device.computeDispatch([pipeline.batches], 'sse-samples-batches');
        const resolve = pipeline.resolveMaterial;
        resolve.setParameter('pixels', this.samplePixels!);
        resolve.setParameter('resolveParams', [width, isOrtho ? 1 : 0, clipZ[0], clipZ[1]]);
    }

    // the tile renderer's per-size and per-cache buffers, and its output
    private ensureTileResources(width: number, height: number) {
        const { device } = this;
        const tx = Math.ceil(width / TILE_SIZE);
        const ty = Math.ceil(height / TILE_SIZE);
        if (this.tiles.x !== tx || this.tiles.y !== ty) {
            this.tileCounts?.destroy();
            this.tileOffsets?.destroy();
            // readable for the bench's tile statistics
            this.tileCounts = new StorageBuffer(device, tx * ty * 4, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);
            this.tileOffsets = new StorageBuffer(device, tx * ty * 4, BUFFERUSAGE_COPY_SRC);
            this.tiles = { x: tx, y: ty };
        }
        if (this.tileRecordSlots < this.cacheSlots) {
            this.tileRecordsA?.destroy();
            this.tileRecordsB?.destroy();
            this.tileRecordSlots = this.cacheSlots;
            this.tileRecordsA = new StorageBuffer(device, this.cacheSlots * 16);
            this.tileRecordsB = new StorageBuffer(device, this.cacheSlots * 16);
        }
        if (!this.tileEntries) {
            // grown from the entry total the gpu reports (see dispatchTiles)
            this.tileEntryCapacity = 2 * 1024 * 1024;
            this.tileEntries = new StorageBuffer(device, this.tileEntryCapacity * 16, BUFFERUSAGE_COPY_SRC);
        }
        if (!this.tileColor || this.tileColor.width !== width || this.tileColor.height !== height) {
            this.tileColor?.destroy();
            this.tileInfo?.destroy();
            const options = {
                width,
                height,
                mipmaps: false,
                storage: true,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            };
            this.tileColor = new Texture(device, { ...options, name: 'sse-tiles-color', format: PIXELFORMAT_RGBA16U });
            this.tileInfo = new Texture(device, { ...options, name: 'sse-tiles-info', format: PIXELFORMAT_R32U });
        }
    }

    // Variant pipeline:compute: bin the survivors into tiles, sort and blend each tile, and leave
    // the occlusion grid for the next frame (shaders/tiles.ts)
    private dispatchTiles(
        width: number,
        height: number,
        dispatchSlot: number,
        alphaClip: number,
        clipZ: number[],
        isOrtho: boolean,
        focal: number[]
    ) {
        const { device } = this;
        const pipeline = this.ensureTilePipeline();
        this.ensureTileResources(width, height);
        this.ensureOccGrid(width, height);
        const tileCount = this.tiles.x * this.tiles.y;
        this.tileCounts!.clear();

        for (const bin of [pipeline.binCount, pipeline.binFill]) {
            bin.setParameter('counter', this.counter);
            bin.setParameter('cache', this.cacheBuffer!);
            bin.setParameter('tileCounts', this.tileCounts!);
            bin.setParameter('orderedSlots', this.orderedBuffer!);
            bin.setParameter('recordsA', this.tileRecordsA!);
            bin.setParameter('recordsB', this.tileRecordsB!);
            bin.setParameter('entries', this.tileEntries!);
            bin.setParameter('viewportW', width);
            bin.setParameter('viewportH', height);
            bin.setParameter('tilesX', this.tiles.x);
            bin.setParameter('tilesY', this.tiles.y);
            bin.setParameter('focalX', focal[0]);
            bin.setParameter('focalY', focal[1]);
            bin.setParameter('flip', this.target.flipY ? -1 : 1);
            bin.setParameter('alphaClip', alphaClip);
            bin.setParameter('isOrtho', isOrtho ? 1 : 0);
            bin.setParameter('entryCapacity', this.tileEntryCapacity);
            bin.setParameter('pad0', 0);
            bin.setParameter('pad1', 0);
            bin.setupIndirectDispatch(dispatchSlot);
        }
        const scan = pipeline.scan;
        scan.setParameter('tileCounts', this.tileCounts!);
        scan.setParameter('tileOffsets', this.tileOffsets!);
        scan.setParameter('entryTotal', this.tileEntryTotal!);
        scan.setParameter('tileCount', tileCount);
        scan.setupDispatch(1, 1, 1);
        const blend = pipeline.blend;
        blend.setParameter('tileCounts', this.tileCounts!);
        blend.setParameter('tileOffsets', this.tileOffsets!);
        blend.setParameter('entries', this.tileEntries!);
        blend.setParameter('recordsA', this.tileRecordsA!);
        blend.setParameter('recordsB', this.tileRecordsB!);
        blend.setParameter('outColor', this.tileColor!);
        blend.setParameter('outInfo', this.tileInfo!);
        blend.setParameter('occL1', this.occL1);
        blend.setParameter('viewportW', width);
        blend.setParameter('viewportH', height);
        blend.setParameter('tilesX', this.tiles.x);
        blend.setParameter('blocksX1', this.occBlocks.x1);
        blend.setParameter('blocksY1', this.occBlocks.y1);
        blend.setParameter('entryCapacity', this.tileEntryCapacity);
        blend.setParameter('isOrtho', isOrtho ? 1 : 0);
        blend.setParameter('alphaClip', alphaClip);
        blend.setParameter('clipA', clipZ[0]);
        blend.setParameter('clipB', clipZ[1]);
        blend.setupDispatch(this.tiles.x, this.tiles.y, 1);

        device.computeDispatch([pipeline.binCount], 'sse-tiles-bin-count');
        device.computeDispatch([scan], 'sse-tiles-scan');
        device.computeDispatch([pipeline.binFill], 'sse-tiles-bin-fill');
        device.computeDispatch([blend], 'sse-tiles-blend');
        // the next frame's occlusion cull reads both levels
        this.reduceLevel2();

        // the entry list grows when a frame needed more than it holds (off the frame, a frame or
        // two late; until then the tiles past the end draw short)
        if (!this.tileTotalPending) {
            this.tileTotalPending = true;
            const data = new Uint32Array(1);
            this.tileEntryTotal!.read(0, 4, data, false)
                .then(() => {
                    if (data[0] > this.tileEntryCapacity * 0.9) {
                        this.tileEntries?.destroy();
                        this.tileEntryCapacity = Math.ceil(data[0] * 1.5);
                        this.tileEntries = new StorageBuffer(
                            this.device,
                            this.tileEntryCapacity * 16,
                            BUFFERUSAGE_COPY_SRC
                        );
                    }
                })
                .catch(() => {
                    // a lost device or a destroyed buffer; the next frame reads again
                })
                .finally(() => {
                    this.tileTotalPending = false;
                });
        }
    }

    /** Survivors of the last frame's projection are only known to the gpu; this is the resident count. */
    activeSplats = 0;

    constructor(app: AppBase, camera: CameraComponent, worldLayer: Layer, options: StochasticRendererOptions = {}) {
        this.app = app;
        this.device = app.graphicsDevice as EngineDevice;
        this.camera = camera;
        this.worldLayer = worldLayer;
        this.variant = parseVariant(options.variant);

        const { device } = this;

        if (options.source === 'direct') {
            this.source = new DirectSplatSource(device);
        } else {
            if (options.source && options.source !== 'workbuffer') {
                console.warn(
                    `StochasticSplatRenderer: splat source '${options.source}' is not implemented yet, using the work buffer`
                );
            }
            this.source = new WorkBufferSplatSource();
        }

        this.counter = new StorageBuffer(device, 16, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);

        // indirect draw arguments
        this.argsBindGroupFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('indirectDrawArgs', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('indirectDispatchArgs', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        this.args = new Compute(
            device,
            new Shader(device, {
                name: 'sse-splat-args',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: argsWGSL,
                computeUniformBufferFormats: {
                    uniforms: new UniformBufferFormat(device, [
                        new UniformFormat('drawSlot', UNIFORMTYPE_UINT),
                        new UniformFormat('indexCount', UNIFORMTYPE_UINT),
                        new UniformFormat('quadsPerInstance', UNIFORMTYPE_UINT),
                        new UniformFormat('dispatchSlot', UNIFORMTYPE_UINT),
                        new UniformFormat('scatterWorkgroupSize', UNIFORMTYPE_UINT)
                    ])
                },
                computeBindGroupFormat: this.argsBindGroupFormat
            }),
            'sse-splat-args'
        );

        // the ordering passes
        this.orderBuckets = new StorageBuffer(device, 2 * ORDER_BUCKETS * 4, BUFFERUSAGE_COPY_DST);
        const scanFormat = new BindGroupFormat(device, [new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE)]);
        const scatterFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('cache', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('ordered', SHADERSTAGE_COMPUTE)
        ]);
        this.orderFormats = [scanFormat, scatterFormat];
        this.orderScan = new Compute(
            device,
            new Shader(device, {
                name: 'sse-splat-order-scan',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: orderScanWGSL,
                computeBindGroupFormat: scanFormat
            }),
            'sse-splat-order-scan'
        );
        this.orderScatter = new Compute(
            device,
            new Shader(device, {
                name: 'sse-splat-order-scatter',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: orderScatterWGSL,
                computeBindGroupFormat: scatterFormat
            }),
            'sse-splat-order-scatter'
        );
        this.orderScatterSets = new Compute(
            device,
            new Shader(device, {
                name: 'sse-splat-order-scatter-sets',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: orderScatterSetsWGSL,
                computeBindGroupFormat: scatterFormat
            }),
            'sse-splat-order-scatter'
        );
        this.setRanges = new StorageBuffer(device, 4 * 8);
        const setArgsFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('indirectDrawArgs', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('setRanges', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        this.orderFormats.push(setArgsFormat);
        this.setArgs = new Compute(
            device,
            new Shader(device, {
                name: 'sse-splat-set-args',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: setArgsWGSL,
                computeUniformBufferFormats: {
                    uniforms: new UniformBufferFormat(device, [
                        new UniformFormat('drawSlot', UNIFORMTYPE_UINT),
                        new UniformFormat('indexCount', UNIFORMTYPE_UINT),
                        new UniformFormat('quadsPerInstance', UNIFORMTYPE_UINT)
                    ])
                },
                computeBindGroupFormat: setArgsFormat
            }),
            'sse-splat-set-args'
        );

        // the occlusion grid and its two reduce passes
        this.occL1 = new StorageBuffer(device, 4, BUFFERUSAGE_COPY_DST);
        this.occL2 = new StorageBuffer(device, 4, BUFFERUSAGE_COPY_DST);
        const reduceL1Format = new BindGroupFormat(device, [
            new BindTextureFormat('prevDepth', SHADERSTAGE_COMPUTE, TEXTUREDIMENSION_2D, SAMPLETYPE_DEPTH, false),
            new BindStorageBufferFormat('blockMax', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        const reduceL2Format = new BindGroupFormat(device, [
            new BindStorageBufferFormat('level1', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('level2', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        this.reduceFormats = [reduceL1Format, reduceL2Format];
        this.reduceL1 = new Compute(
            device,
            new Shader(device, {
                name: 'sse-splat-reduce1',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: reduceL1WGSL,
                computeUniformBufferFormats: {
                    uniforms: new UniformBufferFormat(device, [
                        new UniformFormat('width', UNIFORMTYPE_UINT),
                        new UniformFormat('height', UNIFORMTYPE_UINT),
                        new UniformFormat('blocksX', UNIFORMTYPE_UINT),
                        new UniformFormat('blocksY', UNIFORMTYPE_UINT)
                    ])
                },
                computeBindGroupFormat: reduceL1Format
            }),
            'sse-splat-reduce1'
        );
        this.reduceL2 = new Compute(
            device,
            new Shader(device, {
                name: 'sse-splat-reduce2',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: reduceL2WGSL,
                computeUniformBufferFormats: {
                    uniforms: new UniformBufferFormat(device, [
                        new UniformFormat('blocksX1', UNIFORMTYPE_UINT),
                        new UniformFormat('blocksY1', UNIFORMTYPE_UINT),
                        new UniformFormat('blocksX2', UNIFORMTYPE_UINT),
                        new UniformFormat('blocksY2', UNIFORMTYPE_UINT)
                    ])
                },
                computeBindGroupFormat: reduceL2Format
            }),
            'sse-splat-reduce2'
        );

        // the raster target: colour, and a depth texture the compose, the occlusion cull and
        // (later) the picker read
        this.colorTexture = new Texture(device, {
            name: 'sse-splat-color',
            width: 4,
            height: 4,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.depthTexture = new Texture(device, {
            name: 'sse-splat-depth',
            width: 4,
            height: 4,
            format: PIXELFORMAT_DEPTH,
            mipmaps: false,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.target = new RenderTarget({
            name: 'sse-splat-target',
            colorBuffer: this.colorTexture,
            depthBuffer: this.depthTexture,
            samples: 1
        });

        this.rasterMesh = createQuadMesh(device, QUADS_PER_INSTANCE);
        this.polygonMesh = createPolygonMesh(device, QUADS_PER_INSTANCE, SPLAT_POLYGON_SIDES);
        this.rasterMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-raster',
            vertexWGSL: rasterVertexWGSL,
            fragmentWGSL: rasterFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.rasterMaterial.blendType = BLEND_NONE;
        this.rasterMaterial.depthWrite = true;
        this.rasterMaterial.depthTest = true;
        this.rasterMaterial.cull = CULLFACE_NONE;
        // the forward renderer reads the instance's node for its cull setup and world transform
        this.rasterInstance = new MeshInstance(this.rasterMesh, this.rasterMaterial, new GraphNode('sse-splat-raster'));
        this.rasterInstance.cull = false;
        this.rasterInstance.castShadow = false;
        this.rasterInstance.receiveShadow = false;
        this.solidMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-raster-solid',
            vertexWGSL: rasterVertexWGSL,
            fragmentWGSL: rasterFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        // depth only: no colour channel written
        this.solidMaterial.blendState = new BlendState(
            false,
            BLENDEQUATION_ADD,
            BLENDMODE_ONE,
            BLENDMODE_ONE,
            BLENDEQUATION_ADD,
            BLENDMODE_ONE,
            BLENDMODE_ONE,
            false,
            false,
            false,
            false
        );
        this.solidMaterial.depthWrite = true;
        this.solidMaterial.depthTest = true;
        this.solidMaterial.cull = CULLFACE_NONE;
        this.solidInstance = new MeshInstance(
            this.rasterMesh,
            this.solidMaterial,
            new GraphNode('sse-splat-raster-solid')
        );
        this.solidInstance.cull = false;
        this.solidInstance.castShadow = false;
        this.solidInstance.receiveShadow = false;
        this.occluderMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-occluder',
            vertexWGSL: occluderVertexWGSL,
            fragmentWGSL: occluderFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.occluderMaterial.blendState = this.solidMaterial.blendState;
        this.occluderMaterial.depthWrite = true;
        this.occluderMaterial.depthTest = true;
        this.occluderMaterial.cull = CULLFACE_NONE;
        this.occluderInstance = new MeshInstance(
            this.rasterMesh,
            this.occluderMaterial,
            new GraphNode('sse-splat-occluder')
        );
        this.occluderInstance.setInstancing(true);
        this.occluderInstance.cull = false;
        this.occluderInstance.castShadow = false;
        this.occluderInstance.receiveShadow = false;

        this.rasterPass = new SplatRasterPass(device, app.renderer as unknown as EngineForwardRenderer, camera, [
            this.rasterInstance
        ]);
        this.rasterPass.init(this.target);
        this.rasterPass.setClearColor(new Color(0, 0, 0, 0));
        this.rasterPass.setClearDepth(1);
        // nothing to draw, and no buffers bound, until the first populated frame
        this.rasterPass.enabled = false;

        // variant coverage:interleaved: a target, pass and draw per pixel set, sized per frame
        for (let i = 0; i < 4; i++) {
            const color = new Texture(device, {
                name: `sse-splat-set-${i}-color`,
                width: 4,
                height: 4,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            const depth = new Texture(device, {
                name: `sse-splat-set-${i}-depth`,
                width: 4,
                height: 4,
                format: PIXELFORMAT_DEPTH,
                mipmaps: false,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            this.setTextures.push(color, depth);
            const target = new RenderTarget({
                name: `sse-splat-set-${i}`,
                colorBuffer: color,
                depthBuffer: depth,
                samples: 1
            });
            this.setTargets.push(target);
            const instance = new MeshInstance(
                this.polygonMesh,
                this.rasterMaterial,
                new GraphNode(`sse-splat-set-${i}`)
            );
            instance.cull = false;
            instance.castShadow = false;
            instance.receiveShadow = false;
            instance.setParameter('setIndex', i);
            this.setInstances.push(instance);
            const pass = new SplatRasterPass(
                device,
                app.renderer as unknown as EngineForwardRenderer,
                camera,
                [instance],
                `sse-splat-raster-set-${i}`
            );
            pass.init(target);
            pass.setClearColor(new Color(0, 0, 0, 0));
            pass.setClearDepth(1);
            pass.enabled = false;
            this.setPasses.push(pass);
        }
        // the copy back: drawn by the raster pass in place of the splats, every texel written
        this.interleaveMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-interleave',
            vertexWGSL: taaVertexWGSL,
            fragmentWGSL: interleaveFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.interleaveMaterial.blendType = BLEND_NONE;
        this.interleaveMaterial.depthWrite = true;
        this.interleaveMaterial.depthTest = true;
        this.interleaveMaterial.depthFunc = FUNC_ALWAYS;
        this.interleaveMaterial.cull = CULLFACE_NONE;
        for (let i = 0; i < 4; i++) {
            this.interleaveMaterial.setParameter(`setColor${i}`, this.setTextures[i * 2]);
            this.interleaveMaterial.setParameter(`setDepth${i}`, this.setTextures[i * 2 + 1]);
        }
        this.interleaveInstance = new MeshInstance(
            createFullscreenMesh(device),
            this.interleaveMaterial,
            new GraphNode('sse-splat-interleave')
        );
        this.interleaveInstance.cull = false;
        this.interleaveInstance.castShadow = false;
        this.interleaveInstance.receiveShadow = false;

        // the taa resolve: a fullscreen pass from the raster target and the previous history
        // into the other history, sized with the target on its first frame
        for (let i = 0; i < 2; i++) {
            this.taaColor.push(
                new Texture(device, {
                    name: `sse-splat-taa-color-${i}`,
                    width: 4,
                    height: 4,
                    format: PIXELFORMAT_RGBA16U,
                    mipmaps: false,
                    minFilter: FILTER_NEAREST,
                    magFilter: FILTER_NEAREST,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                })
            );
            this.taaInfo.push(
                new Texture(device, {
                    name: `sse-splat-taa-info-${i}`,
                    width: 4,
                    height: 4,
                    format: PIXELFORMAT_R32U,
                    mipmaps: false,
                    minFilter: FILTER_NEAREST,
                    magFilter: FILTER_NEAREST,
                    addressU: ADDRESS_CLAMP_TO_EDGE,
                    addressV: ADDRESS_CLAMP_TO_EDGE
                })
            );
            this.taaTargets.push(
                new RenderTarget({
                    name: `sse-splat-taa-${i}`,
                    colorBuffers: [this.taaColor[i], this.taaInfo[i]],
                    depth: false,
                    samples: 1
                })
            );
        }
        this.taaMesh = createFullscreenMesh(device);
        this.taaMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-taa',
            vertexWGSL: taaVertexWGSL,
            fragmentWGSL: taaFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION },
            fragmentOutputTypes: ['uvec4', 'uint']
        });
        this.taaMaterial.blendType = BLEND_NONE;
        this.taaMaterial.depthWrite = false;
        this.taaMaterial.depthTest = false;
        this.taaMaterial.cull = CULLFACE_NONE;
        this.taaInstance = new MeshInstance(this.taaMesh, this.taaMaterial, new GraphNode('sse-splat-taa'));
        this.taaInstance.cull = false;
        this.taaInstance.castShadow = false;
        this.taaInstance.receiveShadow = false;
        this.taaPass = new SplatRasterPass(
            device,
            app.renderer as unknown as EngineForwardRenderer,
            camera,
            [this.taaInstance],
            'sse-splat-taa'
        );
        this.taaPass.init(this.taaTargets[0]);
        this.taaPass.enabled = false;

        // the compose quad, blended over the skybox and opaque meshes with the splat depth
        this.composeMesh = createFullscreenMesh(device);
        this.composeMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-compose',
            vertexWGSL: composeVertexWGSL,
            fragmentWGSL: composeFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.composeMaterial.blendType = BLEND_PREMULTIPLIED;
        this.composeMaterial.depthWrite = true;
        this.composeMaterial.depthTest = true;
        this.composeMaterial.cull = CULLFACE_NONE;
        this.composeMaterial.setParameter('splatColor', this.colorTexture);
        this.composeMaterial.setParameter('splatDepth', this.depthTexture);
        // always bound, even while taa is off: a declared texture without a value makes the
        // engine create and upload a placeholder inside the forward pass, which submits the
        // command buffer mid-pass on WebGPU
        this.composeMaterial.setParameter('taaColor', this.taaColor[0]);
        this.composeMaterial.setParameter('taaInfo', this.taaInfo[0]);
        this.composeInstance = new MeshInstance(
            this.composeMesh,
            this.composeMaterial,
            new GraphNode('sse-splat-compose')
        );
        this.composeInstance.cull = false;
        this.composeInstance.castShadow = false;
        this.composeInstance.receiveShadow = false;
        // the picker pass draws every pickable instance of the layer into a target without a
        // depth attachment; this shader writes frag_depth, which makes that pipeline invalid
        // and drops the whole submit, the frame's command buffer included
        this.composeInstance.pick = false;
        // first among the transparents, whichever way the layer sorts them
        this.composeInstance.drawOrder = -1000;
        this.composeInstance.calculateSortDistance = () => Number.MAX_VALUE;

        this.applyVariant();

        this.provider = new EngineResidentSetProvider(app, camera, worldLayer);
        this.unsubscribe = this.provider.onFrame((set, changed, manager) => this.frame(set, changed, manager));
        app.on('frameend', this.onFrameEnd);

        this.attach();
    }

    /** Switch the renderer off and hand the splats back to the engine's renderer (XR), or on again. */
    setEnabled(value: boolean) {
        if (this.enabled === value) return;
        this.enabled = value;
        if (value) {
            this.attach();
        } else {
            this.detach();
        }
        this.app.renderNextFrame = true;
    }

    /** Replace the experiment switches from a `key:value,key:value` string (unset keys reset). */
    setVariant(text: string) {
        Object.assign(this.variant, parseVariant(text));
        // the cull decides afresh under new switches
        this.cullActive = true;
        this.cullSuspendedFrames = 0;
        this.applyVariant();
    }

    /**
     * Drop the temporal history; the next frame starts accumulating from its own sample. The
     * coverage seeds restart too, so a variant accumulates the same samples every time (the
     * harness compares builds image for image).
     */
    resetHistory() {
        this.taaHistoryValid = false;
        this.restFrames = 0;
        this.frameIndex = 0;
    }

    /** Re-read {@link variant} after a field changed. */
    applyVariant() {
        // a switch changes what the frames hold; an old history would leak into the new ones
        this.resetHistory();
        const quad = this.variant.spp === 'quad';
        this.rasterMaterial.setDefine('SSE_SPP_QUAD', quad ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_ORDERED', this.variant.order === 'bucket' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_POPLESS', this.variant.popless === 'on' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_QUAD_CLIP', this.variant.quadClip === 'opacity' ? '' : undefined);
        const splatCoverage = this.variant.coverage !== 'pixel';
        this.rasterMaterial.setDefine('SSE_COVERAGE_SPLAT', splatCoverage ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_INTERLEAVED', this.variant.coverage === 'interleaved' ? '' : undefined);
        this.rasterInstance.mesh = splatCoverage ? this.polygonMesh : this.rasterMesh;
        this.rasterMaterial.setDefine('SSE_RASTER_EMPTY', this.variant.raster === 'empty' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_RASTER_DISCARD', this.variant.raster === 'discard' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_RASTER_OPAQUE', this.variant.raster === 'opaque' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_RASTER_NOHASH', this.variant.raster === 'nohash' ? '' : undefined);
        const { raster } = this.variant;
        this.rasterMaterial.setDefine(
            'SSE_RASTER_SOLID',
            raster === 'solid' || raster === 'solidnever' || raster === 'solidtest' ? '' : undefined
        );
        this.rasterMaterial.setDefine('SSE_RASTER_MASK', raster === 'mask' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_RASTER_NODISCARD', raster === 'nodiscard' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_RASTER_BLEND', raster === 'blend' ? '' : undefined);
        // nodiscard: the first kept fragment in draw order claims the pixel (premultiplied under);
        // blend: premultiplied over, as the sorted renderer blends
        this.rasterMaterial.blendState =
            raster === 'nodiscard'
                ? new BlendState(
                      true,
                      BLENDEQUATION_ADD,
                      BLENDMODE_ONE_MINUS_DST_ALPHA,
                      BLENDMODE_ONE,
                      BLENDEQUATION_ADD,
                      BLENDMODE_ONE_MINUS_DST_ALPHA,
                      BLENDMODE_ONE
                  )
                : raster === 'blend'
                  ? new BlendState(
                        true,
                        BLENDEQUATION_ADD,
                        BLENDMODE_ONE,
                        BLENDMODE_ONE_MINUS_SRC_ALPHA,
                        BLENDEQUATION_ADD,
                        BLENDMODE_ONE,
                        BLENDMODE_ONE_MINUS_SRC_ALPHA
                    )
                  : BlendState.NOBLEND;
        this.rasterMaterial.setDefine('SSE_MSAA', this.variant.msaa.startsWith('half4') ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_SEED_VERTEX', this.variant.hash !== 'full' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_HASH_LITE', this.variant.hash === 'lite' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_HASH_IGN', this.variant.hash === 'ign' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_UV_HALF', this.variant.uvHalf === 'on' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_FALLOFF_POLY', this.variant.falloff === 'poly' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_EARLY_REJECT', this.variant.earlyReject === 'on' ? '' : undefined);
        for (const pass of this.setPasses) pass.skip = this.variant.raster === 'none';
        this.rasterMaterial.depthWrite = ![
            'testonly',
            'nodepth',
            'nevernowrite',
            'solidtest',
            'nodiscard',
            'blend'
        ].includes(raster);
        this.rasterMaterial.depthTest = raster !== 'nodepth';
        this.rasterMaterial.depthFunc =
            raster === 'never' || raster === 'solidnever' || raster === 'nevernowrite' ? FUNC_NEVER : FUNC_LESSEQUAL;
        // variant prefill:solid: the same quads as discard-free depth-only squares first
        for (const name of ['SSE_ORDERED', 'SSE_POPLESS', 'SSE_QUAD_CLIP']) {
            this.solidMaterial.setDefine(name, this.rasterMaterial.getDefine(name) ? '' : undefined);
        }
        this.solidMaterial.setDefine('SSE_RASTER_SOLID', '');
        this.solidMaterial.setDefine('SSE_CORE', this.variant.prefill === 'core' ? '' : undefined);
        this.solidMaterial.update();
        this.composeMaterial.setDefine('SSE_SHOW_DEPTH', this.variant.compose === 'depth' ? '' : undefined);
        this.composeMaterial.setDefine('SSE_SPP_QUAD', quad ? '' : undefined);
        this.rasterMaterial.update();
        this.composeMaterial.update();
        this.setReady(this.ready);
        this.app.renderNextFrame = true;
    }

    // the raster pass and the compose only run once a frame has bound the buffers they read
    private setReady(value: boolean) {
        this.ready = value;
        this.rasterPass.enabled = value;
        for (const pass of this.setPasses) pass.enabled = value && this.variant.coverage === 'interleaved';
        this.composeInstance.visible = value && this.variant.compose !== 'none';
    }

    private attach() {
        const passes = this.camera.camera.beforePasses;
        for (const pass of this.setPasses) if (!passes.includes(pass)) passes.push(pass);
        if (!passes.includes(this.rasterPass)) passes.push(this.rasterPass);
        if (!passes.includes(this.taaPass)) passes.push(this.taaPass);
        this.worldLayer.addMeshInstances([this.composeInstance]);
        this.provider.setActive(true);
    }

    private detach() {
        const passes = this.camera.camera.beforePasses;
        for (const pass of [...this.setPasses, this.rasterPass, this.taaPass]) {
            const index = passes.indexOf(pass);
            if (index >= 0) passes.splice(index, 1);
        }
        this.resetHistory();
        this.depthFrame = null;
        this.worldLayer.removeMeshInstances([this.composeInstance]);
        this.provider.setActive(false);
    }

    private frame(set: ResidentSet, changed: boolean, manager: EngineManager) {
        if (!this.enabled) return;
        const { device, camera } = this;
        const cam = camera.camera;

        this.nodesRemoved = false;
        if (changed || this.set !== set) {
            const ids = new Set(set.nodes.map((node) => node.allocId));
            for (const id of this.residentAllocIds) {
                if (!ids.has(id)) {
                    this.nodesRemoved = true;
                    break;
                }
            }
            this.residentAllocIds = ids;
            this.source.update(set, manager);
            this.rebuildChunkTable(set);
            this.ensureCache(set.activeSplats);
            this.activeSplats = set.activeSplats;
            this.pruneProjectorComputes(set);
            // recorded last, so a rebuild that throws is retried next frame
            this.set = set;
        }
        if (this.numChunks === 0) {
            // nothing resident: draw nothing
            this.setReady(false);
            return;
        }

        // the target follows whatever the camera renders into this frame: the backbuffer, or a
        // capture's render target at another size
        const rt = camera.renderTarget;
        const width = rt ? rt.width : device.width;
        const height = rt ? rt.height : device.height;
        if (this.target.width !== width || this.target.height !== height) {
            this.target.resize(width, height);
        }
        this.selectRasterTarget(width, height);

        const view = cam.viewMatrix;
        const projection = cam.projectionMatrix;
        const isOrtho = cam.projection === PROJECTION_ORTHOGRAPHIC;
        // the clip z the raster shader reconstructs must match the engine's WebGPU depth range
        const shaderProjection = Camera.applyShaderProjectionTransform(projection, this.shaderProjection, false, true);
        this.viewProjection.mul2(shaderProjection, view);
        // The splats' own depth: clip z = a * depth + b (over w = depth for a perspective
        // camera). The camera's far plane is fitted to the scene bound, which can leave a sky
        // outside it, and splats clamped there share one depth and lose their order; so a
        // perspective raster puts its far plane at infinity (z = 1 - near / depth), with the same
        // near plane and, near where precision matters, the same resolution. The compose converts
        // back to the camera's depth where the splats meet the rest of the scene. An orthographic
        // camera keeps its own mapping: a linear depth has no far plane at infinity.
        const cameraClipZ = [-shaderProjection.data[10], shaderProjection.data[14]];
        const clipZ = isOrtho ? cameraClipZ : [1, cameraClipZ[1] / cameraClipZ[0]];
        const clipZParams = [clipZ[0], clipZ[1], isOrtho ? 1 : 0, 0];

        this.cullNodes(set, this.viewProjection);

        const focal = [Math.abs(projection.data[0]) * width * 0.5, Math.abs(projection.data[5]) * height * 0.5];
        const gsplat = this.app.scene.gsplat;
        // splats, quads and fragments below it are dropped
        const alphaClip = this.variant.alphaClip > 0 ? this.variant.alphaClip : gsplat.alphaClipForward;

        // the moving-camera contribution cull: a raised threshold while the view changes, then
        // one more frame at the scene's threshold once it has stopped
        const moved = this.viewMoved(view, projection);
        const raised = moved && this.variant.contribution > 0;
        const minContribution = raised
            ? Math.max(gsplat.minContribution, this.variant.contribution)
            : gsplat.minContribution;
        if (raised) this.frameWanted = true;

        // Temporal accumulation runs on on-screen frames (and, for the harness, on a capture at
        // the same size); the history is only trusted when it holds the previous such frame at
        // this size. While it runs the coverage seed changes every frame, and a resting camera
        // keeps requesting frames until the history has filled its cap
        const isQuery = !!rt;
        const computePipeline = this.variant.pipeline === 'compute';
        const sampled = this.variant.pipeline === 'sample';
        const taaOn =
            this.variant.taa === 'on' &&
            !computePipeline &&
            (!isQuery || (this.allowQueryTaa && width === this.taaWidth && height === this.taaHeight));
        if (taaOn) {
            if (this.taaWidth !== width || this.taaHeight !== height) {
                this.resizeHistory(width, height);
                this.taaWidth = width;
                this.taaHeight = height;
                this.taaHistoryValid = false;
                this.restFrames = 0;
            }
            this.frameSeed = this.frameIndex++ >>> 0;
            if (moved || changed) this.restFrames = 0;
            else this.restFrames++;
            if (this.restFrames < this.variant.taaMax + 2) this.frameWanted = true;
        } else {
            this.frameSeed = this.userSeed;
            // a capture at another size does not accumulate; the next on-screen frame starts over
            this.taaHistoryValid = false;
            this.restFrames = 0;
            // switched off: the history goes back to its placeholder size until it is wanted
            if (this.variant.taa === 'off' && this.taaWidth !== 0) {
                this.resizeHistory(4, 4);
                this.taaWidth = 0;
                this.taaHeight = 0;
            }
        }
        this.taaActive = taaOn;

        // The occlusion cull reads the depth texture as the previous frame left it, so it needs
        // that frame to have drawn to this target at this size (a resize loses the texture, a
        // capture draws elsewhere), with no splat removed since (its depth would hide what is
        // now behind it; arrivals are safe) and the same projection type. A capture frame is
        // never culled and never becomes the previous frame.
        // a new world state can change what is occluded: try the test again
        if (this.prevVersion !== set.version) {
            this.cullSuspendedFrames = 0;
            this.cullActive = true;
        }
        const cullMode = this.variant.cull;
        let wanted = cullMode !== 'off';
        let probe = false;
        if (cullMode === 'auto' && !isQuery) {
            if (this.cullSuspendedFrames > 0) {
                // a moving camera changes what is occluded, so the probe comes sooner
                const moved = this.viewMoved(view, projection);
                this.cullSuspendedFrames = Math.max(0, this.cullSuspendedFrames - (moved ? 4 : 1));
                wanted = false;
            } else if (!this.cullActive) {
                // suspended and due: one probe frame, then wait for its counts
                probe = !this.cullStatsPending;
                wanted = probe;
            }
        }
        const culling =
            wanted &&
            (!isQuery || this.allowQueryCull) &&
            this.prevValid &&
            this.prevWidth === width &&
            this.prevHeight === height &&
            !this.nodesRemoved &&
            this.prevOrtho === isOrtho;
        this.culling = culling;
        if (culling) {
            // the tile renderer wrote level 1 itself, and level 2 from it, at the end of its frame
            if (!computePipeline) this.reduceDepth(width, height);
        }

        this.counter.clear();
        // the tile renderer takes every survivor as the raster draws them per pixel
        const coverage = computePipeline || sampled ? 'pixel' : this.variant.coverage;
        const interleaved = coverage === 'interleaved';
        // interleaved pixel sets split their draws by the order, the tile renderer bins in it and
        // the sampler scatters front to back in it
        const ordered = computePipeline || sampled || this.variant.order === 'bucket' || interleaved;
        if (ordered) this.orderBuckets.clear();
        this.ensureOrdered(this.cacheSlots * (interleaved ? 4 : 1));
        // the order key spans the fitted clip range, log-spaced
        const logNear = Math.log(Math.max(cam.nearClip, 1e-6));
        const invLogRange = 1 / Math.max(Math.log(Math.max(cam.farClip, 1e-6)) - logNear, 1e-6);
        // the view depths where the raster's clip z reaches 0 and its far clamp (FAR_CLIP_Z), from
        // clip z = a * depth + b (over w = depth for a perspective camera)
        const [clipA, clipB] = clipZ;
        const depthNear = -clipB / clipA;
        const depthFar = isOrtho ? (FAR_CLIP_Z - clipB) / clipA : clipB / (FAR_CLIP_Z - clipA);

        const cameraPosition = camera.entity.getPosition();
        const groups = this.source.dispatchPlan(set, this.numChunks);
        for (const group of groups) {
            // a file with no node in the frustum has nothing to dispatch
            if (group.fileIndex >= 0 && !this.anyNodeVisible(set.files[group.fileIndex].nodes)) continue;
            const projector = this.ensureProjector(culling, ordered, coverage, group);
            this.source.bind(projector, group, set);
            projector.setParameter('chunks', this.chunkBuffer!);
            projector.setParameter('nodeVisible', this.nodeVisibleBuffer!);
            projector.setParameter('cache', this.cacheBuffer!);
            projector.setParameter('counter', this.counter);
            projector.setParameter('occL1', this.occL1);
            projector.setParameter('occL2', this.occL2);
            projector.setParameter('buckets', this.orderBuckets);
            projector.setParameter('view', view.data);
            projector.setParameter('viewProj', this.viewProjection.data);
            projector.setParameter('prevViewProj', this.prevViewProjection.data);
            projector.setParameter('prevView', this.prevView.data);
            projector.setParameter('prevClipZ', this.prevClipZ);
            projector.setParameter('viewport', [width, height]);
            projector.setParameter('focal', focal);
            projector.setParameter('prevViewport', this.prevViewport);
            projector.setParameter('prevFocal', this.prevFocal);
            projector.setParameter('numChunks', group.chunkCount);
            projector.setParameter('chunkBase', group.chunkBase);
            projector.setParameter('cameraPosition', [cameraPosition.x, cameraPosition.y, cameraPosition.z, 0]);
            projector.setParameter('splatTextureSize', this.source.textureSize(group));
            projector.setParameter('isOrtho', isOrtho ? 1 : 0);
            projector.setParameter('minPixelSize', gsplat.minPixelSize);
            projector.setParameter('alphaClip', alphaClip);
            projector.setParameter('minContribution', minContribution);
            projector.setParameter('colorMax', this.variant.colorMax);
            projector.setParameter('unitScale', this.variant.units === 'engine' ? 2 : 1);
            projector.setParameter('occBlocksX1', this.occBlocks.x1);
            projector.setParameter('occBlocksY1', this.occBlocks.y1);
            projector.setParameter('occBlocksX2', this.occBlocks.x2);
            projector.setParameter('occBlocksY2', this.occBlocks.y2);
            projector.setParameter('occlusionMode', culling ? (cullMode === 'l1' ? 1 : 2) : 0);
            projector.setParameter('prevFlip', this.prevFlip);
            projector.setParameter('keyLogNear', logNear);
            projector.setParameter('keyInvLogRange', invLogRange);
            projector.setParameter('depthNear', depthNear);
            projector.setParameter('depthFar', depthFar);
            projector.setParameter('frameSeed', this.frameSeed);
            Compute.calcDispatchSize(group.chunkCount, tmpVec2);
            projector.setupDispatch(tmpVec2.x, tmpVec2.y, 1);
            device.computeDispatch([projector], 'sse-splat-project');
        }

        // indirect draw arguments for the raster and dispatch size for the scatter; slots are
        // per frame
        const drawSlot = device.getIndirectDrawSlot(1);
        const dispatchSlot = device.getIndirectDispatchSlot(1);
        this.args.setParameter('counter', this.counter);
        this.args.setParameter('indirectDrawArgs', device.indirectDrawBuffer);
        this.args.setParameter('indirectDispatchArgs', device.indirectDispatchBuffer);
        this.args.setParameter('drawSlot', drawSlot);
        // the solid prefill shares the draw arguments and is not combined with coverage:splat
        const indicesPerSplat = coverage !== 'pixel' ? (SPLAT_POLYGON_SIDES - 2) * 3 : 6;
        this.args.setParameter('indexCount', QUADS_PER_INSTANCE * indicesPerSplat);
        this.args.setParameter('quadsPerInstance', QUADS_PER_INSTANCE);
        this.args.setParameter('dispatchSlot', dispatchSlot);
        this.args.setParameter('scatterWorkgroupSize', ORDER_BUCKETS);
        this.args.setupDispatch(1, 1, 1);
        device.computeDispatch([this.args], 'sse-splat-args');
        this.rasterInstance.setIndirect(null, drawSlot, 1);
        // the raster pass only clears in the tile renderer's frames, so the compose finds no sample
        // there and reads the tiles' depth record instead
        this.rasterPass.skip = computePipeline || this.variant.raster === 'none' || this.variant.raster === 'nocopy';
        this.solidInstance.setIndirect(null, drawSlot, 1);

        if (ordered) {
            // bucket offsets, then every survivor claims its place in its bucket
            this.orderScan.setParameter('buckets', this.orderBuckets);
            this.orderScan.setupDispatch(1, 1, 1);
            device.computeDispatch([this.orderScan], 'sse-splat-order-scan');
            if (interleaved) {
                // each set's range and draw, from the offsets before the scatter advances them
                const setSlot = device.getIndirectDrawSlot(4);
                const setArgs = this.setArgs;
                setArgs.setParameter('buckets', this.orderBuckets);
                setArgs.setParameter('indirectDrawArgs', device.indirectDrawBuffer);
                setArgs.setParameter('setRanges', this.setRanges);
                setArgs.setParameter('drawSlot', setSlot);
                setArgs.setParameter('indexCount', QUADS_PER_INSTANCE * indicesPerSplat);
                setArgs.setParameter('quadsPerInstance', QUADS_PER_INSTANCE);
                setArgs.setupDispatch(1, 1, 1);
                device.computeDispatch([setArgs], 'sse-splat-set-args');
                this.prepareSets(width, height, setSlot);
            }
            const scatter = interleaved ? this.orderScatterSets : this.orderScatter;
            scatter.setParameter('counter', this.counter);
            scatter.setParameter('cache', this.cacheBuffer!);
            scatter.setParameter('buckets', this.orderBuckets);
            scatter.setParameter('ordered', this.orderedBuffer!);
            scatter.setupIndirectDispatch(dispatchSlot);
            device.computeDispatch([scatter], 'sse-splat-order-scatter');
        }
        // the tile renderer bins in the order just scattered, and the sampler scatters in it
        if (computePipeline) {
            this.dispatchTiles(width, height, dispatchSlot, alphaClip, clipZ, isOrtho, focal);
        }
        if (sampled) {
            this.dispatchSamples(width, height, dispatchSlot, alphaClip, clipZ, isOrtho, focal);
        }

        for (const material of [this.rasterMaterial, this.solidMaterial]) {
            material.setParameter('splatCache', this.cacheBuffer!);
            material.setParameter('splatCount', this.counter);
            if (ordered) material.setParameter('orderedSlots', this.orderedBuffer!);
            material.setParameter('viewportSize', [width, height, 2 / width, 2 / height]);
            material.setParameter('clipZParams', clipZParams);
            material.setParameter('focalParams', [focal[0], focal[1], 0, 0]);
            material.setParameter('sseAlphaClip', alphaClip);
            material.setParameter('frameSeed', this.frameSeed);
        }
        this.solidMaterial.setParameter('sseCoreAlpha', this.variant.coreAlpha);
        if (interleaved) this.rasterMaterial.setParameter('setRanges', this.setRanges);

        // variant occluder:on: the occlusion grid's level 1, reduced from the previous frame
        // above, as depth-only quads drawn before the splats (shaders/occluder.ts)
        const occluding = this.variant.occluder === 'on' && culling && !isOrtho;
        if (occluding) {
            const occ = this.occluderMaterial;
            const { x1, y1 } = this.occBlocks;
            occ.setParameter('occL1', this.occL1);
            occ.setParameter('occBlocks', [x1, y1, 8, 0]);
            occ.setParameter('prevViewport', [this.prevViewport[0], this.prevViewport[1], this.prevFlip, 0]);
            occ.setParameter('prevProjScale', [this.prevProjection.data[0], this.prevProjection.data[5], 0, 0]);
            occ.setParameter('prevClipZ', this.prevClipZ);
            occ.setParameter('prevInvView', this.prevInvView.copy(this.prevView).invert().data);
            occ.setParameter('occViewProj', this.viewProjection.data);
            occ.setParameter('clipZParams', clipZParams);
            this.occluderInstance.instancingCount = Math.ceil((x1 * y1) / QUADS_PER_INSTANCE);
        }
        this.rasterPass.instances = sampled
            ? [this.samplePipeline!.resolveInstance]
            : interleaved
              ? [this.interleaveInstance]
              : [
                    ...(occluding ? [this.occluderInstance] : []),
                    ...(this.variant.prefill === 'solid' || this.variant.prefill === 'core'
                        ? [this.solidInstance]
                        : []),
                    this.rasterInstance
                ];

        this.taaPass.enabled = taaOn;
        if (taaOn) {
            const read = this.taaWrite ^ 1;
            const taa = this.taaMaterial;
            this.taaPrevViewProjection.copy(this.taaLastViewProjection);
            this.taaPrevView.copy(this.taaLastView);
            this.cameraWorld.copy(view).invert();
            taa.setParameter('curColor', this.colorTexture);
            taa.setParameter('curDepth', this.depthTexture);
            taa.setParameter('histColor', this.taaColor[read]);
            taa.setParameter('histInfo', this.taaInfo[read]);
            taa.setParameter('cameraWorld', this.cameraWorld.data);
            // x_ndc = (m00 x + m02 z) / -z for a perspective camera, m00 x + m03 for an orthographic one
            const sp = shaderProjection.data;
            taa.setParameter('unproject', isOrtho ? [sp[0], sp[5], sp[12], sp[13]] : [sp[0], sp[5], sp[8], sp[9]]);
            taa.setParameter('prevViewProj', this.taaPrevViewProjection.data);
            taa.setParameter('prevView', this.taaPrevView.data);
            taa.setParameter('clipZParams', clipZParams);
            // a changed resident set (detail streamed in) keeps the history but caps its weight,
            // so the new content shows within taaMoveMax frames rather than 1 / taaMax a frame
            taa.setParameter('taaParams', [
                moved || changed ? this.variant.taaMoveMax : this.variant.taaMax,
                this.taaHistoryValid ? 1 : 0,
                moved ? 1 : 0,
                this.restFrames
            ]);
            taa.setParameter('taaViewport', [width, height, 1 / width, 1 / height]);
            taa.setParameter('taaControl', [
                this.variant.taaFlip || (this.target.flipY ? -1 : 1),
                this.variant.taaClip,
                this.variant.spp === 'quad' ? 1 : 0,
                this.variant.taaSpread
            ]);
            taa.setParameter('taaDebug', this.variant.taaDebug);
            taa.setParameter('taaFilter', [
                this.variant.taaFilter === 'cubic' ? 1 : 0,
                this.variant.taaReproj === 'history' ? 1 : 0,
                this.variant.taaMotion,
                0
            ]);
            this.taaPass.renderTarget = this.taaTargets[this.taaWrite];
            this.composeMaterial.setParameter('taaColor', this.taaColor[this.taaWrite]);
            this.composeMaterial.setParameter('taaInfo', this.taaInfo[this.taaWrite]);
            this.taaLastViewProjection.copy(this.viewProjection);
            this.taaLastView.copy(view);
            this.taaHistoryValid = true;
            this.taaWrite ^= 1;
        }

        if (computePipeline) {
            this.composeMaterial.setParameter('taaColor', this.tileColor!);
            this.composeMaterial.setParameter('taaInfo', this.tileInfo!);
        }

        // an offscreen target's rows run the other way to the backbuffer's on WebGPU
        const targetFlipY = rt ? rt.flipY : device.backBuffer.flipY;
        this.composeMaterial.setParameter('composeParams', [
            this.target.flipY !== targetFlipY ? 1 : 0,
            isOrtho ? 1 : 0,
            taaOn || computePipeline ? 1 : 0,
            0
        ]);
        this.composeMaterial.setParameter('depthViewParams', [
            clipZ[0],
            clipZ[1],
            Math.max(cam.nearClip, 1e-4),
            Math.max(cam.farClip, cam.nearClip * 2)
        ]);
        this.composeMaterial.setParameter('cameraClipZ', [cameraClipZ[0], cameraClipZ[1], isOrtho ? 1 : 0, 0]);

        // cull:auto: read this culled frame's counts back (asynchronously, off the frame) and
        // keep the test only while it removes enough to pay for itself
        if (culling && cullMode === 'auto' && !isQuery && !this.cullStatsPending) {
            this.cullStatsPending = true;
            const data = new Uint32Array(2);
            this.counter
                .read(0, 8, data, false)
                .then(() => {
                    const total = data[0] + data[1];
                    const worthwhile = total > 0 && data[1] / total >= StochasticSplatRenderer.CULL_MIN_FRACTION;
                    this.cullActive = worthwhile;
                    if (!worthwhile) this.cullSuspendedFrames = StochasticSplatRenderer.CULL_SUSPEND_FRAMES;
                })
                .catch(() => {
                    // a lost device or a destroyed buffer; the next frame tries again
                })
                .finally(() => {
                    this.cullStatsPending = false;
                });
        }

        // this frame becomes the previous one, unless it is a capture
        if (isQuery) {
            // the capture drew elsewhere; the on-screen depth texture is no longer this frame's
            this.prevValid = false;
            this.depthFrame = null;
            this.setReady(true);
            return;
        }
        captureCameraSnapshot(camera.entity, this.depthFrameCamera);
        this.depthFrame = {
            id: ++this.depthFrameCount,
            camera: this.depthFrameCamera,
            width,
            height,
            clipZ: [clipZ[0], clipZ[1]]
        };
        this.prevViewProjection.copy(this.viewProjection);
        this.prevView.copy(view);
        this.prevProjection.copy(projection);
        this.prevClipZ = clipZParams;
        this.prevViewport = [width, height];
        this.prevFocal = focal;
        this.prevFlip = this.target.flipY ? -1 : 1;
        this.prevWidth = width;
        this.prevHeight = height;
        this.prevVersion = set.version;
        this.prevOrtho = isOrtho;
        this.prevValid = !isQuery;

        this.setReady(true);
    }

    private resizeHistory(width: number, height: number) {
        for (const texture of [...this.taaColor, ...this.taaInfo]) texture.resize(width, height);
        for (const target of this.taaTargets) target.resize(width, height);
    }

    // whether the view or the projection differs from the previous on-screen frame's beyond
    // float noise (the camera controllers settle over many frames; a fov animation moves the
    // image without moving the camera)
    private viewMoved(view: Mat4, projection: Mat4) {
        for (let i = 0; i < 16; i++) {
            if (Math.abs(view.data[i] - this.prevView.data[i]) > 1e-6) return true;
            if (Math.abs(projection.data[i] - this.prevProjection.data[i]) > 1e-6) return true;
        }
        return false;
    }

    // one chunk-table entry per CHUNK_SIZE splats of every resident node
    private rebuildChunkTable(set: ResidentSet) {
        let count = 0;
        for (const node of set.nodes) count += Math.ceil(node.count / CHUNK_SIZE);
        if (this.chunkData.length < count * 4) {
            this.chunkData = new Uint32Array(Math.ceil(count * 1.25) * 4);
            this.chunkBuffer?.destroy();
            this.chunkBuffer = new StorageBuffer(this.device, this.chunkData.byteLength, BUFFERUSAGE_COPY_DST);
        }
        const data = this.chunkData;
        let k = 0;
        set.nodes.forEach((node, nodeIndex) => {
            const base = this.source.chunkBase(node);
            for (let offset = 0; offset < node.count; offset += CHUNK_SIZE) {
                data[k++] = base + offset;
                data[k++] = Math.min(CHUNK_SIZE, node.count - offset);
                data[k++] = nodeIndex;
                data[k++] = (node.lodIndex & 0xffff) | (node.fileIndex << 16);
            }
        });
        this.numChunks = count;
        // writeBuffer counts typed-array elements, not bytes
        if (count > 0) this.chunkBuffer!.write(0, data, 0, count * 4);

        const words = Math.max(1, Math.ceil(set.nodes.length / 32));
        if (this.nodeVisibleData.length < words) {
            this.nodeVisibleData = new Uint32Array(words);
            this.nodeVisibleBuffer?.destroy();
            this.nodeVisibleBuffer = new StorageBuffer(this.device, words * 4, BUFFERUSAGE_COPY_DST);
        }
    }

    // the cache is dense (indexed by compact slot), so it only needs room for the resident
    // splats, not the allocator's address space; grown geometrically, never shrunk
    private ensureCache(splats: number) {
        if (splats <= this.cacheSlots) return;
        this.cacheBuffer?.destroy();
        this.orderedBuffer?.destroy();
        this.cacheSlots = Math.max(1, Math.ceil(splats * 1.25));
        this.cacheBuffer = new StorageBuffer(this.device, this.cacheSlots * CACHE_WORDS * 4, BUFFERUSAGE_COPY_SRC);
        this.orderedBuffer = null;
        this.orderedCapacity = 0;
    }

    // the ordered list: one entry per survivor, or with interleaved pixel sets one per set it
    // keeps pixels in, up to four
    private ensureOrdered(entries: number) {
        if (entries <= this.orderedCapacity) return;
        this.orderedBuffer?.destroy();
        this.orderedCapacity = entries;
        this.orderedBuffer = new StorageBuffer(this.device, entries * 4);
    }

    // Variant coverage:interleaved: size the pixel sets' targets to half the full target, rounded
    // up, and point each set's draw at its indirect arguments and its map into its target. In
    // framebuffer pixels the full target's (2i + x, 2j + y) is the set (x, y)'s (i, j); as a map
    // of clip x and y over w (y down in the framebuffer from ndc +1)
    private prepareSets(width: number, height: number, drawSlot: number) {
        const w = Math.ceil(width / 2);
        const h = Math.ceil(height / 2);
        for (let i = 0; i < 4; i++) {
            const target = this.setTargets[i];
            if (target.width !== w || target.height !== h) target.resize(w, h);
            const x = i & 1;
            const y = i >> 1;
            const instance = this.setInstances[i];
            instance.setIndirect(null, drawSlot + i, 1);
            instance.setParameter('setMap', [
                width / (2 * w),
                (width / 2 - x + 0.5) / w - 1,
                height / (2 * h),
                1 - (height / 2 - y + 0.5) / h
            ]);
        }
    }

    // sphere-frustum test per node on the cpu: thousands of nodes, one bit each
    private cullNodes(set: ResidentSet, viewProjection: Mat4) {
        const bits = this.nodeVisibleData;
        bits.fill(0);
        this.frustum.setFromMat4(viewProjection);
        const spheres = set.nodeSpheres;
        const { sphere } = this;
        for (let i = 0; i < set.nodes.length; i++) {
            sphere.center.set(spheres[i * 4], spheres[i * 4 + 1], spheres[i * 4 + 2]);
            sphere.radius = spheres[i * 4 + 3];
            if (this.frustum.containsSphere(sphere) !== 0) {
                bits[i >> 5] |= 1 << (i & 31);
            }
        }
        const words = Math.max(1, Math.ceil(set.nodes.length / 32));
        this.nodeVisibleBuffer!.write(0, bits, 0, words);
    }

    private anyNodeVisible(nodes: ResidentSet['nodes']) {
        const bits = this.nodeVisibleData;
        return nodes.some((node) => (bits[node.nodeIndex >> 5] >>> (node.nodeIndex & 31)) & 1);
    }

    private ensureProjector(occlusion: boolean, ordered: boolean, coverage: CoverageMode, group: DispatchGroup) {
        const sourceKey = this.source.shaderKey();
        if (this.projectorSourceKey !== sourceKey) {
            // a different source: every specialisation and the bind group format go
            this.destroyProjector();
            this.projectorSourceKey = sourceKey;
        }
        const key = `${occlusion ? 'occlusion' : 'plain'}-${ordered ? 'bucket' : 'append'}-${coverage}`;
        const computeKey = `${key}:${group.fileIndex}`;
        const existing = this.projectorComputes.get(computeKey);
        if (existing) return existing;
        const shader = this.ensureProjectorShader(key, occlusion, ordered, coverage);
        const compute = new Compute(this.device, shader, 'sse-splat-project');
        this.projectorComputes.set(computeKey, compute);
        return compute;
    }

    // drop the computes of files that left the resident set
    private pruneProjectorComputes(set: ResidentSet) {
        for (const [key, compute] of this.projectorComputes) {
            const fileIndex = Number(key.slice(key.lastIndexOf(':') + 1));
            if (fileIndex >= 0 && !set.files[fileIndex]) {
                compute.destroy();
                this.projectorComputes.delete(key);
            }
        }
    }

    private ensureProjectorShader(key: string, occlusion: boolean, ordered: boolean, coverage: CoverageMode) {
        const existing = this.projectorShaders.get(key);
        if (existing) return existing;
        const { device } = this;
        const fixed = [
            new BindStorageBufferFormat('chunks', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('nodeVisible', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('cache', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('occL1', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('occL2', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE)
        ];
        const formats = [...fixed, ...this.source.bindFormats()] as ConstructorParameters<typeof BindGroupFormat>[1];
        this.projectorBindGroupFormat ??= new BindGroupFormat(device, formats);
        const shader = new Shader(device, {
            name: `sse-splat-project-${key}`,
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: projectorWGSL(this.source.readChunk(fixed.length), occlusion, ordered, coverage),
            cincludes: this.source.shaderIncludes(),
            cdefines: this.source.shaderDefines(),
            computeUniformBufferFormats: {
                // the same order as the wgsl struct; both follow the same alignment rules
                uniforms: new UniformBufferFormat(device, [
                    new UniformFormat('view', UNIFORMTYPE_MAT4),
                    new UniformFormat('viewProj', UNIFORMTYPE_MAT4),
                    new UniformFormat('prevViewProj', UNIFORMTYPE_MAT4),
                    new UniformFormat('prevView', UNIFORMTYPE_MAT4),
                    new UniformFormat('prevClipZ', UNIFORMTYPE_VEC4),
                    new UniformFormat('viewport', UNIFORMTYPE_VEC2),
                    new UniformFormat('focal', UNIFORMTYPE_VEC2),
                    new UniformFormat('prevViewport', UNIFORMTYPE_VEC2),
                    new UniformFormat('prevFocal', UNIFORMTYPE_VEC2),
                    new UniformFormat('numChunks', UNIFORMTYPE_UINT),
                    new UniformFormat('splatTextureSize', UNIFORMTYPE_UINT),
                    new UniformFormat('isOrtho', UNIFORMTYPE_UINT),
                    new UniformFormat('minPixelSize', UNIFORMTYPE_FLOAT),
                    new UniformFormat('alphaClip', UNIFORMTYPE_FLOAT),
                    new UniformFormat('minContribution', UNIFORMTYPE_FLOAT),
                    new UniformFormat('occBlocksX1', UNIFORMTYPE_UINT),
                    new UniformFormat('occBlocksY1', UNIFORMTYPE_UINT),
                    new UniformFormat('occBlocksX2', UNIFORMTYPE_UINT),
                    new UniformFormat('occBlocksY2', UNIFORMTYPE_UINT),
                    new UniformFormat('occlusionMode', UNIFORMTYPE_UINT),
                    new UniformFormat('prevFlip', UNIFORMTYPE_FLOAT),
                    new UniformFormat('keyLogNear', UNIFORMTYPE_FLOAT),
                    new UniformFormat('keyInvLogRange', UNIFORMTYPE_FLOAT),
                    new UniformFormat('chunkBase', UNIFORMTYPE_UINT),
                    new UniformFormat('model', UNIFORMTYPE_MAT4),
                    new UniformFormat('modelRotation', UNIFORMTYPE_VEC4),
                    new UniformFormat('modelScale', UNIFORMTYPE_VEC4),
                    new UniformFormat('cameraPosition', UNIFORMTYPE_VEC4),
                    new UniformFormat('colorMax', UNIFORMTYPE_FLOAT),
                    new UniformFormat('unitScale', UNIFORMTYPE_FLOAT),
                    new UniformFormat('depthNear', UNIFORMTYPE_FLOAT),
                    new UniformFormat('depthFar', UNIFORMTYPE_FLOAT),
                    new UniformFormat('frameSeed', UNIFORMTYPE_UINT)
                ])
            },
            computeBindGroupFormat: this.projectorBindGroupFormat
        });
        this.projectorShaders.set(key, shader);
        return shader;
    }

    private destroyProjector() {
        for (const compute of this.projectorComputes.values()) compute.destroy();
        this.projectorComputes.clear();
        for (const shader of this.projectorShaders.values()) shader.destroy();
        this.projectorShaders.clear();
        this.projectorBindGroupFormat?.destroy();
        this.projectorBindGroupFormat = null;
        this.projectorSourceKey = '';
    }

    destroy() {
        this.unsubscribe();
        this.app.off('frameend', this.onFrameEnd);
        this.detach();
        this.provider.destroy();
        this.source.destroy();

        this.destroyProjector();
        this.args.shader.destroy();
        this.args.destroy();
        this.argsBindGroupFormat.destroy();
        for (const compute of [this.reduceL1, this.reduceL2]) {
            compute.shader.destroy();
            compute.destroy();
        }
        for (const format of this.reduceFormats) format.destroy();
        this.occL1.destroy();
        this.occL2.destroy();
        for (const compute of [this.orderScan, this.orderScatter, this.orderScatterSets, this.setArgs]) {
            compute.shader.destroy();
            compute.destroy();
        }
        this.setRanges.destroy();
        if (this.tilePipeline) {
            const { formats, ...computes } = this.tilePipeline;
            for (const compute of Object.values(computes)) {
                compute.shader.destroy();
                compute.destroy();
            }
            for (const format of formats) format.destroy();
            this.tilePipeline = null;
        }
        for (const buffer of [
            this.tileCounts,
            this.tileOffsets,
            this.tileEntries,
            this.tileRecordsA,
            this.tileRecordsB,
            this.tileEntryTotal
        ]) {
            buffer?.destroy();
        }
        this.tileColor?.destroy();
        this.tileInfo?.destroy();
        if (this.samplePipeline) {
            const { formats, resolveMaterial, resolveInstance, ...computes } = this.samplePipeline;
            for (const compute of Object.values(computes)) {
                compute.shader.destroy();
                compute.destroy();
            }
            for (const format of formats) format.destroy();
            const resolveMesh = resolveInstance.mesh;
            resolveInstance.destroy();
            resolveMesh.destroy();
            resolveMaterial.destroy();
            this.samplePipeline = null;
        }
        for (const buffer of [
            this.samplePixels,
            this.sampleTotals,
            this.sampleRadii,
            this.sampleBatches,
            this.sampleBatchCount
        ]) {
            buffer?.destroy();
        }
        for (const format of this.orderFormats) format.destroy();
        this.orderBuckets.destroy();
        this.orderedBuffer?.destroy();
        this.orderedBuffer = null;

        this.chunkBuffer?.destroy();
        this.nodeVisibleBuffer?.destroy();
        this.cacheBuffer?.destroy();
        this.counter.destroy();
        this.chunkBuffer = this.nodeVisibleBuffer = this.cacheBuffer = null;

        this.rasterPass.destroy();
        this.rasterInstance.destroy();
        this.rasterMaterial.destroy();
        this.solidInstance.destroy();
        this.solidMaterial.destroy();
        this.occluderInstance.destroy();
        this.occluderMaterial.destroy();
        for (const pass of this.setPasses) pass.destroy();
        for (const instance of this.setInstances) instance.destroy();
        for (const target of this.setTargets) target.destroy();
        for (const texture of this.setTextures) texture.destroy();
        this.setPasses.length = 0;
        this.setInstances.length = 0;
        this.setTargets.length = 0;
        this.setTextures.length = 0;
        const interleaveMesh = this.interleaveInstance.mesh;
        this.interleaveInstance.destroy();
        interleaveMesh.destroy();
        this.interleaveMaterial.destroy();
        this.rasterMesh.destroy();
        this.polygonMesh.destroy();
        this.taaPass.destroy();
        this.taaInstance.destroy();
        this.taaMaterial.destroy();
        this.taaMesh.destroy();
        for (const target of this.taaTargets) target.destroy();
        for (const texture of [...this.taaColor, ...this.taaInfo]) texture.destroy();
        this.taaTargets.length = 0;
        this.taaColor.length = 0;
        this.taaInfo.length = 0;
        this.target.destroy();
        this.colorTexture.destroy();
        this.depthTexture.destroy();
        for (const { target, textures } of this.altTargets.values()) {
            target.destroy();
            for (const texture of textures) texture.destroy();
        }
        this.altTargets.clear();

        this.composeInstance.destroy();
        this.composeMaterial.destroy();
        this.composeMesh.destroy();
    }
}

export { StochasticSplatRenderer };
export type { DepthFrame, StochasticRendererOptions, Variant };
