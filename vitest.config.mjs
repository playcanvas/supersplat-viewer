import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// The dist build turns these three files into strings with `rollup-plugin-string`
// (rollup.config.mjs). Vite has no usable equivalent here: it decides a module is css from
// the id's extension, and under vitest's ssr transform even `index.css?raw` resolves to an
// empty module. So map these imports onto `\0`-prefixed virtual ids that carry no extension
// — vite leaves those alone — and read the files directly.
const PREFIX = '\0viewer-raw:';

const files = {
    '../../public/index.html': './public/index.html',
    '../../public/index.css': './public/index.css',
    '../../public/index.js': './public/index.js'
};

const keys = Object.fromEntries(Object.keys(files).map((source, index) => [source, String(index)]));
const paths = Object.fromEntries(Object.entries(files).map(([source, file]) => [keys[source], file]));

const viewerRawStrings = {
    name: 'viewer-raw-strings',
    enforce: 'pre',
    resolveId(source) {
        return keys[source] ? PREFIX + keys[source] : null;
    },
    load(id) {
        if (!id.startsWith(PREFIX)) {
            return null;
        }
        const file = paths[id.slice(PREFIX.length)];
        return `export default ${JSON.stringify(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8'))};`;
    }
};

export default defineConfig({
    plugins: [viewerRawStrings]
});
