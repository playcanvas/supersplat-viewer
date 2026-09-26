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
    BindTextureFormat,
    BindUniformBufferFormat,
    BLEND_NONE,
    BLEND_PREMULTIPLIED,
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
    PIXELFORMAT_DEPTH,
    PIXELFORMAT_RGBA32F,
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
import { argsWGSL } from './shaders/args';
import { composeFragmentWGSL, composeVertexWGSL } from './shaders/compose';
import { orderScanWGSL, orderScatterWGSL } from './shaders/order';
import { CACHE_WORDS, CHUNK_SIZE, ORDER_BUCKETS, projectorWGSL } from './shaders/projector';
import { QUADS_PER_INSTANCE, rasterFragmentWGSL, rasterVertexWGSL } from './shaders/raster';
import { reduceL1WGSL, reduceL2WGSL } from './shaders/reduce';
import { taaFragmentWGSL, taaVertexWGSL } from './shaders/taa';
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
    /** Temporal accumulation of the stochastic samples (shaders/taa.ts). */
    taa: 'on' | 'off';
    /** Sample cap of the accumulation at rest: the history weight never drops below 1 / taaMax. */
    taaMax: number;
    /** Sample cap while the camera moves, so the history keeps up with the view. */
    taaMoveMax: number;
    /** Relative depth tolerance of the history test, plus 2 sigma of the pixel's depth distribution. */
    taaTol: number;
    /** Colour clamp while moving, in neighbourhood standard deviations (0 disables it). */
    taaClip: number;
    /** Consecutive out-of-distribution samples on one side that reset a pixel while moving; 0 disables the depth test. */
    taaRun: number;
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
};

const defaultVariant = (): Variant => ({
    spp: 'quad',
    compose: 'blend',
    cull: 'auto',
    order: 'bucket',
    contribution: 0,
    popless: 'on',
    taa: 'on',
    taaMax: 256,
    taaMoveMax: 16,
    taaTol: 0.02,
    taaClip: 1.25,
    taaRun: 0,
    taaFilter: 'cubic',
    taaReproj: 'sample',
    taaMotion: 4,
    taaDebug: 0,
    taaFlip: 0
});

