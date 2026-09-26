/**
 * World picking from the stochastic renderer's own frame.
 *
 * Every pixel of that renderer's depth texture holds the nearest surviving sample, which is
 * exactly what the pass picker in `picker.ts` renders on purpose: a stochastic depth whose
 * distribution over a disc is the scene's opacity along the ray. So no pick pass: the frame's
 * depth is snapshotted into the same encoding (normalised linear depth in four half-float
 * channels, 1 where nothing survived) at css resolution, and the shared estimators, the
 * annotation test and the debug overlay read it unchanged. A css pixel's four channels are four
 * of the device pixels it covers, so a high-density display supplies four trials as before.
 */

import {
    ADDRESS_CLAMP_TO_EDGE,
    BlendState,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA16F,
    PROJECTION_ORTHOGRAPHIC,
    RenderTarget,
    SEMANTIC_POSITION,
    ShaderUtils,
    Texture,
    drawQuadWithShader
} from 'playcanvas';
import type { AppBase, Entity, Shader, Vec3 } from 'playcanvas';

import {
    NORMAL_SAMPLE_MAX_PX,
    PickQueue,
    SURFACE_RADIUS_PX,
    clampPixel,
    createPickCameraSnapshot,
    estimateSurface,
    getWorldPoint,
    half2Float,
    opacityInFront,
    pickTargetSize,
    surfaceDepth
} from './picker';
import type { DepthAt, PickCameraSnapshot, PickSurface, ScenePicker } from './picker';
import type { DepthFrame, StochasticSplatRenderer } from './render/stochastic-splat-renderer';

// The frame's hardware depth as normalised linear view depth, in the pass picker's encoding.
// Each snapshot pixel covers a block of device pixels; four of them, at the block's quarter
// points, fill the four channels.
const snapshotWgsl = /* wgsl */ `
var splatDepth: texture_depth_2d;
// clip z = a * viewDepth + b over w = viewDepth (x, y), near and far (z, w)
uniform depthViewParams: vec4f;
// device pixels per snapshot pixel (x, y), 1 for an orthographic camera (z)
uniform snapshotParams: vec4f;

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let dims = vec2i(textureDimensions(splatDepth));
    let p = uniform.depthViewParams;
    let ortho = uniform.snapshotParams.z > 0.5;
    let origin = floor(pcPosition.xy);
    var trials = vec4f(1.0);
    for (var i = 0; i < 4; i++) {
        let corner = vec2f(0.25 + 0.5 * f32(i & 1), 0.25 + 0.5 * f32(i >> 1));
        let q = clamp(vec2i(floor((origin + corner) * uniform.snapshotParams.xy)), vec2i(0), dims - vec2i(1));
        let depth = textureLoad(splatDepth, q, 0);
        if (depth < 1.0) {
            let dz = depth - p.x;
            let safeDz = select(dz, sign(dz) * 1e-9 + 1e-12, abs(dz) < 1e-9);
            let viewDepth = select(p.y / safeDz, (depth - p.y) / p.x, ortho);
            trials[i] = clamp((viewDepth - p.z) / (p.w - p.z), 0.0, 0.99951171875);
        }
    }
    output.color = trials;
    return output;
}
`;

const cameraMatches = (frame: PickCameraSnapshot, camera: Entity) => {
    const cam = camera.camera;
    return (
        frame.viewMatrix.equals(cam.viewMatrix) &&
        frame.projectionMatrix.equals(cam.projectionMatrix) &&
        frame.nearClip === cam.nearClip &&
        frame.farClip === cam.farClip &&
        frame.projection === cam.projection
    );
};

const sameCamera = (a: PickCameraSnapshot, b: PickCameraSnapshot) =>
    a.viewMatrix.equals(b.viewMatrix) &&
    a.projectionMatrix.equals(b.projectionMatrix) &&
    a.nearClip === b.nearClip &&
    a.farClip === b.farClip &&
    a.projection === b.projection;

