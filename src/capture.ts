import {
    ADDRESS_CLAMP_TO_EDGE,
    ASPECT_AUTO,
    BlendState,
    drawQuadWithShader,
    FILTER_LINEAR,
    PIXELFORMAT_RGBA8,
    RenderTarget,
    SEMANTIC_POSITION,
    ShaderUtils,
    Texture
} from 'playcanvas';
import type { AppBase, CameraComponent, GraphicsDevice, Shader } from 'playcanvas';

type CaptureFrame = { update(): void };

// scrub advances the (paused) animation to `time` before the capture render
type GrabOptions = { time?: number; width: number; height: number; supersample?: number; scrub?: (time: number) => void };

type CaptureResult = { width: number; height: number; data: string };

// Box-average downsample of a supersampled render. Each output texel averages the
// `uRatio` x `uRatio` block of source texels it covers — true NxN supersampling, which
// keeps thin high-frequency features (splat strings, edges) smooth, unlike a
// bilinear/compositor downscale which aliases them. `uFlipY` flips vertically because
// render targets and readback disagree on row order.
const boxDownsampleGLSL = /* glsl */ `
varying vec2 vUv0;

uniform sampler2D source;
uniform vec2 uSrcSize;
uniform float uRatio;
uniform float uFlipY;

void main(void) {
    int r = int(uRatio);
    vec2 outSize = uSrcSize / uRatio;
    vec2 uv = vUv0;
    if (uFlipY > 0.5) {
        uv.y = 1.0 - uv.y;
    }
    vec2 base = floor(uv * outSize) * uRatio;
    vec4 sum = vec4(0.0);
    for (int y = 0; y < 8; y++) {
        if (y >= r) break;
        for (int x = 0; x < 8; x++) {
            if (x >= r) break;
            vec2 texel = base + vec2(float(x) + 0.5, float(y) + 0.5);
            sum += texture2D(source, texel / uSrcSize);
        }
    }
    gl_FragColor = sum / (uRatio * uRatio);
}
`;

// WGSL twin of the box downsample (WebGPU can't compile GLSL, so a custom fullscreen
// shader must supply WGSL too — the built-in fullscreenQuadVS chunk covers the vertex).
const boxDownsampleWGSL = /* wgsl */ `
varying vUv0: vec2f;
var source: texture_2d<f32>;
var sourceSampler: sampler;
uniform uSrcSize: vec2f;
uniform uRatio: f32;
uniform uFlipY: f32;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let r: i32 = i32(uniform.uRatio);
    let outSize: vec2f = uniform.uSrcSize / uniform.uRatio;
    var uv: vec2f = input.vUv0;
    if (uniform.uFlipY > 0.5) {
        uv.y = 1.0 - uv.y;
    }
    let base: vec2f = floor(uv * outSize) * uniform.uRatio;
    var sum: vec4f = vec4f(0.0);
    for (var y: i32 = 0; y < 8; y = y + 1) {
        if (y >= r) { break; }
        for (var x: i32 = 0; x < 8; x = x + 1) {
            if (x >= r) { break; }
            let texel: vec2f = base + vec2f(f32(x) + 0.5, f32(y) + 0.5);
            sum = sum + textureSample(source, sourceSampler, texel / uniform.uSrcSize);
        }
    }
    output.color = sum / (uniform.uRatio * uniform.uRatio);
    return output;
}
`;

// Grabs downsampled snapshots of the viewer entirely on the GPU. The scene is rendered
// (with post effects) into an app-owned render target at `supersample` x the requested
// output size, box-downsampled to the output size, and only that small buffer is read
// back. Rendering into our own target (rather than the backbuffer) means no
// preserveDrawingBuffer, and it works on both WebGL and WebGPU.
class Capture {
    private app: AppBase;

    private device: GraphicsDevice;

    private camera: CameraComponent;

    private getCameraFrame: () => CaptureFrame | null;

    private shader: Shader;

    private srcRT: RenderTarget | null = null;

    private dstRT: RenderTarget | null = null;

    constructor(
        app: AppBase,
        camera: CameraComponent,
        getCameraFrame: () => CaptureFrame | null
    ) {
        this.app = app;
        this.device = app.graphicsDevice;
        this.camera = camera;
        this.getCameraFrame = getCameraFrame;
        this.shader = ShaderUtils.createShader(this.device, {
            uniqueName: 'captureBoxDownsample',
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexChunk: 'fullscreenQuadVS',
            fragmentGLSL: boxDownsampleGLSL,
            fragmentWGSL: boxDownsampleWGSL
        });
    }

