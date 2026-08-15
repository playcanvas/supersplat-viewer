import { describe, expect, it } from 'vitest';

import { css, html } from './index';

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
    const patterns: [string, RegExp][] = [
        ['base href', /<base\b[^>]*>/],
        ['stylesheet link', /<link\b[^>]*href="\.\/index\.css"[^>]*>/],
        ['poster url', /const posterUrl =[\s\S]*?;/],
        ['content url', /const contentUrl =[\s\S]*?;/],
        ['skybox url', /const skyboxUrl =[\s\S]*?;/],
        ['collision url', /const collisionUrl =[\s\S]*?;/],
        ['settings', /settings: .*$/m]
    ];

    it.each(patterns)('still matches the %s pattern', (_name, pattern) => {
        expect(pattern.test(html)).toBe(true);
    });

    it('still exposes the seams consumers append to', () => {
        // extra head markup is injected before this
        expect(html).toContain('</head>');
        // and a background colour is spliced into the stylesheet's first `body {` rule to
        // avoid a flash before the first frame
        expect(css).toContain('body {');
    });

    it('keeps the asset urls as single replaceable declarations', () => {
        // consumers rewrite these to `searchParams.get(...) ?? <their default>`, so each must
        // remain one assignment that can be replaced wholesale
        expect(html).toMatch(/const skyboxUrl =[^;]*bootstrap\.skyboxUrl[^;]*;/);
        expect(html).toMatch(/const collisionUrl =[\s\S]*?bootstrap\.collisionUrl[\s\S]*?;/);
    });
});
