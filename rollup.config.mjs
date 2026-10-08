import { copyFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';

import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import { dts } from 'rollup-plugin-dts';
import scss from 'rollup-plugin-scss';
import { string } from 'rollup-plugin-string';
import sass from 'sass';
import ts from 'typescript';

// Watch builds transpile each TypeScript file on its own. The typescript plugin, in watch mode,
// hands rollup the output of TypeScript's own watch program, which detects changes separately
// from rollup's watcher: when it misses one (a change landing during a build, a file replaced by
// git or an editor), rollup rebuilds with that file's previous output, and keeps it until
// TypeScript's watcher fires again, which may be never. Rollup reads every changed file itself,
// so transpiling what it passes cannot go stale. Type errors come from `npm run type:check`,
// which `npm run develop` runs in watch mode alongside.
function transpileTypescript() {
    const compilerOptions = {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        sourceMap: true,
        inlineSources: true
    };
    return {
        name: 'transpile-typescript',
        // relative imports name modules without their extension
        resolveId(source, importer) {
            if (!importer || !source.startsWith('.')) return null;
            const base = path.resolve(path.dirname(importer), source);
            return [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => existsSync(candidate)) ?? null;
        },
        transform(code, id) {
            if (!id.endsWith('.ts') || id.endsWith('.d.ts')) return null;
            const output = ts.transpileModule(code, { compilerOptions, fileName: id });
            return { code: output.outputText, map: JSON.parse(output.sourceMapText) };
        }
    };
}

const watching = process.env.ROLLUP_WATCH === 'true';
const typescriptPlugin = (options) => (watching ? transpileTypescript() : typescript(options));

function htmlPlugin() {
    return {
        name: 'html',
        buildStart() {
            this.addWatchFile('src/index.html');
            this.addWatchFile('src/dev/mount-loop.html');
            this.addWatchFile('src/dev/custom-ui.html');
            this.addWatchFile('src/dev/bench.html');
            this.addWatchFile('src/dev/remote.html');
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
            this.emitFile({
                type: 'asset',
                fileName: 'custom-ui.html',
                source: readFileSync('src/dev/custom-ui.html', 'utf-8')
            });

            // Development page that measures the splat renderers (docs/stochastic-renderer.md).
            this.emitFile({
                type: 'asset',
                fileName: 'bench.html',
                source: readFileSync('src/dev/bench.html', 'utf-8')
            });

            // Development page that forwards a device's console to tools/remote-console.mjs and
            // runs the snippets queued there, for devices Web Inspector cannot reach.
            this.emitFile({
                type: 'asset',
                fileName: 'remote.html',
                source: readFileSync('src/dev/remote.html', 'utf-8')
            });
        }
    };
}

// Imports the markup template (src/ui.html) as a string. Its comments are for the file's
// readers and are dropped: they would otherwise ship in the bundle, and a `<!--` inside an
// inline module script puts the html tokenizer into its escaped state, which
// renderViewerHtml({ inlineJs }) refuses.
function htmlTemplatePlugin() {
    return {
        name: 'html-template',
        transform(code, id) {
            if (!id.endsWith('.html')) return null;
            const markup = code.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
            return { code: `export default ${JSON.stringify(markup)};`, map: { mappings: '' } };
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
    plugins: [
        resolve(debugEngine ? { exportConditions: ['development'] } : {}),
        typescriptPlugin(),
        json(),
        htmlTemplatePlugin(),
        htmlPlugin()
    ]
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
        typescriptPlugin({ noEmit: true }),
        json()
    ]
};

// The runtime entry, for a page that creates the viewer itself rather than serving a document
// built by `renderViewerHtml`. The engine stays external here, unlike in the `public/` bundle,
// so a host that already depends on playcanvas ends up with one copy of it — which is what
// makes playcanvas a peer dependency of this entry. Matched with a pattern because the xr
// scripts are imported from a subpath.
const engineExternal = [/^playcanvas(\/|$)/];

const buildViewer = {
    input: 'src/index.ts',
    output: {
        file: 'dist/viewer.js',
        format: 'esm',
        sourcemap: true
    },
    external: engineExternal,
    plugins: [
        resolve(),
        typescriptPlugin(),
        json(),
        htmlTemplatePlugin(),
        {
            name: 'viewer-css',
            writeBundle() {
                // `buildCss` has already run, so ship its output beside the bundle: the styles
                // are not imported by the module, and a consumer's bundler wants a css file
                copyFileSync('public/index.css', 'dist/viewer.css');
            }
        }
    ]
};

const buildSettings = {
    input: 'src/settings.ts',
    output: {
        file: 'dist/settings.js',
        format: 'esm',
        sourcemap: true
    },
    plugins: [typescriptPlugin({ noEmit: true })]
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

// The engine's types are part of this surface (`ViewerHandle.app`, the event handler), so they
// are imported rather than inlined. The markup template and package.json are values the bundle
// carries, with nothing for the declaration bundler to read.
const buildViewerTypes = {
    input: 'src/index.ts',
    output: { file: 'dist/viewer.d.ts', format: 'es' },
    external: [...engineExternal, /\.html$/, /package\.json$/],
    plugins: [dts()]
};

const buildSettingsTypes = {
    input: 'src/settings.ts',
    output: { file: 'dist/settings.d.ts', format: 'es' },
    plugins: [dts()]
};

export default [
    buildCss,
    buildPublic,
    buildDist,
    buildViewer,
    buildSettings,
    buildDistTypes,
    buildViewerTypes,
    buildSettingsTypes
];
