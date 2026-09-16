import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Guards the `/viewer` runtime entry, which unlike the root export is built with the engine
// external and so can break in ways the other tests would not notice: an externals miss that
// bundles or fails to resolve playcanvas, an export dropped by tree-shaking, a comment style
// that does not survive into the declarations, or a stylesheet rule that escapes the instance
// root. None of that needs a browser; what does — rendering, teardown, coexistence — is checked
// by hand with the harness (AGENTS.md).
//
// Run `npm run build` first (`npm test` does both).

const url = (path) => new URL(path, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf-8');
const pkg = JSON.parse(read('../../package.json'));

describe('the /viewer entry', () => {
    it('imports in a bare node process, with the engine resolved from outside the bundle', async () => {
        // The engine is external to this bundle, so this import only resolves if the specifiers
        // it emitted are real and nothing in the module reaches for the dom at load time.
        const mod = await import('../../dist/viewer.js');

        assert.deepEqual(Object.keys(mod), ['createViewer']);
        assert.equal(typeof mod.createViewer, 'function');
    });

    it('does not bundle the engine', () => {
        const source = read('../../dist/viewer.js');
        const specifiers = [...source.matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);

        assert.deepEqual(
            [...new Set(specifiers.map((s) => s.split('/')[0]))],
            ['playcanvas'],
            'the runtime entry should import nothing but the engine'
        );
        // a bundled engine is megabytes; the viewer alone is a few hundred kilobytes
        assert.ok(source.length < 1_500_000, `dist/viewer.js is ${source.length} bytes — is the engine bundled?`);
    });

    it('ships every file its package exports name', () => {
        for (const target of ['./viewer', './viewer.css']) {
            const entry = pkg.exports[target];
            const files = typeof entry === 'string' ? [entry] : Object.values(entry);
            for (const file of files) {
                assert.ok(existsSync(url(`../../${file}`)), `${target} points at ${file}, which is missing`);
            }
        }
    });

    it('declares the engine as an optional peer dependency', () => {
        // required to use this entry, but a consumer of renderViewerHtml alone should not be
        // made to install an engine it never loads
        assert.ok(pkg.peerDependencies?.playcanvas, 'playcanvas should be a peer dependency');
        assert.equal(pkg.peerDependenciesMeta?.playcanvas?.optional, true);
    });

    it('publishes the option and handle types, with their documentation', () => {
        const types = read('../../dist/viewer.d.ts');

        for (const name of [
            'CreateViewerOptions',
            'ViewerAssets',
            'ViewerFlags',
            'ViewerHandle',
            'ViewerState',
            'CaptureOptions',
            'CaptureResult'
        ]) {
            assert.match(types, new RegExp(`\\b${name}\\b`), `${name} missing from the published types`);
        }

        // the engine's types are part of this surface rather than inlined
        assert.match(types, /from 'playcanvas'/);

        // Only JSDoc survives the declaration bundler, so a `//` comment on an exported type is
        // documentation a consumer never sees. These two are the ones worth having in an editor.
        assert.match(types, /\/\*\*[\s\S]*?The element the viewer builds its subtree in/);
        assert.match(types, /\/\*\*[\s\S]*?Observable state/);
    });

    it('scopes every stylesheet rule to the instance root', () => {
        const css = read('../../dist/viewer.css');
        const selectors = [...css.matchAll(/(?:^|\}|\{)\s*([^{}@][^{}]*?)\{/g)].map((m) => m[1].trim());

        assert.ok(selectors.length > 50, `only ${selectors.length} selectors found — did the parse break?`);

        // The viewer's styles must not reach the host page that links this file. Nesting is what
        // guarantees that, so a rule at the top level is a leak.
        assert.deepEqual(
            selectors.filter((selector) => !selector.includes('.sse-viewer')),
            []
        );
    });

    it('themes from custom properties rather than hard-coded colours', () => {
        const css = read('../../dist/viewer.css');

        // the tokens a host overrides, declared once on the root
        for (const token of ['--sse-accent', '--sse-bkg', '--sse-text']) {
            assert.match(css, new RegExp(`${token}:`), `${token} is not declared`);
        }
        // translucent surfaces derive from the same properties, so a token change carries
        // through the whole ui instead of half of it
        assert.match(css, /color-mix\(in srgb, var\(--sse-/);
    });
});
