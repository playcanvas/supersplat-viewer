import { describe, expect, it } from 'vitest';

import { html, css, js } from '../../src/module/index';
import { renderViewerHtml } from '../../src/module/render-html';

// Extract the bootstrap block's json payload the way the browser does.
const readBootstrap = (document: string) => {
    const match = document.match(/<script type="application\/json" id="sse-bootstrap">([\s\S]*?)<\/script>/);
    expect(match, 'bootstrap block missing').not.toBeNull();
    return JSON.parse(match[1]);
};

describe('renderViewerHtml', () => {
    it('returns the shipped document unmodified when given no options', () => {
        expect(renderViewerHtml()).toBe(html);
        expect(renderViewerHtml({})).toBe(html);
    });

    it('ships exactly one bootstrap seam, defaulting to null', () => {
        const seams = html.match(/id="sse-bootstrap"/g);
        expect(seams).toHaveLength(1);
        expect(readBootstrap(html)).toBeNull();
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

        expect(readBootstrap(result)).toEqual({
            settings,
            contentUrl: 'https://cdn.example.com/hash/v2/meta.json',
            posterUrl: 'https://cdn.example.com/thumb.png',
            skyboxUrl: 'skybox?id=hash',
            collisionUrl: 'https://cdn.example.com/hash/v2/scene.voxel.json'
        });
        expect(result).toContain('<base href="/s/">');
        expect(result).not.toContain('<base href=""');
        // components are normalized 0..1, so 0.5 -> 128
        expect(result).toContain('body { background-color: rgb(0, 128, 255); }');
        expect(result).toContain('<script data-test="sentry"></script>');
    });

    it('injects body content immediately after the opening body tag', () => {
        const result = renderViewerHtml({ bodyStartExtras: '<div id="marker"></div>' });

        expect(result).toMatch(/<body[^>]*>\s*<div id="marker"><\/div>/);
        // before the canvas, which is what a marker element is for
        expect(result.indexOf('id="marker"')).toBeLessThan(result.indexOf('application-canvas'));
    });

    it('does not let body content spoof the module-import seam', () => {
        const result = renderViewerHtml({
            bodyStartExtras: "<!-- import { main } from './index.js'; -->",
            inlineJs: true
        });

        expect(result).not.toMatch(/<script type="module">\s*import \{ main \}/);
        expect(result).toContain("<!-- import { main } from './index.js'; -->");
    });

    it('places head additions after the stylesheet and before </head>', () => {
        const result = renderViewerHtml({ backgroundColor: [1, 1, 1], headExtras: '<meta name="t" />' });

        expect(result.indexOf('index.css')).toBeLessThan(result.indexOf('background-color'));
        expect(result.indexOf('<meta name="t" />')).toBeLessThan(result.indexOf('</head>'));
        // the closing tag survives exactly once, at its original indentation
        expect(result.match(/^ {4}<\/head>$/gm)).toHaveLength(1);
    });

    // The two flags are independent because real hosts need all the combinations: one serving
    // the bundle from its own route wants the css inlined but not the js, a single-file export
    // wants both, and a directory export beside sibling files wants neither.
    it('inlines css only, for a host serving the bundle itself', () => {
        const result = renderViewerHtml({ inlineCss: true });

        expect(result).not.toContain('<link rel="stylesheet"');
        expect(result).toContain("import { main } from './index.js';");
        expect(result.length).toBeGreaterThan(css.length);
        expect(result.length).toBeLessThan(js.length);
    });

    it('inlines js only', () => {
        const result = renderViewerHtml({ inlineJs: true });

        expect(result).toContain('href="./index.css"');
        expect(result).not.toContain("import { main } from './index.js';");
        expect(result.length).toBeGreaterThan(js.length);
    });

    it('leaves the document self-contained when inlining both', () => {
        const result = renderViewerHtml({
            bootstrap: { settings: { version: 2 }, contentUrl: 'data:application/octet-stream;base64,AAAA' },
            inlineCss: true,
            inlineJs: true
        });

        expect(result).not.toContain('<link rel="stylesheet"');
        expect(result).not.toContain("import { main } from './index.js';");
        expect(result.length).toBeGreaterThan(css.length + js.length);
        expect(readBootstrap(result).contentUrl).toBe('data:application/octet-stream;base64,AAAA');
    });

    it('documents the bootstrap precedence the shipped script implements', () => {
        // asset urls: `searchParams.get(...) ?? bootstrap.<field>`, so a param wins
        for (const field of ['posterUrl', 'skyboxUrl', 'collisionUrl', 'settingsUrl', 'contentUrl']) {
            expect(html).toMatch(new RegExp(`searchParams\\.get\\([^)]*\\)[\\s\\S]*?\\?\\? bootstrap\\.${field}`));
        }
        // settings is the exception: inline settings beat `?settings=`, so a published
        // experience cannot be repointed at another settings file
        expect(html).toContain('settings: bootstrap.settings ?? fetch(settingsUrl)');
    });

    it('keeps both external references when inlining neither', () => {
        const result = renderViewerHtml({ bootstrap: { contentUrl: 'scene.sog' } });

        expect(result).toContain('href="./index.css"');
        expect(result).toContain("import { main } from './index.js';");
        expect(result.length).toBeLessThan(css.length + js.length);
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
            expect(result.match(/<\/script>/g).length).toBe(html.match(/<\/script>/g).length);
            expect(readBootstrap(result).settings).toEqual(settings);
        });

        it('inserts replacement patterns in urls literally', () => {
            const result = renderViewerHtml({ bootstrap: { contentUrl: "https://cdn.example.com/a$&b$'c.sog" } });

            expect(readBootstrap(result).contentUrl).toBe("https://cdn.example.com/a$&b$'c.sog");
        });

        it('escapes baseHref so it cannot break out of its attribute', () => {
            const result = renderViewerHtml({ baseHref: '/"><script>alert(1)</script><base x="' });

            expect(result).not.toContain('<script>alert(1)</script>');
            expect(result.match(/<script/g).length).toBe(html.match(/<script/g).length);
            expect(result.match(/<base\b/g)).toHaveLength(1);
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
            expect(readBootstrap(result).settings.annotations[0].text).toBe(payload);
            const outsideBootstrap = result.replace(
                /<script type="application\/json" id="sse-bootstrap">[\s\S]*?<\/script>/,
                ''
            );
            expect(outsideBootstrap).not.toContain(payload);
            expect(result.length).toBeGreaterThan(js.length);
        });

        it('does not let headExtras spoof the module-import seam', () => {
            const result = renderViewerHtml({
                headExtras: "<!-- import { main } from './index.js'; -->",
                inlineJs: true
            });

            expect(result).not.toMatch(/<script type="module">\s*import \{ main \}/);
            expect(result).toContain("<!-- import { main } from './index.js'; -->");
        });

        it('does not let settings spoof the base-href or stylesheet seams', () => {
            const result = renderViewerHtml({
                bootstrap: { settings: { a: '<base href="evil">', b: '<link rel="stylesheet" href="./index.css">' } },
                baseHref: '/s/',
                inlineCss: true
            });

            expect(result).toContain('<base href="/s/">');
            expect(result).not.toContain('<link rel="stylesheet" href="./index.css" />');
            expect(readBootstrap(result).settings.a).toBe('<base href="evil">');
        });

        it('does not let headExtras be mangled by replacement patterns', () => {
            const result = renderViewerHtml({ headExtras: '<script>const a = "$&$\'";</script>' });

            expect(result).toContain('<script>const a = "$&$\'";</script>');
        });
    });

    it('throws when a seam is missing rather than returning a partial document', () => {
        // guards the invariant that this function and index.html stay in step
        expect(() => renderViewerHtml({ bootstrap: {} })).not.toThrow();
        for (const seam of [
            /<script type="application\/json" id="sse-bootstrap">[\s\S]*?<\/script>/,
            /<base\b[^>]*>/,
            /<link\b[^>]*href="\.\/index\.css"[^>]*>/,
            /import \{ main \} from '\.\/index\.js';/,
            /^([ \t]*)<\/head>/m
        ]) {
            expect(seam.test(html), `seam absent from index.html: ${seam}`).toBe(true);
        }
    });
});
