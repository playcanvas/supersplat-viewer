import { Vec3 } from 'playcanvas';
import type { AppBase, Entity } from 'playcanvas';

import { createQuad, uploadQuad } from './xr-palm-menu';
import type { Quad } from './xr-palm-menu';

// The panel, in the camera's space (meters): low and to the left of the view, a metre away, out of
// the scene's middle but a glance from it, drawn at PIXELS per meter and redrawn every INTERVAL
// seconds, often enough to read and seldom enough not to cost a frame
const POSITION = new Vec3(-0.28, -0.22, -1);
const WIDTH = 0.3;
const HEIGHT = 0.045;
const PIXELS = 1600;
const INTERVAL = 0.25;

/**
 * Frame numbers in an XR session, which hides the page's MiniStats: frames a second, the frame's
 * time and the GPU's, head-locked low in the view while `enabled`. The GPU's time needs the
 * device's GPU profiler, which the panel turns on while it shows and puts back as it was.
 */
class XrStats {
    private app: AppBase;

    private quad: Quad;

    private value = false;

    private profilerWas = false;

    private wait = 0;

    private handle: { off(): void };

    /**
     * @param app - The application.
     * @param camera - The XR camera's entity, which the panel follows.
     */
    constructor(app: AppBase, camera: Entity) {
        this.app = app;
        // facing the camera's +z, back at the eyes from in front of them
        this.quad = createQuad(app, camera, WIDTH, HEIGHT, PIXELS);
        this.quad.entity.setLocalPosition(POSITION);
        this.handle = app.on('update', (dt: number) => this.update(dt));
    }

    get enabled() {
        return this.value;
    }

    set enabled(value: boolean) {
        if (value === this.value) return;
        this.value = value;
        const profiler = this.app.graphicsDevice.gpuProfiler;
        if (profiler) {
            if (value) {
                this.profilerWas = profiler.enabled;
                profiler.enabled = true;
            } else {
                profiler.enabled = this.profilerWas;
            }
        }
        this.wait = 0;
        this.quad.entity.enabled = value && this.app.xr.active;
    }

    destroy() {
        this.enabled = false;
        this.handle.off();
        this.quad.entity.destroy();
        this.quad.material.destroy();
        this.quad.texture.destroy();
    }

    private update(dt: number) {
        const shown = this.value && this.app.xr.active;
        this.quad.entity.enabled = shown;
        if (!shown) return;
        this.wait -= dt;
        if (this.wait > 0) return;
        this.wait = INTERVAL;
        this.draw();
    }

    private draw() {
        const { fps, frameTime, gpuFrameTime } = this.app.stats;
        const gpu = gpuFrameTime === undefined ? '–' : gpuFrameTime.toFixed(1);
        const text = `${fps} fps   ${frameTime.toFixed(1)} ms   GPU ${gpu} ms`;
        const { canvas } = this.quad;
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(20, 22, 28, 0.78)';
        ctx.beginPath();
        ctx.roundRect(1, 1, width - 2, height - 2, height * 0.3);
        ctx.fill();
        ctx.font = `500 ${Math.round(height * 0.46)}px ui-monospace, Menlo, monospace`;
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, height * 0.36, height / 2);
        uploadQuad(this.quad);
    }
}

export { XrStats };
