import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Tests run against the built artifact, so they exercise exactly what the package ships.
// Run `npm run build` first (`npm test` does both).
import { css, html } from '../../dist/index.js';

// Temporary compatibility guard.
//
// Before `renderViewerHtml` existed, the only way to embed the viewer in a generated page was
// to rewrite the shipped index.html by pattern matching. Known consumers still do that, and
// because the document's formatting is not part of this package's api, a reformat here breaks
// them — with the failure surfacing in *their* repository, one version bump later, rather than
// in this one.
//
// So until those consumers call `renderViewerHtml`, assert the patterns they match, to keep
// the breakage visible in this repo's ci. Delete this file once they have migrated; nothing
// here is a contract worth preserving on its own.
describe('legacy html rewriting patterns (remove once consumers use renderViewerHtml)', () => {
    const patterns = [
        ['base href', /<base\b[^>]*>/],
        ['stylesheet link', /<link\b[^>]*href="\.\/index\.css"[^>]*>/],
        ['poster url', /const posterUrl =[\s\S]*?;/],
        ['content url', /const contentUrl =[\s\S]*?;/],
        ['skybox url', /const skyboxUrl =[\s\S]*?;/],
        ['collision url', /const collisionUrl =[\s\S]*?;/],
        ['settings', /settings: .*$/m],
        // a marker element is injected straight after the opening tag
        ['body tag', /<body\b[^>]*>/]
    ];

    for (const [name, pattern] of patterns) {
        it(`still matches the ${name} pattern`, () => {
            assert.ok(pattern.test(html));
        });
    }

    it('still exposes the seams consumers append to', () => {
        // extra head markup is injected before this
        assert.ok(html.includes('</head>'));
        // and a background colour is spliced into the stylesheet's first `body {` rule to
        // avoid a flash before the first frame
        assert.ok(css.includes('body {'));
    });

    it('keeps the settings assignment on one line', () => {
        // The consumer's `/settings: .*$/m` replacement is line-anchored, so a wrapped
        // statement would be truncated mid-expression — leaving a dangling `?? fetch(...)`
        // and a syntax error. Matching that pattern is not enough to prove it is safe: a
        // partial wrap still matches the first line. Require the expression to terminate on
        // the same line as the key.
        assert.match(html, /settings: [^\n]*response\.json\(\)\)$/m);
    });

    it('keeps the asset urls as single replaceable declarations', () => {
        // consumers rewrite these to `searchParams.get(...) ?? <their default>`, so each must
        // remain one assignment that can be replaced wholesale
        assert.match(html, /const skyboxUrl =[^;]*bootstrap\.skyboxUrl[^;]*;/);
        assert.match(html, /const collisionUrl =[\s\S]*?bootstrap\.collisionUrl[\s\S]*?;/);
    });
});
