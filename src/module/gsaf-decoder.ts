// The gsaf decoder's wasm as a `data:` url, for a document with no sibling files to fetch it from:
// a producer inlining the viewer into one html file sets it as the bootstrap's `gsafDecoderUrl`.
// Its own entry, so a consumer of `renderViewerHtml` that never writes such a document does not
// bundle a quarter of a megabyte of base64.
import wasm from '../../lib/gsaf/gsaf-decoder.wasm';

/** The gsaf decoder's wasm, as a `data:application/wasm;base64,…` url. */
const gsafDecoderDataUrl: string = wasm;

export { gsafDecoderDataUrl };
