import { describe, expect, it } from 'vitest';

import { css, html } from './index';

// Temporary guard. `super-splat-server` currently pattern-matches the shipped index.html
// instead of calling `renderViewerHtml`, so a formatting change here takes the production
// /s route down — and its tests only catch that in the monorepo, after the version bump.
// Until that controller is migrated, assert its patterns here so the break surfaces in this
// repo's CI instead. Delete this file with the server migration.
//
// Source: monorepo/services/super-splat-server/server/controllers/experience.tsx
describe('super-splat-server html patching (remove once the server calls renderViewerHtml)', () => {
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

    it('still exposes the seams the server appends to', () => {
        // sentry + telemetry scripts are injected before this
        expect(html).toContain('</head>');
        // and the background colour is spliced into the stylesheet's first `body {` rule.
        // This one is unguarded on the server side, so it would silently no-op.
        expect(css).toContain('body {');
    });

    it('keeps the params-override-embedder precedence the server relies on', () => {
        // the server rewrites these two to `searchParams.get(...) ?? <default>`, so the
        // declarations must remain single assignments it can replace wholesale
        expect(html).toMatch(/const skyboxUrl =[^;]*bootstrap\.skyboxUrl[^;]*;/);
        expect(html).toMatch(/const collisionUrl =[\s\S]*?bootstrap\.collisionUrl[\s\S]*?;/);
    });
});