const copyCameraSnapshot = (from: PickCameraSnapshot, to: PickCameraSnapshot) => {
    to.position.copy(from.position);
    to.viewMatrix.copy(from.viewMatrix);
    to.projectionMatrix.copy(from.projectionMatrix);
    to.nearClip = from.nearClip;
    to.farClip = from.farClip;
    to.projection = from.projection;
};

class FrameDepthPicker implements ScenePicker {
    private app: AppBase;

    private camera: Entity;

    private renderer: StochasticSplatRenderer;

    private shader: Shader;

    private texture: Texture | null = null;

    private target: RenderTarget | null = null;

    // the renderer frame the snapshot was taken from, and the camera it was drawn with
    private snapshotFrame = -1;

    private snapshotCamera = createPickCameraSnapshot();

    private renders = 0;

    private queue = new PickQueue();

    // picks waiting for a frame to render; settled by release as well
    private waiters = new Set<() => void>();

    constructor(app: AppBase, camera: Entity, renderer: StochasticSplatRenderer) {
        this.app = app;
        this.camera = camera;
        this.renderer = renderer;
        this.shader = ShaderUtils.createShader(app.graphicsDevice, {
            uniqueName: 'sse-splat-depth-snapshot',
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexChunk: 'fullscreenQuadVS',
            fragmentWGSL: snapshotWgsl
        });
    }

    // Wait for the next frame to finish, or for release.
    private nextFrame() {
        return new Promise<void>((resolve) => {
            const done = () => {
                handle.off();
                this.waiters.delete(done);
                resolve();
            };
            const handle = this.app.once('frameend', done);
            this.waiters.add(done);
        });
    }