    private makeRT(name: string, width: number, height: number, depth: boolean) {
        // Plain RGBA8 (RGBA channel order, non-sRGB) so the box shader samples raw bytes
        // and the readback returns raw RGBA — no channel swap (WebGPU backbuffers are
        // often BGRA) and no sRGB decode/encode surprises; we average in the same gamma
        // space sharp did. We only mirror the backbuffer's sRGB *flag* (which the viewer
        // sets true only when post effects are active) — that drives the gamma the render
        // pipeline writes with, so our target receives identical bytes to the screen.
        const dev = this.device as { backBuffer?: { isColorBufferSrgb?: (i: number) => boolean } };
        const srgb = dev.backBuffer?.isColorBufferSrgb?.(0) ?? false;
        const colorBuffer = new Texture(this.device, {
            name,
            width,
            height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        const rt = new RenderTarget({ name, colorBuffer, depth });
        (rt as { isColorBufferSrgb: (index: number) => boolean }).isColorBufferSrgb = () => srgb;
        return rt;
    }

    private ensure(target: 'srcRT' | 'dstRT', width: number, height: number, depth: boolean) {
        const existing = this[target];
        if (existing && existing.width === width && existing.height === height) {
            return existing;
        }
        existing?.colorBuffer.destroy();
        existing?.destroy();
        const rt = this.makeRT(target, width, height, depth);
        this[target] = rt;
        return rt;
    }

    // Point the camera at `renderTarget` and re-target CameraFrame's compose pass. Post
    // effects bind their output inside setupRenderPasses, which only re-runs on a reset,
    // so a plain renderTarget change doesn't take effect — force a reset via layersDirty,
    // otherwise the composited frame keeps going to the old target (reads back black).
    private setCameraTarget(renderTarget: RenderTarget | null) {
        this.camera.renderTarget = renderTarget;
        const cameraFrame = this.getCameraFrame();
        if (cameraFrame) {
            const rpc = (cameraFrame as { renderPassCamera?: { layersDirty: boolean } }).renderPassCamera;
            if (rpc) {
                rpc.layersDirty = true;
            }
            cameraFrame.update();
        }
    }

    async grab({ time, width, height, supersample = 2, scrub }: GrabOptions): Promise<CaptureResult> {
        const device = this.device;
        // clamp to the box shaders' 8x8 sample cap: a larger ratio would sum at most 64
        // texels yet still divide by ss*ss, producing an under-exposed (too dark) frame.
        const ss = Math.min(8, Math.max(1, Math.round(supersample)));
        // normalize the output size to positive integers so texture/RT creation and
        // readback don't fail confusingly on 0/negative/non-integer input
        const outW = Math.max(1, Math.round(width));
        const outH = Math.max(1, Math.round(height));
        const srcW = outW * ss;
        const srcH = outH * ss;

        // render the scene (incl. post effects) into our own supersampled target
        const srcRT = this.ensure('srcRT', srcW, srcH, true);

        // Redirect the camera into our offscreen target for the capture, then restore it.
        // window.captureFrame is a global API, so leaving the camera pointed at our target
        // would freeze on-screen rendering after the first call.
        const camera = this.camera;
        const saved = {
            renderTarget: camera.renderTarget,
            aspectRatioMode: camera.aspectRatioMode,
            aspectRatio: camera.aspectRatio,
            horizontalFov: camera.horizontalFov
        };

        try {
            camera.aspectRatioMode = ASPECT_AUTO; // aspect follows the target dims
            camera.horizontalFov = srcW >= srcH;
            this.setCameraTarget(srcRT);

            if (time !== undefined && scrub) {
                scrub(time);
            }
            this.app.renderNextFrame = true;
            await new Promise<void>((resolve) => {
                this.app.once('frameend', () => resolve());
            });

            // box-downsample the supersampled render to the output size
            const dstRT = this.ensure('dstRT', outW, outH, false);
            const { scope } = device;
            scope.resolve('source').setValue(srcRT.colorBuffer);
            scope.resolve('uSrcSize').setValue([srcW, srcH]);
            scope.resolve('uRatio').setValue(ss);
            scope.resolve('uFlipY').setValue(srcRT.flipY ? 0 : 1);
            device.setBlendState(BlendState.NOBLEND);
            drawQuadWithShader(device, dstRT, this.shader);

            const pixels = await dstRT.colorBuffer.read(0, 0, outW, outH, { renderTarget: dstRT, immediate: true });
            const u8 = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer);
            const chunks: string[] = [];
            const chunk = 0x8000;
            for (let i = 0; i < u8.length; i += chunk) {
                chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + chunk) as unknown as number[]));
            }
            return { width: outW, height: outH, data: btoa(chunks.join('')) };
        } finally {
            camera.aspectRatioMode = saved.aspectRatioMode;
            camera.aspectRatio = saved.aspectRatio;
            camera.horizontalFov = saved.horizontalFov;
            this.setCameraTarget(saved.renderTarget);
            this.app.renderNextFrame = true;
        }
    }
}

export { Capture };
export type { CaptureResult };
