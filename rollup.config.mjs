import { readFileSync } from 'fs';

import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import { dts } from 'rollup-plugin-dts';
import scss from 'rollup-plugin-scss';
import { string } from 'rollup-plugin-string';
import sass from 'sass';

function htmlPlugin() {
    return {
        name: 'html',
        buildStart() {
            this.addWatchFile('src/index.html');
            this.addWatchFile('src/dev/mount-loop.html');
        },
        generateBundle() {
            const contents = readFileSync('src/index.html', 'utf-8');
            // Matched as a pattern, not an exact string: prettier formats the tag as
            // `<base href="" />`, and an exact-string match silently no-ops when the
            // formatting shifts, shipping an empty base href to BASE_HREF deploys.
            const transformed = contents.replace(
                /<base\b[^>]*>/,
                () => `<base href="${process.env.BASE_HREF ?? ''}" />`
            );
            this.emitFile({
                type: 'asset',
                fileName: 'index.html',
                source: transformed
            });

            // Development page that mounts and destroys the viewer in a loop, to prove teardown
            // releases the graphics context. Served with `npm run develop`; not in package.json
            // `files`, so it never ships.
            this.emitFile({
                type: 'asset',
                fileName: 'mount-loop.html',
                source: readFileSync('src/dev/mount-loop.html', 'utf-8')
            });
        }
    };
}

const buildCss = {
    input: 'src/index.scss',
    output: {
        dir: 'public'
    },
    plugins: [
        scss({
            exclude: ['static/**/*'],
            fileName: 'index.css',
            // The `processor` below returns only `result.css`, so postcss's map is dropped and
            // no index.css.map is ever emitted. Asking for one just appends a sourceMappingURL
            // comment pointing at a file that does not exist, which 404s wherever the css is
            // served or inlined.
            sourceMap: false,
            runtime: sass,
            processor: (css) => {
                return postcss([autoprefixer])
                    .process(css, { from: undefined })
                    .then((result) => result.css);
            }
        }),
        {
            name: 'suppress-empty-chunks',
            generateBundle(options, bundle) {
                for (const [fileName, chunk] of Object.entries(bundle)) {
                    if (chunk.type === 'chunk' && chunk.code.trim() === '') {
                        delete bundle[fileName];
                    }
                }
            }
        }
    ]
};

const debugEngine = process.env.ENGINE === 'debug';

const buildPublic = {
    input: 'src/index.ts',
    output: {
        dir: 'public',
        format: 'esm',
        sourcemap: true
    },
    plugins: [resolve(debugEngine ? { exportConditions: ['development'] } : {}), typescript(), json(), htmlPlugin()]
};

const buildDist = {
    input: 'src/module/index.ts',
    output: {
        file: 'dist/index.js',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        string({
            include: ['**/*.html', '**/*.css', '**/*.js']
        }),
        typescript({ noEmit: true }),
        json()
    ]
};

const buildSettings = {
    input: 'src/settings.ts',
    output: {
        file: 'dist/settings.js',
        format: 'esm',
        sourcemap: true
    },
    plugins: [typescript({ noEmit: true })]
};

// Declarations are bundled from the source, so the published types cannot drift from the
// implementation. Each entry produces one flat .d.ts with no internal modules exposed.
const buildDistTypes = {
    input: 'src/module/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    // The three `public/` imports are strings at runtime and `string` in the declarations
    // (via the ambient `declare module '*.css'` in types.d.ts), so there is nothing for the
    // declaration bundler to read. Treat them as external and let tree-shaking drop them.
    external: [/public\/index\.(css|html|js)$/],
    plugins: [dts()]
};

const buildSettingsTypes = {
    input: 'src/settings.ts',
    output: { file: 'dist/settings.d.ts', format: 'es' },
    plugins: [dts()]
};

export default [buildCss, buildPublic, buildDist, buildSettings, buildDistTypes, buildSettingsTypes];
