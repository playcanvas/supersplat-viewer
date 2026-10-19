import type { AppBase, EventHandle } from 'playcanvas';

type GpuQueue = { onSubmittedWorkDone(): Promise<void> };

/**
 * Holds the viewer's continuous on-demand renders while the gpu is behind. Browsers let a page
 * queue frames far ahead of a busy gpu: a turn of the flat view ran 80-140 ms behind its input in
 * Safari on Apple Vision Pro, about 110 ms in Chrome on a Pixel 7 Pro with WebGPU and 400 ms with
 * WebGL (docs/frames-in-flight.md). The renders asked for every frame (the camera moving, the
 * stochastic renderer accumulating) go through {@link FrameGate#request}, which holds them while
 * `limit` rendered frames have not finished on the gpu and renders as soon as one does, with the
 * camera where it is by then. One-shot requests (captures, picks, scrubbing, screenshots, streamed
 * detail) still set `renderNextFrame` themselves, as they wait for the frame they asked for. The
 * gate is open with a limit of 0 and while the app renders every frame (loading, XR sessions,
 * which the compositor paces). WebGPU reports a frame's completion with a promise; WebGL with a
 * fence, checked at the start of every tick.
 */
class FrameGate {
    /** The most rendered frames the gpu may have unfinished before a request waits; 0 is off. */
    limit: number;

    /** Requests that waited for the gpu, for measuring the gate. */
    held = 0;

    private app: AppBase;

    private queue: GpuQueue | null;

    private gl: WebGL2RenderingContext | null;

    // a WebGL fence per rendered frame the gpu has not finished, oldest first
    private fences: WebGLSync[] = [];

    // rendered frames the gpu has not finished
    private pending = 0;

    // a request waiting for one to finish
    private owed = false;

    private rendered = false;

    private destroyed = false;

    private handles: EventHandle[];

    /**
     * @param app - The application.
     * @param limit - The most unfinished frames before a request waits; 0 is off.
     */
    constructor(app: AppBase, limit: number) {
        this.app = app;
        this.limit = limit;
        const device = app.graphicsDevice as { wgpu?: { queue: GpuQueue }; gl?: WebGL2RenderingContext };
        this.queue = device.wgpu?.queue ?? null;
        this.gl = this.queue ? null : (device.gl ?? null);
        this.handles = [
            app.on('frameupdate', () => this.poll()),
            app.on('postrender', () => {
                this.rendered = true;
            }),
            app.on('frameend', () => this.frameEnd())
        ];
    }

    /** Renders the next frame, or once the gpu has caught up. */
    request() {
        if (this.limit > 0 && !this.app.autoRender && this.pending >= this.limit) {
            if (!this.owed) this.held++;
            this.owed = true;
            return;
        }
        this.app.renderNextFrame = true;
    }

    destroy() {
        this.destroyed = true;
        for (const handle of this.handles) handle.off();
        const { gl } = this;
        if (gl && !gl.isContextLost()) {
            for (const fence of this.fences) gl.deleteSync(fence);
        }
        this.fences.length = 0;
    }

    // a rendered frame's work is all submitted by its end
    private frameEnd() {
        if (!this.rendered) return;
        this.rendered = false;
        if (this.queue) {
            this.pending++;
            // a lost device settles it either way
            this.queue.onSubmittedWorkDone().then(
                () => this.finished(),
                () => this.finished()
            );
        } else if (this.gl) {
            const fence = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (fence) {
                this.fences.push(fence);
                this.pending++;
            }
        }
    }

    // the WebGL frames finished since the last tick; a lost context finishes them all
    private poll() {
        const { gl, fences } = this;
        if (!gl || !fences.length) return;
        if (gl.isContextLost()) {
            fences.length = 0;
            this.pending = 0;
            this.finished();
            return;
        }
        while (fences.length && gl.getSyncParameter(fences[0], gl.SYNC_STATUS) === gl.SIGNALED) {
            gl.deleteSync(fences.shift());
            this.finished();
        }
    }

    // One-shot renders and frames rendered while the gate was open (loading) can leave more than
    // limit frames unfinished, so a completion grants the owed render only once the gpu is under
    // the limit, or the gate is open
    private finished() {
        this.pending = Math.max(this.pending - 1, 0);
        const open = this.limit <= 0 || this.app.autoRender || this.pending < this.limit;
        if (this.owed && open && !this.destroyed) {
            this.owed = false;
            this.app.renderNextFrame = true;
        }
    }
}

export { FrameGate };
