import decoderSource from '../../lib/gsaf/gsaf-decoder.js';

/** The header facts the player needs, read once when the file opens. */
type GsafHeader = {
    frameCount: number;
    maxSplats: number;
    fps?: number;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    /** Asset to canonical (y up, -z forward) rotation, `[w, x, y, z]`. */
    canonicalRotation?: [number, number, number, number];
    canonicalTranslation?: [number, number, number];
};

/**
 * One decoded frame in the layout of the engine's default container format, padded to the
 * texture size: centers as RGBA32F, colors, scales and rotations as RGBA16F (half floats), plus
 * the xyz centers the sorter reads. The same buffers travel to the worker and back for every
 * frame, so playback allocates nothing.
 */
type GsafFrameBuffers = {
    center: Float32Array;
    color: Uint16Array;
    scale: Uint16Array;
    rotation: Uint16Array;
    centers: Float32Array;
};

type GsafFrame = GsafFrameBuffers & { index: number; count: number };

// The worker's code. It runs in the worker after the decoder glue, which defines
// `createGsafModule`, so it is stringified and must not reference anything outside itself.
function gsafWorker() {
    type Slot = {
        splatCount: number;
        positionsPtr(): number;
        rotationsPtr(): number;
        scalesPtr(): number;
        colorsPtr(): number;
    };
    type Reader = {
        header(): {
            frameCount: number;
            assetBounds: { min: number[]; max: number[] };
            metadata?: { fps?: number; canonicalRotation?: number[]; canonicalTranslation?: number[] };
        };
        frameInfo(i: number): { splatCount: number };
        frameSlot(i: number): Slot;
        decodeFrameInto(i: number, slot: number): void;
    };
    type Module = {
        HEAPF32: Float32Array;
        WasmReader: { openFromBytes(bytes: Uint8Array): Reader | null };
        gsafLastError(): string;
    };
    const scope = self as unknown as {
        createGsafModule(options: {
            instantiateWasm(
                imports: WebAssembly.Imports,
                done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
            ): object;
        }): Promise<Module>;
        onmessage: (event: MessageEvent) => void;
        postMessage(message: unknown, transfer?: Transferable[]): void;
    };

    let module: Module | null = null;
    let reader: Reader | null = null;

    // float to half, rounding to nearest
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    const toHalf = (value: number) => {
        f32[0] = value;
        const x = u32[0];
        const sign = (x >>> 16) & 0x8000;
        const exponent = ((x >>> 23) & 0xff) - 112;
        const mantissa = x & 0x7fffff;
        if (exponent <= 0) {
            if (exponent < -10) return sign;
            return sign | ((((mantissa | 0x800000) >> (1 - exponent)) + 0x1000) >> 13);
        }
        if (exponent >= 31) return sign | 0x7c00;
        return sign | ((exponent << 10) + ((mantissa + 0x1000) >> 13));
    };

    // the decoder arrives compiled, so the glue instantiates it rather than fetching it
    const open = async (bytes: ArrayBuffer, wasm: WebAssembly.Module) => {
        module = await scope.createGsafModule({
            instantiateWasm: (imports, done) => {
                WebAssembly.instantiate(wasm, imports).then((instance) => done(instance, wasm));
                return {};
            }
        });
        reader = module.WasmReader.openFromBytes(new Uint8Array(bytes));
        if (!reader) throw new Error(`gsaf: ${module.gsafLastError()}`);
        const h = reader.header();
        let maxSplats = 0;
        for (let i = 0; i < h.frameCount; i++) {
            maxSplats = Math.max(maxSplats, reader.frameInfo(i).splatCount);
        }
        return {
            frameCount: h.frameCount,
            maxSplats,
            fps: h.metadata?.fps,
            boundsMin: Array.from(h.assetBounds.min),
            boundsMax: Array.from(h.assetBounds.max),
            canonicalRotation: h.metadata?.canonicalRotation && Array.from(h.metadata.canonicalRotation),
            canonicalTranslation: h.metadata?.canonicalTranslation && Array.from(h.metadata.canonicalTranslation)
        };
    };

    const decode = (index: number, frame: GsafFrame) => {
        reader.decodeFrameInto(index, 0);
        const slot = reader.frameSlot(0);
        const n = slot.splatCount;
        // read after the decode: a heap growth inside it replaces the buffer
        const heap = module.HEAPF32;
        const positions = heap.subarray(slot.positionsPtr() >> 2, (slot.positionsPtr() >> 2) + n * 3);
        const rotations = heap.subarray(slot.rotationsPtr() >> 2, (slot.rotationsPtr() >> 2) + n * 4);
        const scales = heap.subarray(slot.scalesPtr() >> 2, (slot.scalesPtr() >> 2) + n * 3);
        const colors = heap.subarray(slot.colorsPtr() >> 2, (slot.colorsPtr() >> 2) + n * 4);
        const { center, color, scale, rotation, centers } = frame;
        for (let i = 0; i < n; i++) {
            const i3 = i * 3;
            const i4 = i * 4;
            center[i4] = centers[i3] = positions[i3];
            center[i4 + 1] = centers[i3 + 1] = positions[i3 + 1];
            center[i4 + 2] = centers[i3 + 2] = positions[i3 + 2];
            scale[i4] = toHalf(scales[i3]);
            scale[i4 + 1] = toHalf(scales[i3 + 1]);
            scale[i4 + 2] = toHalf(scales[i3 + 2]);
            // both are w, x, y, z / r, g, b, a, as the default format reads them
            for (let c = 0; c < 4; c++) {
                rotation[i4 + c] = toHalf(rotations[i4 + c]);
                color[i4 + c] = toHalf(colors[i4 + c]);
            }
        }
        frame.index = index;
        frame.count = n;
        return frame;
    };

    scope.onmessage = async (event: MessageEvent) => {
        const { type } = event.data;
        try {
            if (type === 'open') {
                scope.postMessage({ type, header: await open(event.data.bytes, event.data.wasm) });
            } else if (type === 'decode') {
                const frame = decode(event.data.index, event.data.frame);
                const { center, color, scale, rotation, centers } = frame;
                scope.postMessage({ type, frame }, [
                    center.buffer,
                    color.buffer,
                    scale.buffer,
                    rotation.buffer,
                    centers.buffer
                ]);
            }
        } catch (err) {
            scope.postMessage({ type: 'error', message: (err as Error)?.message ?? String(err) });
        }
    };
}

