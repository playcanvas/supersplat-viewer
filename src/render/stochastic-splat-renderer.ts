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
//
// A view (SplatView) is what one image needs: its targets, history and projected splats. There is
// one for the camera, and in a stereo XR session one per eye: the compute projects every eye in
// the hook, and the engine replays the camera's passes once per eye, so the first of them binds
// that eye's view (device.xrCurrentViewIndex) before the raster, the accumulation and the compose
// draw.
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
    FramePass,
    Frustum,
    GraphNode,
    Mat4,
    Mesh,
    MeshInstance,
    FILTER_NEAREST,
    FUNC_ALWAYS,
    FUNC_LESS,
    PIXELFORMAT_DEPTH,
    PIXELFORMAT_R32U,
    PIXELFORMAT_RGBA16F,
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
    Vec2,
    Vec3
} from 'playcanvas';
import type { AppBase, CameraComponent, GraphicsDevice, Layer } from 'playcanvas';

import { captureCameraSnapshot, createPickCameraSnapshot } from '../picker';
import type { PickCameraSnapshot } from '../picker';

import { EngineResidentSetProvider } from './resident-set';
import type { EngineManager, ResidentSet } from './resident-set';
import { argsWGSL, setArgsWGSL } from './shaders/args';
import { composeFragmentWGSL, composeVertexWGSL } from './shaders/compose';
import { interleaveFragmentWGSL } from './shaders/interleave';
import { orderScanWGSL, orderScatterSetsWGSL, orderScatterWGSL } from './shaders/order';
import {
    CACHE_WORDS,
    CHUNK_SIZE,
    ORDER_BUCKETS,
    POLYGON_SIDES,
    SET_GROUPS,
    polygonScale,
    projectorWGSL
} from './shaders/projector';
import type { CoverageMode } from './shaders/projector';
import { FAR_CLIP_Z, QUADS_PER_INSTANCE, rasterFragmentWGSL, rasterVertexWGSL } from './shaders/raster';
import { reduceL1WGSL, reduceL2WGSL } from './shaders/reduce';
import { TAA_MAX_COUNT, taaFragmentWGSL, taaVertexWGSL } from './shaders/taa';
import { analyticWarpMap, buildWarpTable } from './shaders/warp';
import type { WarpMap } from './shaders/warp';
import type { DispatchGroup, SplatSource, SplatSourceKind } from './splat-source';
import { DirectSplatSource } from './splat-source-direct';
import { WorkBufferSplatSource } from './splat-source-workbuffer';
import { measureXrRateMaps, variableRate } from './xr-rate-map';
import type { GpuDevice, XrSubImage } from './xr-rate-map';

/** Experiment switches, all flippable at runtime; `?variant=key:value,key:value` seeds them. */
type Variant = {
    /** `depth` shows the splat depth as grey instead of composing the colour. */
    compose: 'blend' | 'depth';
    /**
     * Previous-frame occlusion cull: off, the 8 px grid only, both grid levels, or `auto`: both
     * levels, suspended for a while whenever a frame culled less than 8 % of its splats, since the
     * test then costs more than the raster it saves (large scenes seen from outside).
     */
    cull: 'off' | 'l1' | 'l2' | 'auto';
    /**
     * Contribution cull while the camera moves: splats whose alpha mass in pixels (opacity times
     * projected area) falls below this are skipped on moving frames, and a settled frame at the
     * scene's own threshold follows when the camera stops. 0 leaves the scene threshold alone.
     */
    contribution: number;
    /** Popless depth: every fragment gets the depth of the Gaussian's peak along its ray (paper 3.4). */
    popless: 'on' | 'off';
    /**
     * Where the coverage threshold varies: per pixel (a discarding fragment shader over the
     * whole quad), or per splat and frame, which makes the kept pixels a solid ellipse drawn as
     * a square with no discard (shaders/projector.ts); `interleaved` gives each of the four
     * pixels of a 2x2 quad its own threshold per splat, stratified, drawn as four interleaved
     * pixel sets that the accumulation reads directly (shaders/taa.ts), or that are copied back
     * without it (shaders/interleave.ts). All keep each pixel with probability alpha.
     */
    coverage: CoverageMode;
    /**
     * Jittered strata, with coverage other than pixel: 0 keeps one threshold per splat (or per
     * splat and pixel set); otherwise the per-splat threshold is the base of a random stratum
     * and every pixel adds its own jitter within the stratum in the fragment shader, which
     * discards where alpha falls below it. The pixels of one splat then disagree, as per-pixel
     * thresholds do, while the square stays the stratum's ellipse rather than the whole quad.
     * The value is the sub-strata each stratum splits into, 1 or 2: the jitter spans one, so 2
     * halves the rim that dithers and the squares' area with it, at some agreement. The pixel
     * sets take the four strata of [0, 1) in a random order per splat and frame; a per-splat
     * draw takes one of `strata`.
     */
    jitter: number;
    /** Strata a jittered per-splat threshold draws from (coverage:splat, and interleaveArea's small splats). */
    strata: number;
    /**
     * coverage:interleaved: splats whose footprint at the alpha clip covers fewer pixels than
     * this draw per splat into the full target instead of into the four pixel sets, one square
     * each rather than up to four (0: every splat into the sets). Small splats gain little from
     * the sets, since their blotch is a pixel or two anyway. The sets are then copied back
     * before the small splats draw over them, and the accumulation reads the full target.
     */
    interleaveArea: number;
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
    /** Depth the moving reprojection goes through: this frame's sample or the pixel's accumulated mean. */
    taaReproj: 'sample' | 'history';
    /** Image motion in pixels a frame that halves the moving sample cap (0: fixed cap). */
    taaMotion: number;
    /**
     * Count the image motion that shortens the moving cap for no more than the parallax, the
     * part the camera's translation adds: a rotation moves a pixel's layers alike, so it smears
     * nothing. A history nearer than the pixel's sample, which an occluder left behind, is cut
     * short by how far it is misplaced each frame ('off': the whole motion counts, no cut).
     */
    taaParallax: 'on' | 'off';
    /**
     * The history length at which the moving sample is half the pixel's own sample and half
     * the 2x2 quad mean; the own sample's share is count / (count + taaSharp), so a long
     * history, which carries the noise itself, keeps the detail (0: the quad mean).
     */
    taaSharp: number;
    /**
     * The history's colour format (shaders/taa.ts): 16-bit fixed point, whose long resting means
     * converge, or half floats, which filter, so the moving fetch takes five bilinear taps instead
     * of sixteen loads; `auto` gives the XR eyes half floats, since a head never rests.
     */
    taaHistory: 'auto' | 'fixed' | 'half';
    /** 1 shows the accumulation state (count, acceptance, sample) instead of the colour. */
    taaDebug: number;
    /**
     * Foveated target (shaders/warp.ts): `auto` renders each eye of a WebGPU XR session in the
     * layout of its own rasterization rate map where the browser draws at a variable rate (Apple
     * Vision Pro), measured when the session starts; `off` never warps; a number m > 1 warps every
     * view by the SuperSplat editor's function instead, m times the pixels per screen pixel at the
     * centre and 1 / m^2 at the edges, for trying it on a flat screen, where the picker then has no
     * depth frame.
     */
    warp: 'auto' | 'off' | number;
    /** Covariance units: true pixels, or the engine's doubled-focal convention (its dilation and culls scale with it). */
    units: 'px' | 'engine';
};

const defaultVariant = (): Variant => ({
    compose: 'blend',
    cull: 'auto',
    contribution: 0,
    popless: 'on',
    coverage: 'pixel',
    jitter: 0,
    strata: 4,
    interleaveArea: 0,
    taa: 'on',
    taaMax: 256,
    taaMoveMax: 16,
    taaClip: 1.25,
    taaReproj: 'sample',
    taaMotion: 4,
    taaParallax: 'on',
    taaSharp: 16,
    taaHistory: 'auto',
    taaDebug: 0,
    warp: 'auto',
    units: 'engine'
});

const taaCount = (value: number) => Math.min(TAA_MAX_COUNT, Math.max(1, Math.round(value)));

const parseVariant = (text: string | undefined): Variant => {
    const variant = defaultVariant();
    for (const part of (text ?? '').split(',')) {
        const [key, value] = part.split(':').map((s) => s.trim());
        if (!key || value === undefined) continue;
        if (key === 'compose' && (value === 'blend' || value === 'depth')) variant.compose = value;
        if (key === 'cull' && (value === 'off' || value === 'l1' || value === 'l2' || value === 'auto')) {
            variant.cull = value;
        }
        if (key === 'contribution' && Number.isFinite(Number(value))) variant.contribution = Math.max(0, Number(value));
        if (key === 'popless' && (value === 'on' || value === 'off')) variant.popless = value;
        if (key === 'coverage' && (value === 'pixel' || value === 'splat' || value === 'interleaved'))
            variant.coverage = value;
        if (key === 'jitter' && ['0', '1', '2'].includes(value)) variant.jitter = Number(value);
        if (key === 'strata' && ['1', '2', '4'].includes(value)) variant.strata = Number(value);
        if (key === 'interleaveArea' && Number.isFinite(Number(value)))
            variant.interleaveArea = Math.max(0, Number(value));
        if (key === 'taa' && (value === 'on' || value === 'off')) variant.taa = value;
        if (key === 'taaMax' && Number.isFinite(Number(value))) variant.taaMax = taaCount(Number(value));
        if (key === 'taaMoveMax' && Number.isFinite(Number(value))) variant.taaMoveMax = taaCount(Number(value));
        if (key === 'taaClip' && Number.isFinite(Number(value))) variant.taaClip = Math.max(0, Number(value));
        if (key === 'taaReproj' && (value === 'sample' || value === 'history')) variant.taaReproj = value;
        if (key === 'taaMotion' && Number.isFinite(Number(value))) variant.taaMotion = Math.max(0, Number(value));
        if (key === 'taaParallax' && (value === 'on' || value === 'off')) variant.taaParallax = value;
        if (key === 'taaSharp' && Number.isFinite(Number(value))) variant.taaSharp = Math.max(0, Number(value));
        if (key === 'taaHistory' && (value === 'auto' || value === 'fixed' || value === 'half'))
            variant.taaHistory = value;
        if (key === 'taaDebug' && Number.isFinite(Number(value))) variant.taaDebug = Number(value);
        if (key === 'warp' && (value === 'auto' || value === 'off')) variant.warp = value;
        if (key === 'warp' && Number(value) > 1) variant.warp = Number(value);
        if (key === 'units' && (value === 'px' || value === 'engine')) variant.units = value;
    }
    return variant;
};

