import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Tests run against the built artifact, so they exercise exactly what the package ships.
// Run `npm run build` first (`npm test` does both).
import { html, css, js, renderViewerHtml } from '../../dist/index.js';

// The output contract for the bootstrap block, as the browser consumes it: a script element
// found by id whose text is the json payload. Deliberately independent of whatever pattern
// renderViewerHtml matches internally.
const BOOTSTRAP_BLOCK = /<script type="application\/json" id="sse-bootstrap">([\s\S]*?)<\/script>/;

// Extract the bootstrap block's json payload the way the browser does.
const readBootstrap = (document) => {
    const match = document.match(BOOTSTRAP_BLOCK);
    assert.ok(match, 'bootstrap block missing');
    return JSON.parse(match[1]);
};

describe('renderViewerHtml', () => {
    it('returns the shipped document unmodified when given no options', () => {
        assert.strictEqual(renderViewerHtml(), html);
        assert.strictEqual(renderViewerHtml({}), html);
    });

    it('ships exactly one bootstrap seam, defaulting to null', () => {
        assert.strictEqual(html.match(/id="sse-bootstrap"/g)?.length, 1);
        assert.strictEqual(readBootstrap(html), null);
    });

    it('renders the full set of embedder options', () => {
        const settings = { version: 2, background: { color: [0, 0, 0] } };
        const result = renderViewerHtml({
            bootstrap: {
                settings,
                contentUrl: 'https://cdn.example.com/hash/v2/meta.json',
                posterUrl: 'https://cdn.example.com/thumb.png',
                skyboxUrl: 'skybox?id=hash',
                collisionUrl: 'https://cdn.example.com/hash/v2/scene.voxel.json'
            },
            baseHref: '/s/',
            backgroundColor: [0, 0.5, 1],
            headExtras: '<script data-test="sentry"></script>'
        });

        assert.deepStrictEqual(readBootstrap(result), {
            settings,
            contentUrl: 'https://cdn.example.com/hash/v2/meta.json',
            posterUrl: 'https://cdn.example.com/thumb.png',
            skyboxUrl: 'skybox?id=hash',
            collisionUrl: 'https://cdn.example.com/hash/v2/scene.voxel.json'
        });
        assert.ok(result.includes('<base href="/s/">'));
        assert.ok(!result.includes('<base href=""'));
        // components are normalized 0..1, so 0.5 -> 128
        assert.ok(result.includes('body { background-color: rgb(0, 128, 255); }'));
        assert.ok(result.includes('<script data-test="sentry"></script>'));
    });

    it('injects body content immediately after the opening body tag', () => {
        const result = renderViewerHtml({ bodyStartExtras: '<div id="marker"></div>' });

        assert.match(result, /<body[^>]*>\s*<div id="marker"><\/div>/);
        // before the canvas, which is what a marker element is for
        assert.ok(result.indexOf('id="marker"') < result.indexOf('application-canvas'));
    });

    it('does not let body content spoof the module-import seam', () => {
        const result = renderViewerHtml({
            bodyStartExtras: "<!-- import { main } from './index.js'; -->",
            inlineJs: true
        });

        assert.doesNotMatch(result, /<script type="module">\s*import \{ main \}/);
        assert.ok(result.includes("<!-- import { main } from './index.js'; -->"));
    });

    it('places head additions after the stylesheet and before </head>', () => {
        const result = renderViewerHtml({ backgroundColor: [1, 1, 1], headExtras: '<meta name="t" />' });

        assert.ok(result.indexOf('index.css') < result.indexOf('background-color'));
        assert.ok(result.indexOf('<meta name="t" />') < result.indexOf('</head>'));
        // the closing tag survives exactly once, at its original indentation
        assert.strictEqual(result.match(/^ {4}<\/head>$/gm)?.length, 1);
    });

    // The two flags are independent because real hosts need all the combinations: one serving
    // the bundle from its own route wants the css inlined but not the js, a single-file export
    // wants both, and a directory export beside sibling files wants neither.
    it('inlines css only, for a host serving the bundle itself', () => {
        const result = renderViewerHtml({ inlineCss: true });

        assert.ok(!result.includes('<link rel="stylesheet"'));
        assert.ok(result.includes("import { main } from './index.js';"));
        assert.ok(result.length > css.length);
        assert.ok(result.length < js.length);
    });

    it('inlines js only', () => {
        const result = renderViewerHtml({ inlineJs: true });

        assert.ok(result.includes('href="./index.css"'));
        assert.ok(!result.includes("import { main } from './index.js';"));
        assert.ok(result.length > js.length);
    });

    it('strips the dangling sourceMappingURL comment when inlining the bundle', () => {
        // the map is a sibling of index.js, which a self-contained document is not next to —
        // an inlined reference would 404, or bind whatever map the host serves at that path
        const result = renderViewerHtml({ inlineJs: true });

        assert.ok(!result.includes('sourceMappingURL=index.js.map'));
    });

    it('leaves the document self-contained when inlining both', () => {
        const result = renderViewerHtml({
            bootstrap: {
                settings: { version: 2 },
                contentUrl: 'data:application/octet-stream;base64,AAAA',
                contentFilename: 'scene.sog'
            },
            inlineCss: true,
            inlineJs: true
        });

        assert.ok(!result.includes('<link rel="stylesheet"'));
        assert.ok(!result.includes("import { main } from './index.js';"));
        assert.ok(result.length > css.length + js.length);
        assert.strictEqual(readBootstrap(result).contentUrl, 'data:application/octet-stream;base64,AAAA');
        // a data: uri has no usable name, so the filename rides along to select the format
        assert.strictEqual(readBootstrap(result).contentFilename, 'scene.sog');
    });

    it('documents the bootstrap precedence the shipped script implements', () => {
        // asset urls: `searchParams.get(...) ?? bootstrap.<field>`, so a param wins
        for (const field of ['posterUrl', 'skyboxUrl', 'collisionUrl', 'settingsUrl', 'contentUrl']) {
            assert.match(html, new RegExp(`searchParams\\.get\\([^)]*\\)[\\s\\S]*?\\?\\? bootstrap\\.${field}`));
        }
        // settings is the exception: inline settings beat `?settings=`, so a published
        // experience cannot be repointed at another settings file
        assert.ok(html.includes('settings: bootstrap.settings ?? fetch(settingsUrl)'));
        // contentFilename names the bootstrap's contentUrl, so a ?content= override drops it
        assert.match(html, /searchParams\.has\('content'\) \? null : \(?bootstrap\.contentFilename/);
    });

    it('does not hide the canvas just because collision data is configured', () => {
        assert.match(html, /const \{ poster \} = config/);
        assert.doesNotMatch(html, /poster \|\| collisionUrl/);
    });

    it('keeps both external references when inlining neither', () => {
        const result = renderViewerHtml({ bootstrap: { contentUrl: 'scene.sog' } });

        assert.ok(result.includes('href="./index.css"'));
        assert.ok(result.includes("import { main } from './index.js';"));
        assert.ok(result.length < css.length + js.length);
    });

    describe('escaping', () => {
        it('survives markup, replacement patterns and line separators in settings', () => {
            const settings = {
                annotations: [
                    {
                        title: '</script><script>alert(1)</script>',
                        text: "save $& today, $' and $` and $$5 and $<name>\u2028\u2029"
                    }
                ]
            };

            const result = renderViewerHtml({ bootstrap: { settings } });

            // the block is not terminated early, and the payload round-trips byte-exact
            assert.strictEqual(result.match(/<\/script>/g).length, html.match(/<\/script>/g).length);
            assert.deepStrictEqual(readBootstrap(result).settings, settings);
        });

        it('neutralises the script-data double-escape sequence in settings', () => {
            // `<!--` followed by `<script` switches the html tokenizer into the double-escaped
            // state, where the block's own </script> is consumed as text and the rest of the
            // document — including the boot script — is swallowed into the json block. Every
            // `<` must therefore leave the block as a json unicode escape.
            const settings = { annotations: [{ text: 'see <!--<script> tags in html' }] };

            const result = renderViewerHtml({ bootstrap: { settings } });

            assert.ok(!result.match(BOOTSTRAP_BLOCK)[1].includes('<'));
            assert.deepStrictEqual(readBootstrap(result).settings, settings);
        });

        it('inserts replacement patterns in urls literally', () => {
            const result = renderViewerHtml({ bootstrap: { contentUrl: "https://cdn.example.com/a$&b$'c.sog" } });

            assert.strictEqual(readBootstrap(result).contentUrl, "https://cdn.example.com/a$&b$'c.sog");
        });

        it('escapes baseHref so it cannot break out of its attribute', () => {
            const result = renderViewerHtml({ baseHref: '/"><script>alert(1)</script><base x="' });

            assert.ok(!result.includes('<script>alert(1)</script>'));
            assert.strictEqual(result.match(/<script/g).length, html.match(/<script/g).length);
            assert.strictEqual(result.match(/<base\b/g)?.length, 1);
        });

        // Each seam is matched with a non-global regex, so a caller-controlled payload that
        // looks like a seam must not be matched ahead of the real one. Annotation text is
        // user-authored, so settings are the hostile case.
        it('does not let settings spoof the module-import seam', () => {
            const payload = "import { main } from './index.js';";
            const result = renderViewerHtml({
                bootstrap: { settings: { annotations: [{ text: payload }] } },
                inlineJs: true
            });

            // the payload survives verbatim as data, and the only occurrence of the literal is
            // inside the bootstrap block — the real import was replaced by the bundle
            assert.strictEqual(readBootstrap(result).settings.annotations[0].text, payload);
            const outsideBootstrap = result.replace(BOOTSTRAP_BLOCK, '');
            assert.ok(!outsideBootstrap.includes(payload));
            assert.ok(result.length > js.length);
        });

        it('does not let headExtras spoof the module-import seam', () => {
            const result = renderViewerHtml({
                headExtras: "<!-- import { main } from './index.js'; -->",
                inlineJs: true
            });

            assert.doesNotMatch(result, /<script type="module">\s*import \{ main \}/);
            assert.ok(result.includes("<!-- import { main } from './index.js'; -->"));
        });

        it('does not let settings spoof the base-href or stylesheet seams', () => {
            const result = renderViewerHtml({
                bootstrap: { settings: { a: '<base href="evil">', b: '<link rel="stylesheet" href="./index.css">' } },
                baseHref: '/s/',
                inlineCss: true
            });

            assert.ok(result.includes('<base href="/s/">'));
            assert.ok(!result.includes('<link rel="stylesheet" href="./index.css" />'));
            assert.strictEqual(readBootstrap(result).settings.a, '<base href="evil">');
        });

        it('does not let headExtras be mangled by replacement patterns', () => {
            const result = renderViewerHtml({ headExtras: '<script>const a = "$&$\'";</script>' });

            assert.ok(result.includes('<script>const a = "$&$\'";</script>'));
        });

        it('inserts multi-line headExtras verbatim, preserving interior whitespace', () => {
            // raw markup: reindenting interior lines would rewrite whitespace-sensitive
            // content, like this template literal's runtime value
            const extras = '<script>const msg = `line1\nline2`;</script>';

            const result = renderViewerHtml({ headExtras: extras });

            assert.ok(result.includes(extras));
        });
    });

    it('throws when a seam is missing rather than returning a partial document', () => {
        // Guards the invariant that this function and index.html stay in step, through the
        // public api: every option forces its replacement, which throws (naming the pattern)
        // if a seam no longer matches — including seams that must still match after earlier
        // replacements ran.
        assert.doesNotThrow(() =>
            renderViewerHtml({
                bootstrap: { contentUrl: 'scene.sog' },
                baseHref: '/s/',
                backgroundColor: [0, 0, 0],
                headExtras: '<meta name="x" />',
                bodyStartExtras: '<div></div>',
                inlineCss: true,
                inlineJs: true
            })
        );
    });
});
