import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

// The touch-only bottom inset: how createViewer clamps the option, how the shipped document reads
// it from its url, and the stylesheet rules that apply it.
//
// The resolver is not exported from any entry, so it is compiled from its source here; it has no
// imports, so the one file is the whole module. Everything else reads the build, so run
// `npm run build` first (`npm test` does both).

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf-8');

const { TOUCH_INSET_BOTTOM_MAX, resolveTouchInsetBottom } = await import(
    `data:text/javascript,${encodeURIComponent(
        ts.transpileModule(read('../src/touch-inset-bottom.ts'), {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
        }).outputText
    )}`
);

// Run the shipped document's options script against a url, the way the browser does before the
// bundle arrives, and return the createViewer options it builds.
const optionsFor = (search) => {
    const html = read('../public/index.html');
    const script = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
        .map((m) => m[1])
        .find((source) => source.includes('window.sse ='));
    assert.ok(script, 'the options script is missing from the document');

    const response = { json: async () => ({}) };
    const context = {
        URL,
        location: { href: `https://viewer.example/s${search}` },
        document: { getElementById: () => ({ textContent: 'null' }) },
        // the poster is only created, never read
        Image: Object,
        fetch: async () => response,
        window: {}
    };
    vm.runInNewContext(script, context);
    return context.window.sse.options;
};

describe('resolveTouchInsetBottom', () => {
    it('defaults to 0', () => {
        assert.equal(resolveTouchInsetBottom(undefined), 0);
    });

    it('keeps a value in range', () => {
        assert.equal(resolveTouchInsetBottom(0), 0);
        assert.equal(resolveTouchInsetBottom(56), 56);
        assert.equal(resolveTouchInsetBottom(12.5), 12.5);
    });

    it('clamps to 0..200', () => {
        assert.equal(TOUCH_INSET_BOTTOM_MAX, 200);
        assert.equal(resolveTouchInsetBottom(-10), 0);
        assert.equal(resolveTouchInsetBottom(1000), 200);
        assert.equal(resolveTouchInsetBottom(Infinity), 0);
    });

    it('treats a value that is not a number as 0', () => {
        assert.equal(resolveTouchInsetBottom(NaN), 0);
        assert.equal(resolveTouchInsetBottom('56px'), 0);
    });
});

describe('the url params', () => {
    it('leave the inset unset by default', () => {
        assert.equal(optionsFor('').experimentalTouchInsetBottom, undefined);
    });

    it('read ?experimental-touch-inset-bottom= as a number, left to createViewer to clamp', () => {
        assert.equal(optionsFor('?experimental-touch-inset-bottom=56').experimentalTouchInsetBottom, 56);
        assert.equal(optionsFor('?experimental-touch-inset-bottom=500').experimentalTouchInsetBottom, 500);
        assert.ok(Number.isNaN(optionsFor('?experimental-touch-inset-bottom=abc').experimentalTouchInsetBottom));
        assert.equal(
            resolveTouchInsetBottom(optionsFor('?experimental-touch-inset-bottom=abc').experimentalTouchInsetBottom),
            0
        );
        assert.equal(
            resolveTouchInsetBottom(optionsFor('?experimental-touch-inset-bottom=500').experimentalTouchInsetBottom),
            200
        );
    });
});

describe('the stylesheet', () => {
    const css = read('../dist/viewer.css');

    it('consumes the inset inside a coarse-pointer query alone', () => {
        // every use of the embedder's value, with the declaration that sets it excluded
        const uses = [...css.matchAll(/var\(--sse-experimental-touch-inset-bottom/g)].map((m) => m.index);
        assert.equal(uses.length, 1, 'the inset should be read in one place');

        const query = css.lastIndexOf('@media (pointer: coarse)', uses[0]);
        assert.ok(query >= 0, 'the inset is read outside a coarse-pointer query');
        // nothing closes the query between its start and the use
        const between = css.slice(query, uses[0]);
        assert.equal((between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length, 2);

        // and the lift it feeds defaults to nothing
        assert.match(css, /--sse-lift:\s*0px/);
    });

    it('caps the panels above the toolbar to the height left, scrolling by touch', () => {
        for (const panel of ['controlsHint', 'settingsPanel']) {
            const rule = css.match(new RegExp(`\\.sse-viewer \\.sse-${panel} \\{([^}]*)\\}`))?.[1] ?? '';
            assert.match(rule, /max-height:\s*calc\(100% - 16px - calc\([^;]*var\(--sse-lift\)\)\)/, panel);
            assert.match(rule, /overflow-y:\s*auto/, panel);
            assert.match(css, new RegExp(`\\.sse-viewer \\.sse-${panel} \\*\\s*\\{\\s*touch-action:\\s*pan-y`), panel);
        }
    });

    it('lifts the toolbar and the loading bar by it', () => {
        assert.match(css, /bottom:\s*calc\(max\(16px, env\(safe-area-inset-bottom\)\) \+ var\(--sse-lift\)\)/);
        assert.match(css, /bottom:\s*calc\(120px \+ var\(--sse-lift\)\)/);
    });
});

describe('the published types', () => {
    const exported = (types) =>
        [...types.matchAll(/export type \{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((name) => name.trim()));

    for (const file of ['viewer.d.ts', 'index.d.ts']) {
        it(`declare the inset in ${file}`, () => {
            const types = read(`../dist/${file}`);
            assert.ok(exported(types).includes('ViewerFlags'), `ViewerFlags missing from ${file}'s exports`);
            assert.match(types, /experimentalTouchInsetBottom\?: number;/);
        });
    }
});