// The switches each mode starts from, before `variant` applies its own: per-pixel coverage (the
// defaults) for quality, and for phones and headsets the interleaved pixel sets with jittered
// strata, small splats drawn per splat and no colour clamp, the fastest at that quality on a Mali
// phone (docs/mobile-gpu-splat-rendering.md)
const MODE_VARIANTS = {
    pixel: '',
    mobile: 'coverage:interleaved,jitter:2,interleaveArea:256,taaClip:0'
};

type StochasticMode = keyof typeof MODE_VARIANTS;

type StochasticRendererOptions = {
    source?: SplatSourceKind;
    mode?: StochasticMode;
    variant?: string;
};

// the engine internals this file drives directly
type EngineDevice = GraphicsDevice & {
    // the eye the engine is replaying the camera's passes for in a stereo session (WebGPU), else -1
    xrCurrentViewIndex?: number;
    // the eyes' sub-images of the XR frame being rendered (WebGPU), and the device behind it all
    xrSubImages?: XrSubImage[];
    wgpu?: GpuDevice;
    computeDispatch(computes: Compute[], name: string): void;
    getIndirectDrawSlot(count?: number): number;
    indirectDrawBuffer: StorageBuffer;
    getIndirectDispatchSlot(count?: number): number;
    indirectDispatchBuffer: StorageBuffer;
};

// an XR view's matrices, as the engine keeps them per eye (RenderView)
type XrViewMatrices = {
    viewOffMat: Mat4;
    projMat: Mat4;
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
        // the camera to draw with: an XR camera would set each eye's viewport on these targets
        private camera: () => Camera,
        public instances: MeshInstance[],
        name = 'sse-splat-raster'
    ) {
        super(device);
        this.name = name;
    }

    execute() {
        this.forward.renderForwardLayer(this.camera(), this.renderTarget, null, undefined, SHADER_FORWARD, {
            meshInstances: this.instances
        });
    }
}

// First among the camera's passes: binds the view the passes after it draw, the eye the engine is
// replaying them for in a stereo session
class SplatBindPass extends FramePass {
    constructor(
        device: GraphicsDevice,
        private bind: () => void
    ) {
        super(device);
        this.name = 'sse-splat-bind';
    }

