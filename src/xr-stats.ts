import { Vec3 } from 'playcanvas';
import type { AppBase, Entity } from 'playcanvas';

import { createQuad, uploadQuad } from './xr-palm-menu';
import type { Quad } from './xr-palm-menu';

// The panel, in the camera's space (meters): low and to the left of the view, a metre away, out of
// the scene's middle but a glance from it, LINES lines of LINE_HEIGHT drawn at PIXELS per meter
// and redrawn every INTERVAL seconds, often enough to read and seldom enough not to cost a frame
const POSITION = new Vec3(-0.24, -0.28, -1);
const WIDTH = 0.36;
const LINES = 3;
const LINE_HEIGHT = 0.034;
const HEIGHT = LINES * LINE_HEIGHT + 0.012;
const PIXELS = 1600;
const INTERVAL = 0.25;

/**
 * Frame numbers in an XR session, which hides the page's MiniStats: the frame's time (and frames a
 * second), the GPU's time, and the splats the level of detail selected (the page's MiniStats'
 * Splats), a line each, head-locked low in the view while `enabled` in a session. The GPU's time
 * needs the device's GPU profiler, which the panel turns on while it shows and puts back as it was.
 */
class XrStats {
    private app: AppBase;

    private quad: Quad;

    private value = false;

    // whether the panel has the profiler on, and what it was before
    private profiling = false;

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
        this.wait = 0;
        this.show(value && this.app.xr.active);
    }

    destroy() {
        this.show(false);
        this.handle.off();
        this.quad.entity.destroy();
        this.quad.material.destroy();
        this.quad.texture.destroy();
    }

    // shows or hides the panel, the gpu profiler on only while it shows (it costs every frame's
    // passes their timestamps), and put back as it was after: a session's end hides it too
    private show(shown: boolean) {
        this.quad.entity.enabled = shown;
        if (shown === this.profiling) return;
        this.profiling = shown;
        const profiler = this.app.graphicsDevice.gpuProfiler;
        if (!profiler) return;
        if (shown) {
            this.profilerWas = profiler.enabled;
            profiler.enabled = true;
        } else {
            profiler.enabled = this.profilerWas;
        }
    }

    private update(dt: number) {
        const shown = this.value && this.app.xr.active;
        this.show(shown);
        if (!shown) return;
        this.wait -= dt;
        if (this.wait > 0) return;
        this.wait = INTERVAL;
        this.draw();
    }

    private draw() {
        const { fps, frameTime, gpuFrameTime, frame } = this.app.stats;
        const gpu = gpuFrameTime === undefined ? '–' : gpuFrameTime.toFixed(1);
        const lines = [
            `Frame:  ${frameTime.toFixed(1)} ms (${fps} fps)`,
            `GPU:    ${gpu} ms`,
            `Splats: ${(frame.gsplats / 1e6).toFixed(2)}M`
        ];
        const { canvas } = this.quad;
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        const line = LINE_HEIGHT * PIXELS;
        const left = line * 0.4;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(20, 22, 28, 0.78)';
        ctx.beginPath();
        ctx.roundRect(1, 1, width - 2, height - 2, line * 0.4);
        ctx.fill();
        // the type smaller where the longest line would run off the panel
        const font = (size: number) => `500 ${size}px ui-monospace, Menlo, monospace`;
        const size = Math.round(line * 0.6);
        ctx.font = font(size);
        const widest = Math.max(...lines.map((text) => ctx.measureText(text).width));
        const room = width - 2 * left;
        if (widest > room) ctx.font = font(Math.floor((size * room) / widest));
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        const top = (height - lines.length * line) / 2;
        lines.forEach((text, i) => ctx.fillText(text, left, top + (i + 0.5) * line));
        uploadQuad(this.quad);
    }
}

export { XrStats };