const parseVariant = (text: string | undefined): Variant => {
    const variant = defaultVariant();
    for (const part of (text ?? '').split(',')) {
        const [key, value] = part.split(':').map((s) => s.trim());
        if (!key || value === undefined) continue;
        if (key === 'spp' && (value === '1' || value === 'quad')) variant.spp = value;
        if (key === 'compose' && (value === 'blend' || value === 'none' || value === 'depth')) variant.compose = value;
        if (key === 'popless' && (value === 'on' || value === 'off')) variant.popless = value;
        if (key === 'taa' && (value === 'on' || value === 'off')) variant.taa = value;
        if (key === 'taaMax' && Number.isFinite(Number(value))) variant.taaMax = Math.max(1, Number(value));
        if (key === 'taaMoveMax' && Number.isFinite(Number(value))) variant.taaMoveMax = Math.max(1, Number(value));
        if (key === 'taaTol' && Number.isFinite(Number(value))) variant.taaTol = Math.max(0, Number(value));
        if (key === 'taaDebug' && Number.isFinite(Number(value))) variant.taaDebug = Number(value);
        if (key === 'taaClip' && Number.isFinite(Number(value))) variant.taaClip = Math.max(0, Number(value));
        if (key === 'taaRun' && Number.isFinite(Number(value))) variant.taaRun = Math.max(0, Number(value));
        if (key === 'taaFilter' && (value === 'linear' || value === 'cubic')) variant.taaFilter = value;
        if (key === 'taaReproj' && (value === 'sample' || value === 'history')) variant.taaReproj = value;
        if (key === 'taaMotion' && Number.isFinite(Number(value))) variant.taaMotion = Math.max(0, Number(value));
        if (key === 'taaFlip' && Number.isFinite(Number(value))) variant.taaFlip = Number(value);
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
        private instances: MeshInstance[],
        name = 'sse-splat-raster'
    ) {
        super(device);
        this.name = name;
    }

    execute() {
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
    /** clip z = a * viewDepth + b over w = viewDepth, for the depth texture's values. */
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

    private rasterMesh: Mesh;

    private rasterMaterial: ShaderMaterial;

    private rasterInstance: MeshInstance;

    private rasterPass: SplatRasterPass;

    // taa: ping-pong history (premultiplied colour + coverage, and depth mean / variance /
    // count), resolved by a fullscreen pass after the raster
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

    private invViewProjection = new Mat4();

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

    // reduce the previous frame's depth into the two grid levels
    private reduceDepth(width: number, height: number) {
        const { device } = this;
        const x1 = Math.ceil(width / 8);
        const y1 = Math.ceil(height / 8);
        const x2 = Math.ceil(x1 / 4);
        const y2 = Math.ceil(y1 / 4);
        if (this.occBlocks.x1 !== x1 || this.occBlocks.y1 !== y1) {
            this.occL1.destroy();
            this.occL2.destroy();
            this.occL1 = new StorageBuffer(device, x1 * y1 * 4, BUFFERUSAGE_COPY_DST);
            this.occL2 = new StorageBuffer(device, x2 * y2 * 4, BUFFERUSAGE_COPY_DST);
            this.occBlocks = { x1, y1, x2, y2 };
        }
        const l1 = this.reduceL1;
        l1.setParameter('prevDepth', this.depthTexture);
        l1.setParameter('blockMax', this.occL1);
        l1.setParameter('width', width);
        l1.setParameter('height', height);
        l1.setParameter('blocksX', x1);
        l1.setParameter('blocksY', y1);
        l1.setupDispatch(x1, y1, 1);
        const l2 = this.reduceL2;
        l2.setParameter('level1', this.occL1);
        l2.setParameter('level2', this.occL2);
        l2.setParameter('blocksX1', x1);
        l2.setParameter('blocksY1', y1);
        l2.setParameter('blocksX2', x2);
        l2.setParameter('blocksY2', y2);
        Compute.calcDispatchSize(Math.ceil((x2 * y2) / 64), tmpVec2);
        l2.setupDispatch(tmpVec2.x, tmpVec2.y, 1);
        device.computeDispatch([l1], 'sse-splat-reduce1');
        device.computeDispatch([l2], 'sse-splat-reduce2');
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

        this.rasterPass = new SplatRasterPass(device, app.renderer as unknown as EngineForwardRenderer, camera, [
            this.rasterInstance
        ]);
        this.rasterPass.init(this.target);
        this.rasterPass.setClearColor(new Color(0, 0, 0, 0));
        this.rasterPass.setClearDepth(1);
        // nothing to draw, and no buffers bound, until the first populated frame
        this.rasterPass.enabled = false;

        // the taa resolve: a fullscreen pass from the raster target and the previous history
        // into the other history, sized with the target on its first frame
        for (let i = 0; i < 2; i++) {
            this.taaColor.push(
                new Texture(device, {
                    name: `sse-splat-taa-color-${i}`,
                    width: 4,
                    height: 4,
                    format: PIXELFORMAT_RGBA32F,
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
                    format: PIXELFORMAT_RGBA32F,
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
            attributes: { vertex_position: SEMANTIC_POSITION }
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

    /** Drop the temporal history; the next frame starts accumulating from its own sample. */
    resetHistory() {
        this.taaHistoryValid = false;
        this.restFrames = 0;
    }

    /** Re-read {@link variant} after a field changed. */
    applyVariant() {
        // a switch changes what the frames hold; an old history would leak into the new ones
        this.resetHistory();
        const quad = this.variant.spp === 'quad';
        this.rasterMaterial.setDefine('SSE_SPP_QUAD', quad ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_ORDERED', this.variant.order === 'bucket' ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_POPLESS', this.variant.popless === 'on' ? '' : undefined);
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
        this.composeInstance.visible = value && this.variant.compose !== 'none';
    }

    private attach() {
        const passes = this.camera.camera.beforePasses;
        if (!passes.includes(this.rasterPass)) passes.push(this.rasterPass);
        if (!passes.includes(this.taaPass)) passes.push(this.taaPass);
        this.worldLayer.addMeshInstances([this.composeInstance]);
        this.provider.setActive(true);
    }

    private detach() {
        const passes = this.camera.camera.beforePasses;
        for (const pass of [this.rasterPass, this.taaPass]) {
            const index = passes.indexOf(pass);
            if (index >= 0) passes.splice(index, 1);
        }
        this.taaHistoryValid = false;
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

        const view = cam.viewMatrix;
        const projection = cam.projectionMatrix;
        const isOrtho = cam.projection === PROJECTION_ORTHOGRAPHIC;
        // the clip z the raster shader reconstructs must match the engine's WebGPU depth range
        const shaderProjection = Camera.applyShaderProjectionTransform(projection, this.shaderProjection, false, true);
        this.viewProjection.mul2(shaderProjection, view);

        this.cullNodes(set, this.viewProjection);

        const focal = [Math.abs(projection.data[0]) * width * 0.5, Math.abs(projection.data[5]) * height * 0.5];
        const gsplat = this.app.scene.gsplat;

        // the moving-camera contribution cull: a raised threshold while the view changes, then
        // one more frame at the scene's threshold once it has stopped
        const moved = this.viewMoved(view);
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
        const taaOn =
            this.variant.taa === 'on' &&
            (!isQuery || (this.allowQueryTaa && width === this.taaWidth && height === this.taaHeight));
        if (taaOn) {
            if (this.taaWidth !== width || this.taaHeight !== height) {
                for (const texture of [...this.taaColor, ...this.taaInfo]) texture.resize(width, height);
                for (const target of this.taaTargets) target.resize(width, height);
                this.taaWidth = width;
                this.taaHeight = height;
                this.taaHistoryValid = false;
            }
            this.frameSeed = this.frameIndex++ >>> 0;
            if (moved || changed) this.restFrames = 0;
            else this.restFrames++;
            if (this.restFrames < this.variant.taaMax + 2) this.frameWanted = true;
        } else {
            this.frameSeed = this.userSeed;
            this.taaHistoryValid = false;
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
                const moved = this.viewMoved(view);
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
            this.reduceDepth(width, height);
        }

        this.counter.clear();
        const ordered = this.variant.order === 'bucket';
        if (ordered) this.orderBuckets.clear();
        // the order key spans the fitted clip range, log-spaced
        const logNear = Math.log(Math.max(cam.nearClip, 1e-6));
        const invLogRange = 1 / Math.max(Math.log(Math.max(cam.farClip, 1e-6)) - logNear, 1e-6);

        const cameraPosition = camera.entity.getPosition();
        const groups = this.source.dispatchPlan(set, this.numChunks);
        for (const group of groups) {
            // a file with no node in the frustum has nothing to dispatch
            if (group.fileIndex >= 0 && !this.anyNodeVisible(set.files[group.fileIndex].nodes)) continue;
            const projector = this.ensureProjector(culling, ordered, group);
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
            projector.setParameter('alphaClip', gsplat.alphaClipForward);
            projector.setParameter('minContribution', minContribution);
            projector.setParameter('occBlocksX1', this.occBlocks.x1);
            projector.setParameter('occBlocksY1', this.occBlocks.y1);
            projector.setParameter('occBlocksX2', this.occBlocks.x2);
            projector.setParameter('occBlocksY2', this.occBlocks.y2);
            projector.setParameter('occlusionMode', culling ? (cullMode === 'l1' ? 1 : 2) : 0);
            projector.setParameter('prevFlip', this.prevFlip);
            projector.setParameter('keyLogNear', logNear);
            projector.setParameter('keyInvLogRange', invLogRange);
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
        this.args.setParameter('indexCount', QUADS_PER_INSTANCE * 6);
        this.args.setParameter('quadsPerInstance', QUADS_PER_INSTANCE);
        this.args.setParameter('dispatchSlot', dispatchSlot);
        this.args.setParameter('scatterWorkgroupSize', ORDER_BUCKETS);
        this.args.setupDispatch(1, 1, 1);
        device.computeDispatch([this.args], 'sse-splat-args');
        this.rasterInstance.setIndirect(null, drawSlot, 1);

        if (ordered) {
            // bucket offsets, then every survivor claims its place in its bucket
            this.orderScan.setParameter('buckets', this.orderBuckets);
            this.orderScan.setupDispatch(1, 1, 1);
            device.computeDispatch([this.orderScan], 'sse-splat-order-scan');
            const scatter = this.orderScatter;
            scatter.setParameter('counter', this.counter);
            scatter.setParameter('cache', this.cacheBuffer!);
            scatter.setParameter('buckets', this.orderBuckets);
            scatter.setParameter('ordered', this.orderedBuffer!);
            scatter.setupIndirectDispatch(dispatchSlot);
            device.computeDispatch([scatter], 'sse-splat-order-scatter');
        }

        const material = this.rasterMaterial;
        material.setParameter('splatCache', this.cacheBuffer!);
        material.setParameter('splatCount', this.counter);
        if (ordered) material.setParameter('orderedSlots', this.orderedBuffer!);
        material.setParameter('viewportSize', [width, height, 2 / width, 2 / height]);
        // clip z is affine in view depth: z = -m22 * depth + m23 of the shader projection
        material.setParameter('clipZParams', [
            -shaderProjection.data[10],
            shaderProjection.data[14],
            isOrtho ? 1 : 0,
            0
        ]);
        material.setParameter('focalParams', [focal[0], focal[1], 0, 0]);
        material.setParameter('sseAlphaClip', gsplat.alphaClipForward);
        material.setParameter('frameSeed', this.frameSeed);

        this.taaPass.enabled = taaOn;
        if (taaOn) {
            const read = this.taaWrite ^ 1;
            const taa = this.taaMaterial;
            this.taaPrevViewProjection.copy(this.taaLastViewProjection);
            this.taaPrevView.copy(this.taaLastView);
            this.invViewProjection.copy(this.viewProjection).invert();
            taa.setParameter('curColor', this.colorTexture);
            taa.setParameter('curDepth', this.depthTexture);
            taa.setParameter('histColor', this.taaColor[read]);
            taa.setParameter('histInfo', this.taaInfo[read]);
            taa.setParameter('invViewProj', this.invViewProjection.data);
            taa.setParameter('prevViewProj', this.taaPrevViewProjection.data);
            taa.setParameter('prevView', this.taaPrevView.data);
            taa.setParameter('clipZParams', [
                -shaderProjection.data[10],
                shaderProjection.data[14],
                isOrtho ? 1 : 0,
                0
            ]);
            taa.setParameter('taaParams', [
                moved ? this.variant.taaMoveMax : this.variant.taaMax,
                this.variant.taaTol,
                this.taaHistoryValid ? 1 : 0,
                moved ? 1 : 0
            ]);
            taa.setParameter('taaViewport', [width, height, 1 / width, 1 / height]);
            taa.setParameter('taaControl', [
                this.variant.taaFlip || (this.target.flipY ? -1 : 1),
                this.variant.taaClip,
                this.variant.taaRun,
                this.variant.spp === 'quad' ? 1 : 0
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
            this.taaLastViewProjection.copy(this.viewProjection);
            this.taaLastView.copy(view);
            this.taaHistoryValid = true;
            this.taaWrite ^= 1;
        }

        // an offscreen target's rows run the other way to the backbuffer's on WebGPU
        const targetFlipY = rt ? rt.flipY : device.backBuffer.flipY;
        this.composeMaterial.setParameter('composeParams', [
            this.target.flipY !== targetFlipY ? 1 : 0,
            isOrtho ? 1 : 0,
            taaOn ? 1 : 0,
            0
        ]);
        this.composeMaterial.setParameter('depthViewParams', [
            -shaderProjection.data[10],
            shaderProjection.data[14],
            Math.max(cam.nearClip, 1e-4),
            Math.max(cam.farClip, cam.nearClip * 2)
        ]);

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
            clipZ: [-shaderProjection.data[10], shaderProjection.data[14]]
        };
        this.prevViewProjection.copy(this.viewProjection);
        this.prevView.copy(view);
        this.prevClipZ = [-shaderProjection.data[10], shaderProjection.data[14], isOrtho ? 1 : 0, 0];
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

    // whether the view differs from the previous on-screen frame's beyond float noise (the
    // camera controllers settle over many frames)
    private viewMoved(view: Mat4) {
        for (let i = 0; i < 16; i++) {
            if (Math.abs(view.data[i] - this.prevView.data[i]) > 1e-6) return true;
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
        this.orderedBuffer = new StorageBuffer(this.device, this.cacheSlots * 4);
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

    private ensureProjector(occlusion: boolean, ordered: boolean, group: DispatchGroup) {
        const sourceKey = this.source.shaderKey();
        if (this.projectorSourceKey !== sourceKey) {
            // a different source: every specialisation and the bind group format go
            this.destroyProjector();
            this.projectorSourceKey = sourceKey;
        }
        const key = `${occlusion ? 'occlusion' : 'plain'}-${ordered ? 'bucket' : 'append'}`;
        const computeKey = `${key}:${group.fileIndex}`;
        const existing = this.projectorComputes.get(computeKey);
        if (existing) return existing;
        const shader = this.ensureProjectorShader(key, occlusion, ordered);
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

    private ensureProjectorShader(key: string, occlusion: boolean, ordered: boolean) {
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
            cshader: projectorWGSL(this.source.readChunk(fixed.length), occlusion, ordered),
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
                    new UniformFormat('cameraPosition', UNIFORMTYPE_VEC4)
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
        for (const compute of [this.orderScan, this.orderScatter]) {
            compute.shader.destroy();
            compute.destroy();
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
        this.rasterMesh.destroy();
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

        this.composeInstance.destroy();
        this.composeMaterial.destroy();
        this.composeMesh.destroy();
    }
}

export { StochasticSplatRenderer };
export type { DepthFrame, StochasticRendererOptions, Variant };