// The decoder's wasm, fetched and compiled once per url for the page, so a second viewer or a
// remount reuses it. A failed compile is forgotten, so the next load tries again.
const compiled = new Map<string, Promise<WebAssembly.Module>>();

/**
 * Fetches and compiles the decoder's wasm, streaming where the response is served as
 * `application/wasm`.
 *
 * @param url - The wasm's url; by default the file shipped beside the bundle.
 * @returns The compiled module.
 */
const compileGsafDecoder = (url?: string) => {
    // a literal `new URL(..., import.meta.url)`, so a host's bundler emits the file with its own
    const href = url ?? new URL('./gsaf-decoder.wasm', import.meta.url).href;
    let module = compiled.get(href);
    if (!module) {
        module = (async () => {
            const response = await fetch(href);
            if (!response.ok) {
                throw new Error(`gsaf: ${response.status} ${response.statusText} fetching the decoder ${href}`);
            }
            try {
                return await WebAssembly.compileStreaming(response.clone());
            } catch {
                // a server that does not send application/wasm
                return WebAssembly.compile(await response.arrayBuffer());
            }
        })();
        compiled.set(href, module);
        module.catch(() => compiled.delete(href));
    }
    return module;
};

/**
 * The gsaf decoder in a worker, so decoding never stalls the main thread. One request is in
 * flight at a time.
 */
class GsafDecoder {
    private worker: Worker;

    private pending: { resolve: (data: unknown) => void; reject: (err: Error) => void } | null = null;

    constructor() {
        const source = `${decoderSource}\n(${gsafWorker.toString()})();\n`;
        const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        this.worker = new Worker(url);
        URL.revokeObjectURL(url);
        this.worker.onmessage = (event: MessageEvent) => {
            const pending = this.pending;
            this.pending = null;
            if (event.data.type === 'error') {
                pending?.reject(new Error(event.data.message));
            } else {
                pending?.resolve(event.data);
            }
        };
        this.worker.onerror = (event: ErrorEvent) => {
            const pending = this.pending;
            this.pending = null;
            pending?.reject(new Error(event.message || 'gsaf: the decoder worker failed'));
        };
    }

    private stopped = false;

    private request<T>(type: string, message: object, transfer: Transferable[]) {
        if (this.stopped) return Promise.reject(new Error('gsaf: the decoder was stopped'));
        return new Promise<T>((resolve, reject) => {
            this.pending = { resolve: resolve as (data: unknown) => void, reject };
            this.worker.postMessage({ type, ...message }, transfer);
        });
    }

    /**
     * Opens the file; the bytes are transferred to the worker.
     *
     * @param bytes - The file.
     * @param wasm - The decoder, from {@link compileGsafDecoder}.
     * @returns The file's header.
     */
    async open(bytes: ArrayBuffer, wasm: WebAssembly.Module) {
        const { header } = await this.request<{ header: GsafHeader }>('open', { bytes, wasm }, [bytes]);
        return header;
    }

    /** Decodes a frame into the given buffers, which come back with it. */
    async decode(index: number, buffers: GsafFrameBuffers) {
        const { center, color, scale, rotation, centers } = buffers;
        const { frame } = await this.request<{ frame: GsafFrame }>(
            'decode',
            { index, frame: { ...buffers, index, count: 0 } },
            [center.buffer, color.buffer, scale.buffer, rotation.buffer, centers.buffer]
        );
        return frame;
    }

    /** Stops the worker. A request in flight, and any made after, rejects. Idempotent. */
    destroy() {
        if (this.stopped) return;
        this.stopped = true;
        this.worker.terminate();
        const pending = this.pending;
        this.pending = null;
        pending?.reject(new Error('gsaf: the decoder was stopped'));
    }
}

export { compileGsafDecoder, GsafDecoder };
export type { GsafFrame, GsafFrameBuffers, GsafHeader };
