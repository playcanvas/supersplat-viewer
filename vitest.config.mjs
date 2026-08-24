import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The dist build turns these three files into strings with `rollup-plugin-string`
// (rollup.config.mjs). Vite has no usable equivalent here: it decides a module is css from
// the id's extension, and under vitest's ssr transform even `index.css?raw` resolves to an
// empty module. So map these imports onto `\0`-prefixed virtual ids that carry no extension
// — vite leaves those alone — and read the files directly.
//
// Matched on the resolved path rather than the caller's relative specifier, so an import from
// any directory depth works. Keying on the specifier would silently fall through to vite for
// an importer at a different depth, and vite returns an *empty* module for css — which reads
// as a passing test rather than a failure.
const PREFIX = '\0viewer-raw:';

// Token per asset, deliberately without a file extension: vite decides a module is css from
// the id, so `\0viewer-raw:index.css` would be claimed by its css pipeline just as the real
// path is.
const assets = [
    ['index.html', 'html'],
    ['index.css', 'css'],
    ['index.js', 'js']
];

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

const viewerRawStrings = {
    name: 'viewer-raw-strings',
    enforce: 'pre',
    resolveId(source) {
        const match = assets.find(([file]) => source.endsWith(`public/${file}`));
        return match ? PREFIX + match[1] : null;
    },
    load(id) {
        if (!id.startsWith(PREFIX)) {
            return null;
        }
        const token = id.slice(PREFIX.length);
        const match = assets.find(([, name]) => name === token);
        if (!match) {
            throw new Error(`viewer-raw-strings: unknown asset token "${token}"`);
        }
        return `export default ${JSON.stringify(readFileSync(`${publicDir}${match[0]}`, 'utf-8'))};`;
    }
};

export default defineConfig({
    plugins: [viewerRawStrings]
});
