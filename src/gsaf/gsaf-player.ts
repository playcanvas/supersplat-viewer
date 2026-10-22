import { Entity, GSplatContainer, GSplatFormat, Quat, Vec3, WORKBUFFER_UPDATE_ONCE } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { compileGsafDecoder, GsafDecoder } from './gsaf-worker';
import type { GsafFrame, GsafFrameBuffers } from './gsaf-worker';

// the playback rate when the file carries no fps hint
const DEFAULT_FPS = 30;

const STREAMS = [
    ['dataCenter', 'center'],
    ['dataColor', 'color'],
    ['dataScale', 'scale'],
    ['dataRotation', 'rotation']
] as const;

// Reads the response whole, reporting progress. Chunks are gathered rather than written into a
// buffer of the declared length, which is the compressed length when the server encodes it.
const readBytes = async (response: Response, progressCallback: (progress: number) => void) => {
    if (!response.ok) {
        throw new Error(`gsaf: ${response.status} ${response.statusText} fetching ${response.url}`);
    }
    const length = Number(response.headers.get('content-length')) || 0;
    if (!response.body || !length) {
        return response.arrayBuffer();
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        progressCallback(Math.trunc(Math.min(1, received / length) * 100));
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes.buffer;
};

/**
 * An animated splat sequence playing through a container. The viewer's timeline drives it:
 * {@link paused} stops its clock, {@link seek} moves it and {@link time} is where it is. Each
 * update decodes the frame due at that time, in a worker, so a slow decode skips frames rather
 * than slowing playback; the decoder continues forward from the frame it holds and replays from
 * the last keyframe to go back. Destroying {@link entity} stops it and releases the worker and
 * the container.
 */
class GsafPlayer {
    /** The gsplat entity, showing the frame at {@link time}. */
    readonly entity: Entity;

    /**
     * Whether the sequence plays: more than one frame, on WebGPU. WebGL shows the first frame
     * only, since its sorter is asynchronous and lands a frame or more behind the data, and gsaf
     * reorders splats from frame to frame (survivors in their previous order, births appended),
     * so an order computed for one frame is wrong for the next.
     */
    readonly animated: boolean;

    /** Length of the sequence in seconds. */
    readonly duration: number;

    /** Stops the clock; paused until the viewer starts it. */
    paused = true;

    private app: AppBase;

    private decoder: GsafDecoder;

    private fps: number;

    private frameCount: number;

    private _time = 0;

    // the frame on screen, and the buffers it came in, null while a decode has them
    private shown = 0;

    private buffers: GsafFrameBuffers | null;

    // seeks waiting for their frame
    private waiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

    // a decode that failed, after which the player shows its last frame and every seek fails
    private failure: Error | null = null;

    private destroyed = false;

    constructor(
        app: AppBase,
        entity: Entity,
        decoder: GsafDecoder,
        frameCount: number,
        fps: number,
        first: GsafFrame,
        animated: boolean
    ) {
        this.app = app;
        this.entity = entity;
        this.decoder = decoder;
        this.frameCount = frameCount;
        this.fps = fps;
        this.duration = frameCount / fps;
        this.buffers = first;
        this.animated = animated;

        const onUpdate = (dt: number) => {
            if (!this.paused) this._time = (this._time + dt) % this.duration;
            this.pump();
        };
        if (animated) app.on('update', onUpdate);

        entity.once('destroy', () => {
            this.destroyed = true;
            app.off('update', onUpdate);
            this.settle();
        });
    }

    /** The playhead, in seconds from the start of the sequence. */
    get time() {
        return this._time;
    }

    /**
     * Moves the playhead, wrapping it into the sequence.
     *
     * @param time - The time in seconds.
     * @returns Resolves once the frame at that time is on screen, or the player is destroyed;
     * rejects once a decode has failed.
     */
    seek(time: number) {
        if (this.failure) return Promise.reject(this.failure);
        if (!this.animated) return Promise.resolve();
        // a time already in range is kept exactly, so it lands on the frame it names
        const wrapped = time % this.duration;
        this._time = wrapped < 0 ? wrapped + this.duration : wrapped;
        const landed = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
        this.pump();
        return landed;
    }

    private settle(err?: Error) {
        const { waiters } = this;
        this.waiters = [];
        for (const waiter of waiters) {
            if (err) waiter.reject(err);
            else waiter.resolve();
        }
    }

    // decode the frame due now, unless it is on screen or a decode is already in flight
    private pump() {
        if (this.destroyed || this.failure || !this.buffers) return;
        // a frame's own start time can land a rounding error short of it
        const due = Math.min(this.frameCount - 1, Math.floor(this._time * this.fps + 1e-6));
        if (due === this.shown) {
            this.settle();
            return;
        }
        const buffers = this.buffers;
        this.buffers = null;
        this.decoder.decode(due, buffers).then(
            (frame) => {
                // the worker is terminated with the entity, so this only runs while alive
                uploadFrame(this.app, this.entity.gsplat.resource as GSplatContainer, frame);
                // the engine re-copies a resource into its work buffer only when its allocation
                // changes, and a frame keeps the container's, so ask for the copy
                this.entity.gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
                this.shown = frame.index;
                this.buffers = frame;
                this.pump();
            },
            (err: Error) => {
                // the worker was terminated with the entity
                if (this.destroyed) return;
                console.error(err);
                this.failure = err;
                this.settle(err);
            }
        );
    }
}

const uploadFrame = (app: AppBase, container: GSplatContainer, frame: GsafFrame) => {
    for (const [name, key] of STREAMS) {
        const texture = container.getTexture(name);
        texture.lock().set(frame[key]);
        texture.unlock();
    }
    container.centers.set(frame.centers.subarray(0, frame.count * 3));
    container.update(frame.count);
    app.renderNextFrame = true;
};

/**
 * Loads a gsaf file (an animated, compressed splat sequence) into a {@link GsafPlayer}. Frames
 * are decoded in a worker and written into a {@link GSplatContainer} in the engine's default
 * float format, which takes gsaf's render-ready values (linear scales, `w, x, y, z` rotations,
 * activated colors) as they are.
 *
 * @param app - The application.
 * @param response - The file's response.
 * @param decoderUrl - The decoder's wasm, if not the file beside the bundle.
 * @param progressCallback - Receives the download progress, 0 to 100.
 * @param signal - Aborted when the viewer is destroyed. Its handlers run before the app's own
 * destroy, so a load in flight releases its worker and container while the device is alive.
 * @returns The player, paused on the first frame.
 */
const loadGsaf = async (
    app: AppBase,
    response: Promise<Response>,
    decoderUrl: string | undefined,
    progressCallback: (progress: number) => void,
    signal: AbortSignal
) => {
    const fail = () => new Error('loadGsaf: the viewer was destroyed while loading');

    // the decoder compiles while the file downloads
    const wasm = compileGsafDecoder(decoderUrl);
    wasm.catch(() => {
        // reported by the await below, once the download is done
    });
    const bytes = await readBytes(await response, progressCallback);
    if (signal.aborted) throw fail();
    const compiledWasm = await wasm;
    if (signal.aborted) throw fail();

    const decoder = new GsafDecoder();
    let container: GSplatContainer | null = null;
    // until the entity owns them, a destroy stops the worker at once, which rejects the request
    // it was serving, and frees the container
    const onAbort = () => {
        decoder.destroy();
        container?.destroy();
        container = null;
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const header = await decoder.open(bytes, compiledWasm);
        if (signal.aborted) throw fail();

        const device = app.graphicsDevice;
        container = new GSplatContainer(device, header.maxSplats, GSplatFormat.createDefaultFormat(device));
        container.aabb.setMinMax(new Vec3(header.boundsMin), new Vec3(header.boundsMax));

        const texture = container.getTexture('dataCenter');
        const capacity = texture.width * texture.height * 4;
        const first = await decoder.decode(0, {
            center: new Float32Array(capacity),
            color: new Uint16Array(capacity),
            scale: new Uint16Array(capacity),
            rotation: new Uint16Array(capacity),
            centers: new Float32Array(header.maxSplats * 3)
        });
        if (signal.aborted) throw fail();
        signal.removeEventListener('abort', onAbort);
        uploadFrame(app, container, first);

        // always name the app: the engine's default is the most recently created one, which is
        // another viewer's when two share a page
        const entity = new Entity('gsplat', app);
        if (header.canonicalRotation) {
            // the canonical frame is y up and -z forward, the engine's own
            const [w, x, y, z] = header.canonicalRotation;
            entity.setLocalRotation(new Quat(x, y, z, w));
            if (header.canonicalTranslation) {
                entity.setLocalPosition(new Vec3(header.canonicalTranslation));
            }
        } else {
            entity.setLocalEulerAngles(0, 0, 180);
        }
        entity.addComponent('gsplat', {
            unified: true,
            resource: container
        });
        app.root.addChild(entity);

        const animated = header.frameCount > 1 && device.isWebGPU;
        if (!animated) decoder.destroy();

        const owned = container;
        entity.once('destroy', () => {
            decoder.destroy();
            owned.destroy();
        });

        const fps = header.fps > 0 ? header.fps : DEFAULT_FPS;
        return new GsafPlayer(app, entity, decoder, header.frameCount, fps, first, animated);
    } catch (err) {
        signal.removeEventListener('abort', onAbort);
        decoder.destroy();
        container?.destroy();
        throw signal.aborted ? fail() : err;
    }
};

export { GsafPlayer, loadGsaf };