    // Snapshot the renderer's frame at css resolution, unless the snapshot already is of it. With
    // `latest` false a snapshot of an earlier frame from the same camera serves: every stochastic
    // frame is a new sample, so the debug overlay would otherwise ask for frames without end.
    private snapshot(frame: DepthFrame, latest: boolean) {
        const device = this.app.graphicsDevice;
        const size = pickTargetSize(device);
        if (!size) return null;
        const { width, height } = size;

        if (!this.texture) {
            this.texture = new Texture(device, {
                name: 'sse-splat-depth-snapshot',
                format: PIXELFORMAT_RGBA16F,
                width,
                height,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            this.target = new RenderTarget({
                name: 'sse-splat-depth-snapshot',
                colorBuffer: this.texture,
                depth: false
            });
            this.snapshotFrame = -1;
        } else if (this.texture.width !== width || this.texture.height !== height) {
            this.target!.resize(width, height);
            this.snapshotFrame = -1;
        }

        const current =
            this.snapshotFrame === frame.id ||
            (!latest && this.snapshotFrame >= 0 && sameCamera(this.snapshotCamera, frame.camera));
        if (!current) {
            const { scope } = device;
            const { camera } = frame;
            scope.resolve('splatDepth').setValue(this.renderer.frameDepthTexture);
            scope
                .resolve('depthViewParams')
                .setValue([frame.clipZ[0], frame.clipZ[1], camera.nearClip, camera.farClip]);
            scope
                .resolve('snapshotParams')
                .setValue([
                    frame.width / width,
                    frame.height / height,
                    camera.projection === PROJECTION_ORTHOGRAPHIC ? 1 : 0,
                    0
                ]);
            device.setBlendState(BlendState.NOBLEND);
            drawQuadWithShader(device, this.target!, this.shader);
            this.snapshotFrame = frame.id;
            copyCameraSnapshot(frame.camera, this.snapshotCamera);
            this.renders++;
        }

        return { width, height, pickCamera: frame.camera };
    }

    // The frame to pick from: the last one rendered if the camera has not moved since, else
    // one requested now. Its own camera unprojects it, whatever the live camera does meanwhile.
    private async prepare() {
        if (this.queue.released) return null;
        let frame = this.renderer.depthFrame;
        if (!frame || !cameraMatches(frame.camera, this.camera)) {
            this.app.renderNextFrame = true;
            await this.nextFrame();
            frame = this.renderer.depthFrame;
            if (!frame || this.queue.released) return null;
        }
        return this.snapshot(frame, true);
    }

    // Read the snapshot around a pixel, `margin` pixels each way, clamped to it.
    private async readAround(
        screenX: number,
        screenY: number,
        margin: number,
        width: number,
        height: number
    ): Promise<DepthAt> {
        const blockX = Math.max(0, screenX - margin);
        const blockY = Math.max(0, screenY - margin);
        const blockWidth = Math.min(width - 1, screenX + margin) - blockX + 1;
        const blockHeight = Math.min(height - 1, screenY + margin) - blockY + 1;

        const pixels = (await this.texture!.read(blockX, blockY, blockWidth, blockHeight, {
            renderTarget: this.target!,
            immediate: true
        })) as Uint16Array;

        return (x: number, y: number, trial: number) => {
            const localX = x - blockX;
            const localY = y - blockY;
            if (localX < 0 || localX >= blockWidth || localY < 0 || localY >= blockHeight) {
                return null;
            }
            return half2Float(pixels[(localY * blockWidth + localX) * 4 + trial]);
        };
    }

    pick(x: number, y: number): Promise<Vec3 | null> {
        return this.queue.run(async () => {
            const sample = await this.prepare();
            if (!sample) return null;
            const { width, height, pickCamera } = sample;
            const screenX = clampPixel(x, width);
            const screenY = clampPixel(y, height);
            const depthAt = await this.readAround(screenX, screenY, SURFACE_RADIUS_PX, width, height);
            const depth = surfaceDepth(depthAt, screenX, screenY);
            return depth === null ? null : getWorldPoint(pickCamera, screenX, screenY, width, height, depth);
        }, null);
    }

    pickSurface(x: number, y: number): Promise<PickSurface | null> {
        return this.queue.run(async () => {
            const sample = await this.prepare();
            if (!sample) return null;
            const { width, height, pickCamera } = sample;
            const screenX = clampPixel(x, width);
            const screenY = clampPixel(y, height);
            const depthAt = await this.readAround(
                screenX,
                screenY,
                NORMAL_SAMPLE_MAX_PX + SURFACE_RADIUS_PX,
                width,
                height
            );
            return estimateSurface(depthAt, pickCamera, width, height, screenX, screenY);
        }, null);
    }

    pickVisibility(
        points: readonly { x: number; y: number; depth: number }[],
        radius: number
    ): Promise<(number | null)[]> {
        if (points.length === 0) {
            return Promise.resolve([]);
        }
        return this.queue.run(
            async () => {
                const sample = await this.prepare();
                if (!sample) return points.map((): null => null);
                const { width, height, pickCamera } = sample;
                const r = Math.max(1, Math.round(radius * height));
                return Promise.all(
                    points.map(async ({ x, y, depth }) => {
                        const screenX = clampPixel(x, width);
                        const screenY = clampPixel(y, height);
                        const depthAt = await this.readAround(screenX, screenY, r, width, height);
                        return opacityInFront(depthAt, pickCamera, screenX, screenY, r, depth);
                    })
                );
            },
            points.map((): null => null)
        );
    }

    // The last frame's snapshot, for the debug overlay; it asks after each frame, so the frame
    // is the current camera's.
    renderView() {
        if (this.queue.released) return null;
        const frame = this.renderer.depthFrame;
        if (!frame || !this.snapshot(frame, false)) return null;
        return { texture: this.texture!, renders: this.renders };
    }

    release() {
        this.queue.released = true;
        for (const done of [...this.waiters]) done();
        this.target?.destroy();
        this.texture?.destroy();
        this.target = null;
        this.texture = null;
        this.shader.destroy();
    }
}

export { FrameDepthPicker };
