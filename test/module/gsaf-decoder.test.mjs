import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The `/gsaf-decoder` entry: the decoder's wasm as a data: url, for a document with no sibling
// files. Run `npm run build` first (`npm test` does both).
import { gsafDecoderDataUrl } from '../../dist/gsaf-decoder.js';
import { renderViewerHtml } from '../../dist/index.js';

const PREFIX = 'data:application/wasm;base64,';

describe('the /gsaf-decoder entry', () => {
    it('is the shipped wasm, as a data: url the browser serves as application/wasm', async () => {
        assert.ok(gsafDecoderDataUrl.startsWith(PREFIX));
        const bytes = Buffer.from(gsafDecoderDataUrl.slice(PREFIX.length), 'base64');
        assert.deepEqual(bytes, readFileSync(new URL('../../dist/gsaf-decoder.wasm', import.meta.url)));
        await WebAssembly.compile(bytes);
    });

    it('rides in the bootstrap of a self-contained document', () => {
        const document = renderViewerHtml({
            bootstrap: {
                contentUrl: 'data:application/octet-stream;base64,AAAA',
                contentFilename: 'scene.gsaf',
                gsafDecoderUrl: gsafDecoderDataUrl
            },
            inlineCss: true,
            inlineJs: true
        });
        const block = document.match(/<script type="application\/json" id="sse-bootstrap">([\s\S]*?)<\/script>/);
        assert.equal(JSON.parse(block[1]).gsafDecoderUrl, gsafDecoderDataUrl);
    });
});
