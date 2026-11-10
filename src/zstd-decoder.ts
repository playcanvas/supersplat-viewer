import { WasmModule } from 'playcanvas';

import glueSource from '../lib/zstd/zstd-decoder.js';

// the glue's blob url, made once a page: every viewer on it shares the engine's module registry
let glueUrl: string | null = null;

/**
 * Registers the engine's ZSTD decoder, which the spz parser needs for version 4 files. Only the
 * urls are recorded here: the engine loads the glue and the wasm on the first version 4 file.
 *
 * @param wasmUrl - The decoder's wasm; by default the file shipped beside the bundle.
 */
const registerZstdDecoder = (wasmUrl?: string) => {
    glueUrl ??= URL.createObjectURL(new Blob([glueSource], { type: 'text/javascript' }));
    WasmModule.setConfig('ZstdDecoderModule', {
        glueUrl,
        // a literal `new URL(..., import.meta.url)`, so a host's bundler emits the file with its own
        wasmUrl: wasmUrl ?? new URL('./zstd-decoder.wasm', import.meta.url).href
    });
};

export { registerZstdDecoder };