    execute() {
        this.bind();
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

// coverage other than pixel: a polygon per splat on the unit circle (POLYGON_SIDES corners),
// fanned from its first vertex
const createPolygonMesh = (device: GraphicsDevice, polygons: number) => {
    const sides = POLYGON_SIDES;
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

const tmpVec3 = new Vec3();

// the shaders a view's computes share
type ViewShaders = {
    args: Shader;
    orderScan: Shader;
    orderScatter: Shader;
    orderScatterSets: Shader;
    setArgs: Shader;
    reduceL1: Shader;
    reduceL2: Shader;
};

// a target texture sized per frame; depth textures keep the engine's default filtering
const createViewTexture = (device: GraphicsDevice, name: string, format: number, filter?: number) =>
    new Texture(device, {
        name,
        width: 4,
        height: 4,
        format,
        mipmaps: false,
        ...(filter !== undefined ? { minFilter: filter, magFilter: filter } : {}),
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });

// Everything one image needs and remembers: the camera's, or one eye's in a stereo session. A
// compute owns the uniform buffer its dispatch reads, so each view dispatches its own.
class SplatView {
    // the raster target: colour, and a depth texture the compose, the occlusion cull and the
    // picker read
    readonly colorTexture: Texture;

    readonly depthTexture: Texture;

    readonly target: RenderTarget;

    // variant coverage:interleaved: each pixel set's colour and depth, and its target
    readonly setTextures: Texture[] = [];

    readonly setTargets: RenderTarget[] = [];

    // taa: ping-pong history (premultiplied colour + coverage as unorm16 or half floats, and the
    // depth mean and sample count packed in 32 bits; shaders/taa.ts), sized with the target on the
    // first accumulating frame, and shrunk back while taa is off
    readonly taaColor: Texture[] = [];

    // whether the colour is in half floats (variant taaHistory)
    taaHalf = false;

    readonly taaInfo: Texture[] = [];

    readonly taaTargets: RenderTarget[] = [];

    // variant coverage:interleaved with taa: history targets with the raster's depth texture
    // attached (made per size: a resize rebuilds the textures their views point at)
    taaSetTargets: RenderTarget[] = [];

    taaWrite = 0;

    // whether the history holds the previous on-screen frame at the current size
    taaHistoryValid = false;

    taaWidth = 0;

    taaHeight = 0;

    // the previous taa frame's matrices as the pass reads them, and this frame's, copied over at
    // the start of the next frame: the material holds the data arrays by reference and uploads
    // them when it draws, after the hook has run
    readonly taaPrevViewProjection = new Mat4();

    readonly taaPrevView = new Mat4();

    readonly taaLastViewProjection = new Mat4();

    readonly taaLastView = new Mat4();

    // the view's world transform, for the accumulation's reprojection
    readonly cameraWorld = new Mat4();

    // frames since the view or the scene last changed, for converging at rest
    restFrames = 0;

    // the occlusion grid: farthest depth per 8 px block (level 1) and per 32 px block (level 2)
    occL1: StorageBuffer;

    occL2: StorageBuffer;

    occBlocks = { x1: 0, y1: 0, x2: 0, y2: 0 };

    readonly reduceL1: Compute;

    readonly reduceL2: Compute;

    // the previous frame the grid and the reprojection describe; valid only when that frame
    // rendered to the same target at the same size from the same world state
    prevValid = false;

    readonly prevViewProjection = new Mat4();

    readonly prevView = new Mat4();

    readonly prevProjection = new Mat4();

    prevClipZ = [0, 0, 0, 0];

    prevViewport = [0, 0];

    prevFocal = [0, 0];

    prevFlip = 1;

    prevWidth = 0;

    prevHeight = 0;

    prevVersion = -1;

    prevOrtho = false;

    // this frame's projection, and the splats it projected
    readonly shaderProjection = new Mat4();

    readonly viewProjection = new Mat4();

    nodeVisibleData = new Uint32Array(0);

    nodeVisibleBuffer: StorageBuffer | null = null;

    cacheBuffer: StorageBuffer | null = null;

    cacheSlots = 0;

    readonly counter: StorageBuffer;

    // the draw order (shaders/order.ts): bucket counts then offsets, and the ordered slot list
    readonly orderBuckets: StorageBuffer;

    orderedBuffer: StorageBuffer | null = null;

    // entries the ordered list holds: a survivor takes one, or one per pixel set it keeps
    orderedCapacity = 0;

    readonly setRanges: StorageBuffer;

    // one projector compute per shader and dispatch group (per-file sources dispatch per file)
    readonly projectorComputes = new Map<string, Compute>();

    readonly args: Compute;

    readonly orderScan: Compute;

    readonly orderScatter: Compute;

    readonly orderScatterSets: Compute;

    readonly setArgs: Compute;

    // what the passes read for this view, recorded by the frame and applied by the bind pass
    readonly bindings: (() => void)[] = [];

    // variant warp: the table the view renders through (shaders/warp.ts), a placeholder while it
    // renders unwarped, what the table holds ('' for nothing) and the target it lays out
    warpBuffer: StorageBuffer;

    warpKey = '';

    warpWidth = 0;

    warpHeight = 0;

    constructor(
        private device: GraphicsDevice,
        shaders: ViewShaders,
        private suffix: string
    ) {
        this.colorTexture = createViewTexture(device, `sse-splat-color${suffix}`, PIXELFORMAT_RGBA8, FILTER_LINEAR);
        this.depthTexture = createViewTexture(device, `sse-splat-depth${suffix}`, PIXELFORMAT_DEPTH);
        this.target = new RenderTarget({
            name: `sse-splat-target${suffix}`,
            colorBuffer: this.colorTexture,
            depthBuffer: this.depthTexture,
            samples: 1
        });
        for (let i = 0; i < 4; i++) {
            // the taa's quad mean fetches the colour bilinearly
            const color = createViewTexture(
                device,
                `sse-splat-set-${i}-color${suffix}`,
                PIXELFORMAT_RGBA8,
                FILTER_LINEAR
            );
            const depth = createViewTexture(device, `sse-splat-set-${i}-depth${suffix}`, PIXELFORMAT_DEPTH);
            this.setTextures.push(color, depth);
            this.setTargets.push(
                new RenderTarget({
                    name: `sse-splat-set-${i}${suffix}`,
                    colorBuffer: color,
                    depthBuffer: depth,
                    samples: 1
                })
            );
        }
        for (let i = 0; i < 2; i++) {
            this.taaInfo.push(
                createViewTexture(device, `sse-splat-taa-info-${i}${suffix}`, PIXELFORMAT_R32U, FILTER_NEAREST)
            );
        }
        this.createHistoryColor();
        this.occL1 = new StorageBuffer(device, 4, BUFFERUSAGE_COPY_DST);
        this.occL2 = new StorageBuffer(device, 4, BUFFERUSAGE_COPY_DST);
        this.reduceL1 = new Compute(device, shaders.reduceL1, 'sse-splat-reduce1');
        this.reduceL2 = new Compute(device, shaders.reduceL2, 'sse-splat-reduce2');
        this.counter = new StorageBuffer(device, 16, BUFFERUSAGE_COPY_DST | BUFFERUSAGE_COPY_SRC);
        this.orderBuckets = new StorageBuffer(device, 2 * ORDER_BUCKETS * 4, BUFFERUSAGE_COPY_DST);
        this.setRanges = new StorageBuffer(device, SET_GROUPS * 8);
        this.args = new Compute(device, shaders.args, 'sse-splat-args');
        this.orderScan = new Compute(device, shaders.orderScan, 'sse-splat-order-scan');
        this.orderScatter = new Compute(device, shaders.orderScatter, 'sse-splat-order-scatter');
        this.orderScatterSets = new Compute(device, shaders.orderScatterSets, 'sse-splat-order-scatter');
        this.setArgs = new Compute(device, shaders.setArgs, 'sse-splat-set-args');
        this.warpBuffer = new StorageBuffer(device, 16, BUFFERUSAGE_COPY_DST);
    }

    // the history's colour textures in the current format, and the targets they make with the
    // depth records; the half floats filter, for the moving fetch's bilinear taps
    private createHistoryColor() {
        const format = this.taaHalf ? PIXELFORMAT_RGBA16F : PIXELFORMAT_RGBA16U;
        const filter = this.taaHalf ? FILTER_LINEAR : FILTER_NEAREST;
        for (let i = 0; i < 2; i++) {
            this.taaColor.push(
                createViewTexture(this.device, `sse-splat-taa-color-${i}${this.suffix}`, format, filter)
            );
            this.taaTargets.push(
                new RenderTarget({
                    name: `sse-splat-taa-${i}${this.suffix}`,
                    colorBuffers: [this.taaColor[i], this.taaInfo[i]],
                    depth: false,
                    samples: 1
                })
            );
        }
    }

    // switch the history's colour format; the history starts over, sized on the next frame
    setTaaHalf(half: boolean) {
        this.releaseTaaSetTargets();
        for (const target of this.taaTargets) target.destroy();
        for (const texture of this.taaColor) texture.destroy();
        this.taaTargets.length = 0;
        this.taaColor.length = 0;
        this.taaHalf = half;
        this.createHistoryColor();
        for (const texture of this.taaInfo) texture.resize(4, 4);
        this.taaWidth = 0;
        this.taaHeight = 0;
        this.taaHistoryValid = false;
        this.restFrames = 0;
    }

    // render through a warp's table from now on, or unwarped (null)
    setWarp(key: string, map: WarpMap | null) {
        const table = map ? buildWarpTable(map) : null;
        const bytes = table ? table.byteLength : 16;
        if (this.warpBuffer.byteSize !== bytes) {
            this.warpBuffer.destroy();
            this.warpBuffer = new StorageBuffer(this.device, bytes, BUFFERUSAGE_COPY_DST);
        }
        if (table) this.warpBuffer.write(0, table, 0, table.length);
        this.warpKey = key;
        this.warpWidth = map ? map.width : 0;
        this.warpHeight = map ? map.height : 0;
        // a history or a previous frame laid out otherwise would be read in the wrong places
        this.taaHistoryValid = false;
        this.restFrames = 0;
        this.prevValid = false;
    }

    get gpuBytes() {
        let bytes = 0;
        const buffers = [
            this.nodeVisibleBuffer,
            this.cacheBuffer,
            this.orderedBuffer,
            this.counter,
            this.orderBuckets,
            this.warpBuffer
        ];
        for (const buffer of [...buffers, this.occL1, this.occL2]) bytes += buffer?.byteSize ?? 0;
        bytes += this.colorTexture.gpuSize + this.depthTexture.gpuSize;
        for (const texture of [...this.taaColor, ...this.taaInfo]) bytes += texture.gpuSize;
        return bytes;
    }

    // the targets only, not the textures they share
    releaseTaaSetTargets() {
        for (const target of this.taaSetTargets) target.destroy();
        this.taaSetTargets.length = 0;
    }

    destroyProjectorComputes() {
        for (const compute of this.projectorComputes.values()) compute.destroy();
        this.projectorComputes.clear();
    }

    destroy() {
        this.destroyProjectorComputes();
        for (const compute of [this.args, this.orderScan, this.orderScatter, this.orderScatterSets, this.setArgs])
            compute.destroy();
        for (const compute of [this.reduceL1, this.reduceL2]) compute.destroy();
        for (const buffer of [this.occL1, this.occL2, this.counter, this.orderBuckets, this.setRanges, this.warpBuffer])
            buffer.destroy();
        this.orderedBuffer?.destroy();
        this.cacheBuffer?.destroy();
        this.nodeVisibleBuffer?.destroy();
        this.orderedBuffer = this.cacheBuffer = this.nodeVisibleBuffer = null;
        this.releaseTaaSetTargets();
        for (const target of [...this.taaTargets, ...this.setTargets, this.target]) target.destroy();
        for (const texture of [...this.taaColor, ...this.taaInfo, ...this.setTextures]) texture.destroy();
        this.colorTexture.destroy();
        this.depthTexture.destroy();
    }
}

class StochasticSplatRenderer {
    readonly variant: Variant;

    /** The mode's switches, which setVariant's string applies over. */
    private readonly modeVariant: string;

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

    // the camera's view, and a second eye's while a stereo session runs
    private views: SplatView[];

    private viewShaders: ViewShaders;

    // whether this frame draws one view per eye of an XR session
    private stereo = false;

    // what the renderer's own passes draw with in a stereo session: the XR camera would set each
    // eye's viewport on their targets
    private passCamera: Camera;

    private bindPass: SplatBindPass;

    // compute
    // one projector shader per source and occlusion / coverage specialisation: the test's code
    // costs a little even when a uniform disables it, so a disabled or suspended cull runs
    // without it (each view keeps its own computes of them)
    private projectorShaders = new Map<string, Shader>();

    private projectorBindGroupFormat: BindGroupFormat | null = null;

    private projectorSourceKey = '';

    private argsBindGroupFormat: BindGroupFormat;

    private orderFormats: BindGroupFormat[] = [];

    private reduceFormats: BindGroupFormat[] = [];

    // the allocations resident when the previous frame drew, and whether any of them has gone
    // since: only a removed splat can make the previous depth wrong (it may have hidden what is
    // now behind it), so arrivals leave the cull on while a scene streams in
    private residentAllocIds = new Set<number>();

    private nodesRemoved = false;

    /** Whether the last frame ran the occlusion cull, for the debug panel and the harness. */
    culling = false;

    /** Whether cull:auto currently has the test switched off for culling too little. */
    get cullSuspended() {
        return this.variant.cull === 'auto' && (!this.cullActive || this.cullSuspendedFrames > 0);
    }

    // cull:auto bookkeeping. The last decision holds while a readback is in flight: while the
    // test is active every culled frame's counts are read back and a poor one suspends it;
    // while suspended the frames count down, then one probe frame runs the test and the rest
    // wait for its counts. The camera's view (the first eye's in stereo) decides for all
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
    private rasterMesh: Mesh;

    // coverage other than pixel: a square per splat, turned per frame or circumscribing the
    // jittered stratum's ellipse (shaders/raster.ts)
    private polygonMesh: Mesh;

    // variant coverage:interleaved: each pixel set's raster pass and draw (their targets are the
    // view's), and the copy back into the full target when taa is off or small splats draw over
    // them. (One target with a quadrant and viewport per set, in one pass, measured 1 ms slower on
    // the Pixel 7 Pro: the passes are not what the sets cost, their triangles are.)
    private setPasses: SplatRasterPass[] = [];

    private setInstances: MeshInstance[] = [];

    private interleaveMaterial: ShaderMaterial;

    private interleaveInstance: MeshInstance;

    private rasterMaterial: ShaderMaterial;

    private rasterInstance: MeshInstance;

    private rasterPass: SplatRasterPass;

    // taa: the resolve, a fullscreen pass from the raster target and the view's previous history
    // into its other history
    private taaMesh: Mesh;

    private taaMaterial: ShaderMaterial;

    private taaInstance: MeshInstance;

    // variant coverage:interleaved with taa: the same resolve reading the pixel sets' targets,
    // writing their depth into the full target's
    private taaSetMaterial: ShaderMaterial;

    private taaSetInstance: MeshInstance;

    // the two with a half-float history (variant taaHistory)
    private taaHalfMaterial: ShaderMaterial;

    private taaSetHalfMaterial: ShaderMaterial;

    // whether this frame's taa reads the pixel sets (and the raster pass draws nothing)
    private setsFolded = false;

    // whether the taa pass and its instances, and the compose, are set up for a half-float history
    private taaPassHalf = false;

    private composeHalf = false;

    // variant warp:auto: the eyes' rate maps in a WebGPU XR session, measured at the end of its
    // first frame (xr-rate-map.ts); null until then, and for a session without them
    private rateMaps: WarpMap[] | null = null;

    private rateMapState: 'idle' | 'wanted' | 'measuring' | 'done' = 'idle';

    // bumped as a session ends, so a measurement that resolves after it is dropped
    private rateMapSession = 0;

    // whether the taa and compose shaders are built to warp (SSE_WARP)
    private warpDefined = false;

    private destroyed = false;

    private taaPass: SplatRasterPass;

    /** The frame the depth texture holds, null while it holds a capture's or nothing. */
    depthFrame: DepthFrame | null = null;

    private depthFrameCount = 0;

    private depthFrameCamera = createPickCameraSnapshot();

    // a frame requested from inside the render: the engine clears app.renderNextFrame right
    // after render(), so the request is applied on frameend instead
    private frameWanted = false;

    private onFrameEnd = () => {
        this.source.frameEnd();
        if (this.rateMapState === 'wanted') this.measureRateMaps();
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

    private frameSeed = 0;

    private ready = false;

    /** The renderer's depth texture: the nearest surviving sample per pixel of `depthFrame`. */
    get frameDepthTexture() {
        return this.views[0].depthTexture;
    }

    /** The camera view's projected splats and their draw order, for the bench harness. */
    get cacheBuffer() {
        return this.views[0].cacheBuffer;
    }

    get orderedBuffer() {
        return this.views[0].orderedBuffer;
    }

    get cacheSlots() {
        return this.views[0].cacheSlots;
    }

    /** Byte sizes of the buffers this renderer owns, for the bench harness and the debug panel. */
    get gpuBytes() {
        let bytes = this.chunkBuffer?.byteSize ?? 0;
        for (const view of this.views) bytes += view.gpuBytes;
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
        await this.views[0].counter.read(0, 8, data, true);
        return { survivors: data[0], occluded: data[1] };
    }

    // the occlusion grid's two levels at this size
    private ensureOccGrid(view: SplatView, width: number, height: number) {
        const x1 = Math.ceil(width / 8);
        const y1 = Math.ceil(height / 8);
        const x2 = Math.ceil(x1 / 4);
        const y2 = Math.ceil(y1 / 4);
        if (view.occBlocks.x1 !== x1 || view.occBlocks.y1 !== y1) {
            view.occL1.destroy();
            view.occL2.destroy();
            view.occL1 = new StorageBuffer(this.device, x1 * y1 * 4, BUFFERUSAGE_COPY_DST);
            view.occL2 = new StorageBuffer(this.device, x2 * y2 * 4, BUFFERUSAGE_COPY_DST);
            view.occBlocks = { x1, y1, x2, y2 };
        }
    }

    // level 2 from level 1
    private reduceLevel2(view: SplatView) {
        const { x1, y1, x2, y2 } = view.occBlocks;
        const l2 = view.reduceL2;
        l2.setParameter('level1', view.occL1);
        l2.setParameter('level2', view.occL2);
        l2.setParameter('blocksX1', x1);
        l2.setParameter('blocksY1', y1);
        l2.setParameter('blocksX2', x2);
        l2.setParameter('blocksY2', y2);
        Compute.calcDispatchSize(Math.ceil((x2 * y2) / 64), tmpVec2);
        l2.setupDispatch(tmpVec2.x, tmpVec2.y, 1);
        this.device.computeDispatch([l2], 'sse-splat-reduce2');
    }

    // reduce the view's previous depth into the two grid levels
    private reduceDepth(view: SplatView, width: number, height: number) {
        const { device } = this;
        this.ensureOccGrid(view, width, height);
        const { x1, y1 } = view.occBlocks;
        const l1 = view.reduceL1;
        l1.setParameter('prevDepth', view.depthTexture);
        l1.setParameter('blockMax', view.occL1);
        l1.setParameter('width', width);
        l1.setParameter('height', height);
        l1.setParameter('blocksX', x1);
        l1.setParameter('blocksY', y1);
        l1.setupDispatch(x1, y1, 1);
        device.computeDispatch([l1], 'sse-splat-reduce1');
        this.reduceLevel2(view);
    }

    /** Survivors of the last frame's projection are only known to the gpu; this is the resident count. */
    activeSplats = 0;

    constructor(app: AppBase, camera: CameraComponent, worldLayer: Layer, options: StochasticRendererOptions = {}) {
        this.app = app;
        this.device = app.graphicsDevice as EngineDevice;
        this.camera = camera;
        this.worldLayer = worldLayer;
        this.modeVariant = MODE_VARIANTS[options.mode ?? 'pixel'];
        this.variant = parseVariant(`${this.modeVariant},${options.variant ?? ''}`);

        const { device } = this;
        this.passCamera = new Camera(device);
        this.passCamera.node = camera.entity;

        this.source = options.source === 'workbuffer' ? new WorkBufferSplatSource() : new DirectSplatSource(device);

        // indirect draw arguments
        this.argsBindGroupFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('indirectDrawArgs', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('indirectDispatchArgs', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        const args = new Shader(device, {
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
        });

        // the ordering passes
        const scanFormat = new BindGroupFormat(device, [new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE)]);
        const scatterFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('counter', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('cache', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('ordered', SHADERSTAGE_COMPUTE)
        ]);
        const setArgsFormat = new BindGroupFormat(device, [
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE, true),
            new BindStorageBufferFormat('indirectDrawArgs', SHADERSTAGE_COMPUTE),
            new BindStorageBufferFormat('setRanges', SHADERSTAGE_COMPUTE),
            new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE)
        ]);
        this.orderFormats = [scanFormat, scatterFormat, setArgsFormat];
        const orderScan = new Shader(device, {
            name: 'sse-splat-order-scan',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: orderScanWGSL,
            computeBindGroupFormat: scanFormat
        });
        const orderScatter = new Shader(device, {
            name: 'sse-splat-order-scatter',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: orderScatterWGSL,
            computeBindGroupFormat: scatterFormat
        });
        const orderScatterSets = new Shader(device, {
            name: 'sse-splat-order-scatter-sets',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: orderScatterSetsWGSL,
            computeBindGroupFormat: scatterFormat
        });
        const setArgs = new Shader(device, {
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
        });

        // the occlusion grid's two reduce passes
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
        const reduceL1 = new Shader(device, {
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
        });
        const reduceL2 = new Shader(device, {
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
        });
        this.viewShaders = { args, orderScan, orderScatter, orderScatterSets, setArgs, reduceL1, reduceL2 };
        this.views = [new SplatView(device, this.viewShaders, '')];
        const view = this.views[0];

        // the renderer's own passes draw with the camera, or in a stereo session with a camera of
        // its own at the same node
        const passCamera = () => (this.stereo ? this.passCamera : camera.camera);
        const forward = app.renderer as unknown as EngineForwardRenderer;

        this.rasterMesh = createQuadMesh(device, QUADS_PER_INSTANCE);
        this.polygonMesh = createPolygonMesh(device, QUADS_PER_INSTANCE);
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

        this.rasterPass = new SplatRasterPass(device, forward, passCamera, [this.rasterInstance]);
        this.rasterPass.init(view.target);
        this.rasterPass.setClearColor(new Color(0, 0, 0, 0));
        this.rasterPass.setClearDepth(1);
        // nothing to draw, and no buffers bound, until the first populated frame
        this.rasterPass.enabled = false;

        // variant coverage:interleaved: a pass and draw per pixel set into the view's set targets,
        // sized per frame
        for (let i = 0; i < 4; i++) {
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
            const pass = new SplatRasterPass(device, forward, passCamera, [instance], `sse-splat-raster-set-${i}`);
            pass.init(view.setTargets[i]);
            pass.setClearColor(new Color(0, 0, 0, 0));
            pass.setClearDepth(1);
            pass.enabled = false;
            this.setPasses.push(pass);
        }
        // the copy back: drawn by the raster pass in place of the splats (after the small splats
        // of variant interleaveArea, depth-tested against them: a frag_depth draw first in the
        // pass would cost the small splats their early depth rejection)
        this.interleaveMaterial = new ShaderMaterial({
            uniqueName: 'sse-splat-interleave',
            vertexWGSL: taaVertexWGSL,
            fragmentWGSL: interleaveFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.interleaveMaterial.blendType = BLEND_NONE;
        this.interleaveMaterial.depthWrite = true;
        this.interleaveMaterial.depthTest = true;
        this.interleaveMaterial.depthFunc = FUNC_LESS;
        this.interleaveMaterial.cull = CULLFACE_NONE;
        this.interleaveInstance = new MeshInstance(
            createFullscreenMesh(device),
            this.interleaveMaterial,
            new GraphNode('sse-splat-interleave')
        );
        this.interleaveInstance.cull = false;
        this.interleaveInstance.castShadow = false;
        this.interleaveInstance.receiveShadow = false;

        // the taa resolve: a fullscreen pass from the raster target and the view's previous
        // history into its other history
        this.taaMesh = createFullscreenMesh(device);
        // One material per history format (variant taaHistory), whose outputs differ. Variant
        // coverage:interleaved's reads the pixel sets' targets and writes their depth into the full
        // target's, so no pass copies the sets back
        const taaMaterial = (name: string, sets: boolean, half: boolean) => {
            const material = new ShaderMaterial({
                uniqueName: name,
                vertexWGSL: taaVertexWGSL,
                fragmentWGSL: taaFragmentWGSL,
                attributes: { vertex_position: SEMANTIC_POSITION },
                fragmentOutputTypes: [half ? 'vec4' : 'uvec4', 'uint']
            });
            if (sets) material.setDefine('SSE_SETS', '');
            if (half) material.setDefine('SSE_TAA_HALF', '');
            material.blendType = BLEND_NONE;
            material.depthWrite = sets;
            material.depthTest = sets;
            if (sets) material.depthFunc = FUNC_ALWAYS;
            material.cull = CULLFACE_NONE;
            return material;
        };
        this.taaMaterial = taaMaterial('sse-splat-taa', false, false);
        this.taaSetMaterial = taaMaterial('sse-splat-taa-sets', true, false);
        this.taaHalfMaterial = taaMaterial('sse-splat-taa-half', false, true);
        this.taaSetHalfMaterial = taaMaterial('sse-splat-taa-sets-half', true, true);
        this.taaInstance = new MeshInstance(this.taaMesh, this.taaMaterial, new GraphNode('sse-splat-taa'));
        this.taaInstance.cull = false;
        this.taaInstance.castShadow = false;
        this.taaInstance.receiveShadow = false;
        this.bindSetTextures(view);
        for (const material of [this.taaSetMaterial, this.taaSetHalfMaterial]) material.update();
        this.taaSetInstance = new MeshInstance(this.taaMesh, this.taaSetMaterial, new GraphNode('sse-splat-taa-sets'));
        this.taaSetInstance.cull = false;
        this.taaSetInstance.castShadow = false;
        this.taaSetInstance.receiveShadow = false;
        this.taaPass = new SplatRasterPass(device, forward, passCamera, [this.taaInstance], 'sse-splat-taa');
        this.initTaaPass(view.taaTargets[0]);
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
        this.composeMaterial.setParameter('splatColor', view.colorTexture);
        this.composeMaterial.setParameter('splatDepth', view.depthTexture);
        // always bound, even while taa is off: a declared texture without a value makes the
        // engine create and upload a placeholder inside the forward pass, which submits the
        // command buffer mid-pass on WebGPU
        this.composeMaterial.setParameter('taaColor', view.taaColor[0]);
        this.composeMaterial.setParameter('taaInfo', view.taaInfo[0]);
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

        this.bindPass = new SplatBindPass(device, () => this.bindView());

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

    /** Replace the experiment switches from a `key:value,key:value` string (unset keys reset to the mode's). */
    setVariant(text: string) {
        Object.assign(this.variant, parseVariant(`${this.modeVariant},${text}`));
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
        for (const view of this.views) {
            view.taaHistoryValid = false;
            view.restFrames = 0;
        }
        this.frameIndex = 0;
    }

    /** Re-read {@link variant} after a field changed. */
    applyVariant() {
        // a switch changes what the frames hold; an old history would leak into the new ones
        this.resetHistory();
        this.rasterMaterial.setDefine('SSE_POPLESS', this.variant.popless === 'on' ? '' : undefined);
        const splatCoverage = this.variant.coverage !== 'pixel';
        this.rasterMaterial.setDefine('SSE_COVERAGE_SPLAT', splatCoverage ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_INTERLEAVED', this.variant.coverage === 'interleaved' ? '' : undefined);
        this.rasterInstance.mesh = splatCoverage ? this.polygonMesh : this.rasterMesh;
        // variant jitter: the square contains the ellipse and the fragments discard outside it,
        // so it needs no turning; the pixel sets draw from four strata, a per-splat draw from
        // `strata` (the full target's instance also serves as the interleaved mode's group 4)
        const { jitter, strata } = this.variant;
        const jittered = splatCoverage && jitter > 0;
        this.rasterMaterial.setDefine('SSE_JITTER', jittered ? '' : undefined);
        this.rasterMaterial.setDefine('SSE_POLYGON_ROTATE', splatCoverage && !jittered ? '' : undefined);
        const scale = Number(polygonScale(jitter > 0));
        const subs = Math.max(jitter, 1);
        for (const instance of this.setInstances)
            instance.setParameter('jitterParams', [jitter, 4, 1 / (4 * subs), scale]);
        this.rasterInstance.setParameter('jitterParams', [jitter, strata, 1 / (strata * subs), scale]);
        this.rasterInstance.setParameter('setIndex', 4);
        this.rasterInstance.setParameter('setMap', [1, 0, 1, 0]);
        this.composeMaterial.setDefine('SSE_SHOW_DEPTH', this.variant.compose === 'depth' ? '' : undefined);
        this.rasterMaterial.update();
        this.composeMaterial.update();
        this.setReady(this.ready);
        this.app.renderNextFrame = true;
    }

    // the raster pass and the compose only run once a frame has bound the buffers they read
    private setReady(value: boolean) {
        this.ready = value;
        this.rasterPass.enabled = value && !this.setsFolded;
        for (const pass of this.setPasses) pass.enabled = value && this.variant.coverage === 'interleaved';
        this.composeInstance.visible = value;
    }

    private attach() {
        const passes = this.camera.camera.beforePasses;
        // the bind pass first: the passes after it draw the view it binds
        if (!passes.includes(this.bindPass)) passes.push(this.bindPass);
        for (const pass of this.setPasses) if (!passes.includes(pass)) passes.push(pass);
        if (!passes.includes(this.rasterPass)) passes.push(this.rasterPass);
        if (!passes.includes(this.taaPass)) passes.push(this.taaPass);
        this.worldLayer.addMeshInstances([this.composeInstance]);
        this.provider.setActive(true);
    }

    private detach() {
        const passes = this.camera.camera.beforePasses;
        for (const pass of [this.bindPass, ...this.setPasses, this.rasterPass, this.taaPass]) {
            const index = passes.indexOf(pass);
            if (index >= 0) passes.splice(index, 1);
        }
        this.resetHistory();
        this.depthFrame = null;
        this.worldLayer.removeMeshInstances([this.composeInstance]);
        // the source first: the engine's renderer draws from the work buffer it may have patched
        this.source.suspend();
        this.provider.setActive(false);
    }

    // The eyes of a stereo session the engine renders once per eye (the condition of its
    // ForwardRenderer._isMultiview), or null for the camera's own view
    private stereoViews() {
        const cam = this.camera.camera as Camera & { xrActive: boolean; xrViews: XrViewMatrices[] | null };
        const views = cam.xrActive ? cam.xrViews : null;
        return this.device.isWebGPU && views && views.length >= 2 ? views : null;
    }

    // bind the view the camera's passes draw now: in a stereo session the eye the engine is
    // replaying them for, else the camera's
    private bindView() {
        const replaying = this.device.xrCurrentViewIndex ?? -1;
        const index = this.stereo ? Math.min(Math.max(replaying, 0), this.views.length - 1) : 0;
        for (const bind of this.views[index].bindings) bind();
    }

    // the pixel sets' textures, where the copy back and the folded accumulation read them
    private bindSetTextures(view: SplatView) {
        for (let i = 0; i < 4; i++) {
            for (const material of [this.interleaveMaterial, this.taaSetMaterial, this.taaSetHalfMaterial]) {
                material.setParameter(`setColor${i}`, view.setTextures[i * 2]);
                material.setParameter(`setDepth${i}`, view.setTextures[i * 2 + 1]);
            }
        }
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
            for (const view of this.views) this.ensureCache(view, set.activeSplats);
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

        // one view per eye while the engine renders a stereo session, the camera's otherwise
        const eyes = this.stereoViews();
        this.stereo = !!eyes;
        const count = eyes ? eyes.length : 1;
        while (this.views.length < count) {
            const view = new SplatView(device, this.viewShaders, `-eye${this.views.length}`);
            this.ensureCache(view, set.activeSplats);
            this.views.push(view);
        }
        while (this.views.length > count) this.views.pop()!.destroy();
        // the eyes' matrices are refreshed at render time, after this hook
        if (eyes) (cam as Camera & { updateViewTransforms(): void }).updateViewTransforms();

        // variant warp:auto: a session whose eyes the browser rasterises at a variable rate has
        // their rate maps measured at the end of a frame, once its sub-images are known
        if (!eyes) {
            if (this.rateMapState !== 'idle') this.rateMapSession++;
            this.rateMaps = null;
            this.rateMapState = 'idle';
        } else if (this.rateMapState === 'idle' && this.variant.warp === 'auto') {
            const subs = device.xrSubImages ?? [];
            if (subs.length >= count) this.rateMapState = device.wgpu && subs.some(variableRate) ? 'wanted' : 'done';
        }

        // the target follows whatever the camera renders into this frame: the backbuffer, or a
        // capture's render target at another size
        const rt = camera.renderTarget;
        const width = rt ? rt.width : device.width;
        const height = rt ? rt.height : device.height;
        const isOrtho = cam.projection === PROJECTION_ORTHOGRAPHIC;
        const viewOf = (i: number) => (eyes ? eyes[i].viewOffMat : cam.viewMatrix);
        const projectionOf = (i: number) => (eyes ? eyes[i].projMat : cam.projectionMatrix);

        // Temporal accumulation runs on on-screen frames (and, for the harness, on a capture at
        // the same size); the history is only trusted when it holds the previous such frame at
        // this size. While it runs the coverage seed changes every frame, and a resting camera
        // keeps requesting frames until the history has filled its cap
        const isQuery = !!rt;
        const first = this.views[0];
        const taaOn =
            this.variant.taa === 'on' &&
            (!isQuery || (this.allowQueryTaa && width === first.taaWidth && height === first.taaHeight));
        this.frameSeed = taaOn ? this.frameIndex++ >>> 0 : this.userSeed;
        this.taaActive = taaOn;

        // The occlusion cull reads the depth texture as the previous frame left it, so it needs
        // that frame to have drawn to this target at this size (a resize loses the texture, a
        // capture draws elsewhere), with no splat removed since (its depth would hide what is
        // now behind it; arrivals are safe) and the same projection type. A capture frame is
        // never culled and never becomes the previous frame.
        // a new world state can change what is occluded: try the test again
        if (first.prevVersion !== set.version) {
            this.cullSuspendedFrames = 0;
            this.cullActive = true;
        }
        const cullMode = this.variant.cull;
        let wanted = cullMode !== 'off';
        let probe = false;
        if (cullMode === 'auto' && !isQuery) {
            if (this.cullSuspendedFrames > 0) {
                // a moving camera changes what is occluded, so the probe comes sooner
                const moved = this.viewMoved(first, viewOf(0), projectionOf(0));
                this.cullSuspendedFrames = Math.max(0, this.cullSuspendedFrames - (moved ? 4 : 1));
                wanted = false;
            } else if (!this.cullActive) {
                // suspended and due: one probe frame, then wait for its counts
                probe = !this.cullStatsPending;
                wanted = probe;
            }
        }

        for (let i = 0; i < count; i++) {
            this.frameView(this.views[i], i, set, changed, viewOf(i), projectionOf(i), !!eyes, {
                width,
                height,
                isOrtho,
                isQuery,
                taaOn,
                cullWanted: wanted
            });
        }

        // the shaders that read the warp's table, built for it when the views render through one
        const warped = this.views[0].warpKey !== '';
        if (warped !== this.warpDefined) {
            this.warpDefined = warped;
            const taa = [this.taaMaterial, this.taaSetMaterial, this.taaHalfMaterial, this.taaSetHalfMaterial];
            for (const material of [...taa, this.composeMaterial]) {
                material.setDefine('SSE_WARP', warped ? '' : undefined);
                material.update();
            }
        }
        // the compose reads the history in the views' format (every view of a frame shares it)
        const half = this.views[0].taaHalf;
        if (half !== this.composeHalf) {
            this.composeHalf = half;
            this.composeMaterial.setDefine('SSE_TAA_HALF', half ? '' : undefined);
            this.composeMaterial.update();
        }

        // a stereo frame's depth is an eye's, not the camera's, and a warped frame's is not where
        // the picker reads it: nothing for the picker
        if (isQuery || eyes || warped) this.depthFrame = null;
        this.setReady(true);
    }

    // The warp a view renders through this frame (variant warp), as the key of its table and the
    // map it is built from: the editor's function at a number, else an XR eye's rate map
    private warpOf(index: number, eye: boolean, width: number, height: number) {
        const { warp } = this.variant;
        if (typeof warp === 'number') {
            return { key: `m${warp}:${width}x${height}`, map: () => analyticWarpMap(warp, width, height) };
        }
        const measured = eye && warp === 'auto' ? this.rateMaps?.[index] : undefined;
        return measured ? { key: `xr${this.rateMapSession}:${index}`, map: () => measured } : null;
    }

    // variant warp:auto: measure the eyes' rate maps now that this frame has rendered into them
    private measureRateMaps() {
        const { device } = this;
        const subs = device.xrSubImages ?? [];
        if (!device.wgpu || !subs.length) return;
        this.rateMapState = 'measuring';
        const session = this.rateMapSession;
        measureXrRateMaps(device.wgpu, subs)
            .then((maps) => {
                if (this.destroyed || session !== this.rateMapSession) return;
                // every eye warps or none does: the shaders are built one way for all of them
                if (maps.every((map) => map)) {
                    this.rateMaps = maps as WarpMap[];
                    this.app.renderNextFrame = true;
                }
            })
            .catch(() => {
                // the eyes stay unwarped for the session
            })
            .finally(() => {
                if (session === this.rateMapSession) this.rateMapState = 'done';
            });
    }

    // One view's share of the frame: its projection, cull, dispatches, accumulation and the
    // bindings its passes draw with
    private frameView(
        view: SplatView,
        index: number,
        set: ResidentSet,
        changed: boolean,
        viewMatrix: Mat4,
        projection: Mat4,
        eye: boolean,
        frame: {
            width: number;
            height: number;
            isOrtho: boolean;
            isQuery: boolean;
            taaOn: boolean;
            cullWanted: boolean;
        }
    ) {
        const { device, camera } = this;
        const cam = camera.camera;
        const { isOrtho, isQuery, taaOn } = frame;
        // variant warp: the view renders through a table, into a target of the table's size
        const warp = this.warpOf(index, eye, frame.width, frame.height);
        if (view.warpKey !== (warp?.key ?? '')) view.setWarp(warp?.key ?? '', warp ? warp.map() : null);
        const warped = !!warp;
        const width = warped ? view.warpWidth : frame.width;
        const height = warped ? view.warpHeight : frame.height;
        const bindings = view.bindings;
        bindings.length = 0;
        const bind = (target: { setParameter(name: string, value: unknown): void }, name: string, value: unknown) =>
            bindings.push(() => target.setParameter(name, value));

        if (view.target.width !== width || view.target.height !== height) {
            view.target.resize(width, height);
            // their views point at the depth texture just rebuilt
            view.releaseTaaSetTargets();
        }

        // the clip z the raster shader reconstructs must match the engine's WebGPU depth range;
        // an eye's projection is already the session's
        const shaderProjection = eye
            ? view.shaderProjection.copy(projection)
            : Camera.applyShaderProjectionTransform(projection, view.shaderProjection, false, true);
        view.viewProjection.mul2(shaderProjection, viewMatrix);
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

        this.cullNodes(view, set, view.viewProjection);

        const focal = [Math.abs(projection.data[0]) * width * 0.5, Math.abs(projection.data[5]) * height * 0.5];
        const gsplat = this.app.scene.gsplat;
        // splats, quads and fragments below it are dropped
        const alphaClip = gsplat.alphaClipForward;

        // the moving-camera contribution cull: a raised threshold while the view changes, then
        // one more frame at the scene's threshold once it has stopped
        const moved = this.viewMoved(view, viewMatrix, projection);
        const raised = moved && this.variant.contribution > 0;
        const minContribution = raised
            ? Math.max(gsplat.minContribution, this.variant.contribution)
            : gsplat.minContribution;
        if (raised) this.frameWanted = true;

        // variant taaHistory: an XR eye's history in half floats, unless the variant says otherwise
        const { taaHistory } = this.variant;
        const half = taaHistory === 'half' || (taaHistory === 'auto' && eye);
        if (view.taaHalf !== half) view.setTaaHalf(half);

        if (taaOn) {
            if (view.taaWidth !== width || view.taaHeight !== height) {
                this.resizeHistory(view, width, height);
                view.taaWidth = width;
                view.taaHeight = height;
                view.taaHistoryValid = false;
                view.restFrames = 0;
            }
            if (moved || changed) view.restFrames = 0;
            else view.restFrames++;
            if (view.restFrames < this.variant.taaMax + 2) this.frameWanted = true;
        } else {
            // a capture at another size does not accumulate; the next on-screen frame starts over
            view.taaHistoryValid = false;
            view.restFrames = 0;
            // switched off: the history goes back to its placeholder size until it is wanted
            if (this.variant.taa === 'off' && view.taaWidth !== 0) {
                this.resizeHistory(view, 4, 4);
                view.taaWidth = 0;
                view.taaHeight = 0;
            }
        }

        const cullMode = this.variant.cull;
        const culling =
            frame.cullWanted &&
            (!isQuery || this.allowQueryCull) &&
            view.prevValid &&
            view.prevWidth === width &&
            view.prevHeight === height &&
            !this.nodesRemoved &&
            view.prevOrtho === isOrtho;
        if (index === 0) this.culling = culling;
        if (culling) this.reduceDepth(view, width, height);

        view.counter.clear();
        const { coverage } = this.variant;
        const interleaved = coverage === 'interleaved';
        // variant interleaveArea: the small splats draw per splat into the full target, over the
        // sets copied back, so the accumulation reads the full target as usual
        const smallSplats = interleaved && this.variant.interleaveArea > 0;
        // the draw order (shaders/order.ts): front to back, so early depth rejection takes most
        // of what the depth test would; the interleaved pixel sets split their draws by it too
        view.orderBuckets.clear();
        this.ensureOrdered(view, view.cacheSlots * (interleaved ? 4 : 1));
        // the order key spans the fitted clip range, log-spaced
        const logNear = Math.log(Math.max(cam.nearClip, 1e-6));
        const invLogRange = 1 / Math.max(Math.log(Math.max(cam.farClip, 1e-6)) - logNear, 1e-6);
        // the view depths where the raster's clip z reaches 0 and its far clamp (FAR_CLIP_Z), from
        // clip z = a * depth + b (over w = depth for a perspective camera)
        const [clipA, clipB] = clipZ;
        const depthNear = -clipB / clipA;
        const depthFar = isOrtho ? (FAR_CLIP_Z - clipB) / clipA : clipB / (FAR_CLIP_Z - clipA);

        // the view's position, for the view-dependent colour: an eye's is its own
        view.cameraWorld.copy(viewMatrix).invert();
        const position = eye ? view.cameraWorld.getTranslation(tmpVec3) : camera.entity.getPosition();
        const groups = this.source.dispatchPlan(set, this.numChunks);
        for (const group of groups) {
            // a file with no node in the frustum has nothing to dispatch
            if (group.fileIndex >= 0 && !this.anyNodeVisible(view, set.files[group.fileIndex].nodes)) continue;
            const projector = this.ensureProjector(view, culling, coverage, warped, group);
            this.source.bind(projector, group, set);
            projector.setParameter('chunks', this.chunkBuffer!);
            projector.setParameter('nodeVisible', view.nodeVisibleBuffer!);
            projector.setParameter('cache', view.cacheBuffer!);
            projector.setParameter('counter', view.counter);
            projector.setParameter('occL1', view.occL1);
            projector.setParameter('occL2', view.occL2);
            projector.setParameter('buckets', view.orderBuckets);
            projector.setParameter('view', viewMatrix.data);
            projector.setParameter('viewProj', view.viewProjection.data);
            projector.setParameter('prevViewProj', view.prevViewProjection.data);
            projector.setParameter('prevView', view.prevView.data);
            projector.setParameter('prevClipZ', view.prevClipZ);
            projector.setParameter('viewport', [width, height]);
            projector.setParameter('focal', focal);
            projector.setParameter('prevViewport', view.prevViewport);
            projector.setParameter('prevFocal', view.prevFocal);
            projector.setParameter('numChunks', group.chunkCount);
            projector.setParameter('chunkBase', group.chunkBase);
            projector.setParameter('cameraPosition', [position.x, position.y, position.z, 0]);
            projector.setParameter('splatTextureSize', this.source.textureSize(group));
            projector.setParameter('isOrtho', isOrtho ? 1 : 0);
            projector.setParameter('minPixelSize', gsplat.minPixelSize);
            projector.setParameter('alphaClip', alphaClip);
            projector.setParameter('minContribution', minContribution);
            projector.setParameter('unitScale', this.variant.units === 'engine' ? 2 : 1);
            projector.setParameter('occBlocksX1', view.occBlocks.x1);
            projector.setParameter('occBlocksY1', view.occBlocks.y1);
            projector.setParameter('occBlocksX2', view.occBlocks.x2);
            projector.setParameter('occBlocksY2', view.occBlocks.y2);
            projector.setParameter('occlusionMode', culling ? (cullMode === 'l1' ? 1 : 2) : 0);
            projector.setParameter('prevFlip', view.prevFlip);
            projector.setParameter('keyLogNear', logNear);
            projector.setParameter('keyInvLogRange', invLogRange);
            projector.setParameter('depthNear', depthNear);
            projector.setParameter('depthFar', depthFar);
            projector.setParameter('frameSeed', this.frameSeed);
            projector.setParameter('jitterSubs', this.variant.jitter);
            projector.setParameter('strata', this.variant.strata);
            projector.setParameter('interleaveArea', interleaved ? this.variant.interleaveArea : 0);
            projector.setParameter('warpTable', view.warpBuffer);
            Compute.calcDispatchSize(group.chunkCount, tmpVec2);
            projector.setupDispatch(tmpVec2.x, tmpVec2.y, 1);
            device.computeDispatch([projector], 'sse-splat-project');
        }

        // indirect draw arguments for the raster and dispatch size for the scatter; slots are
        // per frame
        const drawSlot = device.getIndirectDrawSlot(1);
        const dispatchSlot = device.getIndirectDispatchSlot(1);
        const args = view.args;
        args.setParameter('counter', view.counter);
        args.setParameter('indirectDrawArgs', device.indirectDrawBuffer);
        args.setParameter('indirectDispatchArgs', device.indirectDispatchBuffer);
        args.setParameter('drawSlot', drawSlot);
        // two triangles per splat, the quad's or the square's
        const indicesPerSplat = 6;
        args.setParameter('indexCount', QUADS_PER_INSTANCE * indicesPerSplat);
        args.setParameter('quadsPerInstance', QUADS_PER_INSTANCE);
        args.setParameter('dispatchSlot', dispatchSlot);
        args.setParameter('scatterWorkgroupSize', ORDER_BUCKETS);
        args.setupDispatch(1, 1, 1);
        device.computeDispatch([args], 'sse-splat-args');
        if (!interleaved) bindings.push(() => this.rasterInstance.setIndirect(null, drawSlot, 1));

        // bucket offsets, then every survivor claims its place in its bucket
        view.orderScan.setParameter('buckets', view.orderBuckets);
        view.orderScan.setupDispatch(1, 1, 1);
        device.computeDispatch([view.orderScan], 'sse-splat-order-scan');
        if (interleaved) {
            // each group's range and draw, from the offsets before the scatter advances them:
            // the four sets, and the full target's small splats
            const setSlot = device.getIndirectDrawSlot(SET_GROUPS);
            bindings.push(() => this.rasterInstance.setIndirect(null, setSlot + 4, 1));
            const setArgs = view.setArgs;
            setArgs.setParameter('buckets', view.orderBuckets);
            setArgs.setParameter('indirectDrawArgs', device.indirectDrawBuffer);
            setArgs.setParameter('setRanges', view.setRanges);
            setArgs.setParameter('drawSlot', setSlot);
            setArgs.setParameter('indexCount', QUADS_PER_INSTANCE * indicesPerSplat);
            setArgs.setParameter('quadsPerInstance', QUADS_PER_INSTANCE);
            setArgs.setupDispatch(1, 1, 1);
            device.computeDispatch([setArgs], 'sse-splat-set-args');
            this.prepareSets(view, width, height, setSlot);
        }
        const scatter = interleaved ? view.orderScatterSets : view.orderScatter;
        scatter.setParameter('counter', view.counter);
        scatter.setParameter('cache', view.cacheBuffer!);
        scatter.setParameter('buckets', view.orderBuckets);
        scatter.setParameter('ordered', view.orderedBuffer!);
        scatter.setupIndirectDispatch(dispatchSlot);
        device.computeDispatch([scatter], 'sse-splat-order-scatter');

        // the view's targets, where the passes draw
        bindings.push(() => {
            this.rasterPass.renderTarget = view.target;
            for (let i = 0; i < 4; i++) this.setPasses[i].renderTarget = view.setTargets[i];
            this.bindSetTextures(view);
        });
        const raster = this.rasterMaterial;
        bind(raster, 'splatCache', view.cacheBuffer!);
        bind(raster, 'splatCount', view.counter);
        bind(raster, 'orderedSlots', view.orderedBuffer!);
        bind(raster, 'viewportSize', [width, height, 2 / width, 2 / height]);
        bind(raster, 'clipZParams', clipZParams);
        bind(raster, 'focalParams', [focal[0], focal[1], 0, 0]);
        bind(raster, 'sseAlphaClip', alphaClip);
        bind(raster, 'frameSeed', this.frameSeed);
        if (interleaved) bind(raster, 'setRanges', view.setRanges);

        // the pixel sets draw in their own passes; the raster pass copies them back, after the
        // small splats it draws into the full target first
        this.rasterPass.instances = interleaved
            ? smallSplats
                ? [this.rasterInstance, this.interleaveInstance]
                : [this.interleaveInstance]
            : [this.rasterInstance];

        // interleaved pixel sets go straight into the taa, which writes their depth, so the
        // raster pass has nothing to do; with small splats drawn over them it copies them back
        const folded = interleaved && taaOn && !smallSplats;
        if (folded) this.ensureTaaSetTargets(view);
        if (folded !== this.setsFolded || half !== this.taaPassHalf) {
            this.setsFolded = folded;
            this.taaPassHalf = half;
            this.initTaaPass(folded ? view.taaSetTargets[0] : view.taaTargets[0]);
            this.taaPass.instances = [folded ? this.taaSetInstance : this.taaInstance];
            this.taaInstance.material = half ? this.taaHalfMaterial : this.taaMaterial;
            this.taaSetInstance.material = half ? this.taaSetHalfMaterial : this.taaSetMaterial;
        }
        this.taaPass.enabled = taaOn;
        if (!taaOn) {
            // declared either way, and a history format switch destroys what it pointed at
            bind(this.composeMaterial, 'taaColor', view.taaColor[0]);
            bind(this.composeMaterial, 'taaInfo', view.taaInfo[0]);
        }
        if (taaOn) {
            const read = view.taaWrite ^ 1;
            const taa = folded
                ? half
                    ? this.taaSetHalfMaterial
                    : this.taaSetMaterial
                : half
                  ? this.taaHalfMaterial
                  : this.taaMaterial;
            view.taaPrevViewProjection.copy(view.taaLastViewProjection);
            view.taaPrevView.copy(view.taaLastView);
            if (!folded) {
                bind(taa, 'curColor', view.colorTexture);
                bind(taa, 'curDepth', view.depthTexture);
            }
            bind(taa, 'histColor', view.taaColor[read]);
            bind(taa, 'histInfo', view.taaInfo[read]);
            bind(taa, 'cameraWorld', view.cameraWorld.data);
            // x_ndc = (m00 x + m02 z) / -z for a perspective camera, m00 x + m03 for an orthographic one
            const sp = shaderProjection.data;
            bind(taa, 'unproject', isOrtho ? [sp[0], sp[5], sp[12], sp[13]] : [sp[0], sp[5], sp[8], sp[9]]);
            bind(taa, 'prevViewProj', view.taaPrevViewProjection.data);
            bind(taa, 'prevView', view.taaPrevView.data);
            bind(taa, 'clipZParams', clipZParams);
            // a changed resident set (detail streamed in) keeps the history but caps its weight,
            // so the new content shows within taaMoveMax frames rather than 1 / taaMax a frame
            bind(taa, 'taaParams', [
                moved || changed ? this.variant.taaMoveMax : this.variant.taaMax,
                view.taaHistoryValid ? 1 : 0,
                moved ? 1 : 0,
                view.restFrames
            ]);
            bind(taa, 'taaViewport', [width, height, 1 / width, 1 / height]);
            bind(taa, 'taaControl', [
                view.target.flipY ? -1 : 1,
                this.variant.taaClip,
                this.variant.taaReproj === 'history' ? 1 : 0,
                this.variant.taaMotion
            ]);
            bind(taa, 'taaMoving', [this.variant.taaParallax === 'on' ? 1 : 0, this.variant.taaSharp]);
            bind(taa, 'taaDebug', this.variant.taaDebug);
            bind(taa, 'warpTable', view.warpBuffer);
            const taaTarget = (folded ? view.taaSetTargets : view.taaTargets)[view.taaWrite];
            bindings.push(() => {
                this.taaPass.renderTarget = taaTarget;
            });
            bind(this.composeMaterial, 'taaColor', view.taaColor[view.taaWrite]);
            bind(this.composeMaterial, 'taaInfo', view.taaInfo[view.taaWrite]);
            view.taaLastViewProjection.copy(view.viewProjection);
            view.taaLastView.copy(viewMatrix);
            view.taaHistoryValid = true;
            view.taaWrite ^= 1;
        }

        // an offscreen target's rows run the other way to the backbuffer's on WebGPU
        const rt = camera.renderTarget;
        const targetFlipY = rt ? rt.flipY : device.backBuffer.flipY;
        const compose = this.composeMaterial;
        bind(compose, 'splatColor', view.colorTexture);
        bind(compose, 'splatDepth', view.depthTexture);
        bind(compose, 'composeParams', [view.target.flipY !== targetFlipY ? 1 : 0, isOrtho ? 1 : 0, taaOn ? 1 : 0, 0]);
        bind(compose, 'depthViewParams', [
            clipZ[0],
            clipZ[1],
            Math.max(cam.nearClip, 1e-4),
            Math.max(cam.farClip, cam.nearClip * 2)
        ]);
        bind(compose, 'cameraClipZ', [cameraClipZ[0], cameraClipZ[1], isOrtho ? 1 : 0, 0]);
        bind(compose, 'warpTable', view.warpBuffer);

        // cull:auto: read this culled frame's counts back (asynchronously, off the frame) and
        // keep the test only while it removes enough to pay for itself
        if (index === 0 && culling && cullMode === 'auto' && !isQuery && !this.cullStatsPending) {
            this.cullStatsPending = true;
            const data = new Uint32Array(2);
            view.counter
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
            view.prevValid = false;
            return;
        }
        if (!eye) {
            captureCameraSnapshot(camera.entity, this.depthFrameCamera);
            this.depthFrame = {
                id: ++this.depthFrameCount,
                camera: this.depthFrameCamera,
                width,
                height,
                clipZ: [clipZ[0], clipZ[1]]
            };
        }
        view.prevViewProjection.copy(view.viewProjection);
        view.prevView.copy(viewMatrix);
        view.prevProjection.copy(projection);
        view.prevClipZ = clipZParams;
        view.prevViewport = [width, height];
        view.prevFocal = focal;
        view.prevFlip = view.target.flipY ? -1 : 1;
        view.prevWidth = width;
        view.prevHeight = height;
        view.prevVersion = set.version;
        view.prevOrtho = isOrtho;
        view.prevValid = true;
    }

    private resizeHistory(view: SplatView, width: number, height: number) {
        for (const texture of [...view.taaColor, ...view.taaInfo]) texture.resize(width, height);
        for (const target of view.taaTargets) target.resize(width, height);
        view.releaseTaaSetTargets();
    }

    // the pass's attachment operations follow the target it is initialised with: whether it
    // stores depth. It writes every texel, so nothing is loaded. Every view's targets of a kind
    // are alike, so the bind pass swaps them
    private initTaaPass(target: RenderTarget) {
        this.taaPass.init(target);
        this.taaPass.setClearColor(new Color(0, 0, 0, 0));
        if (target.depthBuffer) this.taaPass.setClearDepth(1);
    }

    private ensureTaaSetTargets(view: SplatView) {
        if (view.taaSetTargets.length) return;
        for (let i = 0; i < 2; i++) {
            view.taaSetTargets.push(
                new RenderTarget({
                    name: `sse-splat-taa-sets-${i}`,
                    colorBuffers: [view.taaColor[i], view.taaInfo[i]],
                    depthBuffer: view.depthTexture,
                    samples: 1
                })
            );
        }
    }

    // whether the view or the projection differs from the view's previous on-screen frame's
    // beyond float noise (the camera controllers settle over many frames; a fov animation moves
    // the image without moving the camera)
    private viewMoved(view: SplatView, viewMatrix: Mat4, projection: Mat4) {
        for (let i = 0; i < 16; i++) {
            if (Math.abs(viewMatrix.data[i] - view.prevView.data[i]) > 1e-6) return true;
            if (Math.abs(projection.data[i] - view.prevProjection.data[i]) > 1e-6) return true;
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
    }

    // the cache is dense (indexed by compact slot), so it only needs room for the resident
    // splats, not the allocator's address space; grown geometrically, never shrunk
    private ensureCache(view: SplatView, splats: number) {
        if (splats <= view.cacheSlots) return;
        view.cacheBuffer?.destroy();
        view.orderedBuffer?.destroy();
        view.cacheSlots = Math.max(1, Math.ceil(splats * 1.25));
        view.cacheBuffer = new StorageBuffer(this.device, view.cacheSlots * CACHE_WORDS * 4, BUFFERUSAGE_COPY_SRC);
        view.orderedBuffer = null;
        view.orderedCapacity = 0;
    }

    // the ordered list: one entry per survivor, or with interleaved pixel sets one per set it
    // keeps pixels in, up to four
    private ensureOrdered(view: SplatView, entries: number) {
        if (entries <= view.orderedCapacity) return;
        view.orderedBuffer?.destroy();
        view.orderedCapacity = entries;
        view.orderedBuffer = new StorageBuffer(this.device, entries * 4);
    }

    // Variant coverage:interleaved: size the view's pixel sets' targets to half the full target,
    // rounded up, and point each set's draw at its indirect arguments and its map into its
    // target. In framebuffer pixels the full target's (2i + x, 2j + y) is the set (x, y)'s (i, j);
    // as a map of clip x and y over w (y down in the framebuffer from ndc +1)
    private prepareSets(view: SplatView, width: number, height: number, drawSlot: number) {
        const w = Math.ceil(width / 2);
        const h = Math.ceil(height / 2);
        for (let i = 0; i < 4; i++) {
            const target = view.setTargets[i];
            if (target.width !== w || target.height !== h) target.resize(w, h);
            const x = i & 1;
            const y = i >> 1;
            const instance = this.setInstances[i];
            const setMap = [
                width / (2 * w),
                (width / 2 - x + 0.5) / w - 1,
                height / (2 * h),
                1 - (height / 2 - y + 0.5) / h
            ];
            view.bindings.push(() => {
                instance.setIndirect(null, drawSlot + i, 1);
                instance.setParameter('setMap', setMap);
            });
        }
    }

    // sphere-frustum test per node on the cpu: thousands of nodes, one bit each
    private cullNodes(view: SplatView, set: ResidentSet, viewProjection: Mat4) {
        const words = Math.max(1, Math.ceil(set.nodes.length / 32));
        if (view.nodeVisibleData.length < words) {
            view.nodeVisibleData = new Uint32Array(words);
            view.nodeVisibleBuffer?.destroy();
            view.nodeVisibleBuffer = new StorageBuffer(this.device, words * 4, BUFFERUSAGE_COPY_DST);
        }
        const bits = view.nodeVisibleData;
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
        view.nodeVisibleBuffer!.write(0, bits, 0, words);
    }

    private anyNodeVisible(view: SplatView, nodes: ResidentSet['nodes']) {
        const bits = view.nodeVisibleData;
        return nodes.some((node) => (bits[node.nodeIndex >> 5] >>> (node.nodeIndex & 31)) & 1);
    }

    private ensureProjector(
        view: SplatView,
        occlusion: boolean,
        coverage: CoverageMode,
        warp: boolean,
        group: DispatchGroup
    ) {
        const sourceKey = this.source.shaderKey();
        if (this.projectorSourceKey !== sourceKey) {
            // a different source: every specialisation and the bind group format go
            this.destroyProjector();
            this.projectorSourceKey = sourceKey;
        }
        const key = `${occlusion ? 'occlusion' : 'plain'}-${coverage}${warp ? '-warp' : ''}`;
        const computeKey = `${key}:${group.fileIndex}`;
        const existing = view.projectorComputes.get(computeKey);
        if (existing) return existing;
        const shader = this.ensureProjectorShader(key, occlusion, coverage, warp);
        const compute = new Compute(this.device, shader, 'sse-splat-project');
        view.projectorComputes.set(computeKey, compute);
        return compute;
    }

    // drop the computes of files that left the resident set
    private pruneProjectorComputes(set: ResidentSet) {
        for (const view of this.views) {
            for (const [key, compute] of view.projectorComputes) {
                const fileIndex = Number(key.slice(key.lastIndexOf(':') + 1));
                if (fileIndex >= 0 && !set.files[fileIndex]) {
                    compute.destroy();
                    view.projectorComputes.delete(key);
                }
            }
        }
    }

    private ensureProjectorShader(key: string, occlusion: boolean, coverage: CoverageMode, warp: boolean) {
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
            new BindStorageBufferFormat('buckets', SHADERSTAGE_COMPUTE),
            // read only by the warped shaders, bound always (a placeholder while unwarped)
            new BindStorageBufferFormat('warpTable', SHADERSTAGE_COMPUTE, true)
        ];
        const formats = [...fixed, ...this.source.bindFormats()] as ConstructorParameters<typeof BindGroupFormat>[1];
        this.projectorBindGroupFormat ??= new BindGroupFormat(device, formats);
        const shader = new Shader(device, {
            name: `sse-splat-project-${key}`,
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: projectorWGSL(this.source.readChunk(fixed.length), occlusion, coverage, warp),
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
                    new UniformFormat('unitScale', UNIFORMTYPE_FLOAT),
                    new UniformFormat('depthNear', UNIFORMTYPE_FLOAT),
                    new UniformFormat('depthFar', UNIFORMTYPE_FLOAT),
                    new UniformFormat('frameSeed', UNIFORMTYPE_UINT),
                    new UniformFormat('jitterSubs', UNIFORMTYPE_UINT),
                    new UniformFormat('strata', UNIFORMTYPE_UINT),
                    new UniformFormat('interleaveArea', UNIFORMTYPE_FLOAT)
                ])
            },
            computeBindGroupFormat: this.projectorBindGroupFormat
        });
        this.projectorShaders.set(key, shader);
        return shader;
    }

    private destroyProjector() {
        for (const view of this.views) view.destroyProjectorComputes();
        for (const shader of this.projectorShaders.values()) shader.destroy();
        this.projectorShaders.clear();
        this.projectorBindGroupFormat?.destroy();
        this.projectorBindGroupFormat = null;
        this.projectorSourceKey = '';
    }

    destroy() {
        this.destroyed = true;
        this.unsubscribe();
        this.app.off('frameend', this.onFrameEnd);
        this.detach();
        this.provider.destroy();
        this.source.destroy();

        this.destroyProjector();
        for (const view of this.views) view.destroy();
        this.views.length = 0;
        for (const shader of Object.values(this.viewShaders)) shader.destroy();
        this.argsBindGroupFormat.destroy();
        for (const format of [...this.reduceFormats, ...this.orderFormats]) format.destroy();
        this.chunkBuffer?.destroy();
        this.chunkBuffer = null;

        this.bindPass.destroy();
        this.rasterPass.destroy();
        this.rasterInstance.destroy();
        this.rasterMaterial.destroy();
        for (const pass of this.setPasses) pass.destroy();
        for (const instance of this.setInstances) instance.destroy();
        this.setPasses.length = 0;
        this.setInstances.length = 0;
        const interleaveMesh = this.interleaveInstance.mesh;
        this.interleaveInstance.destroy();
        interleaveMesh.destroy();
        this.interleaveMaterial.destroy();
        this.rasterMesh.destroy();
        this.polygonMesh.destroy();
        this.taaPass.destroy();
        this.taaInstance.destroy();
        this.taaMaterial.destroy();
        this.taaSetInstance.destroy();
        this.taaSetMaterial.destroy();
        this.taaHalfMaterial.destroy();
        this.taaSetHalfMaterial.destroy();
        this.taaMesh.destroy();

        this.composeInstance.destroy();
        this.composeMaterial.destroy();
        this.composeMesh.destroy();
    }
}

export { StochasticSplatRenderer };
export type { DepthFrame, StochasticRendererOptions, Variant };
