import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Guards the promise the 3D-display mode makes to everyone who does not use it: the DisplayXR
// inline-3D SDK is never part of the startup bundle, and is fetched only when the mode starts
// (src/display3d.ts). What it does on a display needs a 3D display, and is checked by hand.
//
// Run `npm run build` first (`npm test` does both).

const url = (path) => new URL(path, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf-8');
const pkg = JSON.parse(read('../../package.json'));

describe('the 3D-display mode', () => {
    it('loads the SDK lazily from the /viewer entry, as an external module', () => {
        const source = read('../../dist/viewer.js');
        assert.ok(
            !/^import .*? from '@displayxr\//m.test(source),
            'dist/viewer.js should not import the SDK statically'
        );
        assert.ok(source.includes("import('@displayxr/inline3d')"), 'dist/viewer.js should import the SDK on demand');
    });

    it('keeps the SDK out of the standalone bundle, in a chunk beside it', () => {
        const source = read('../../public/index.js');
        assert.ok(source.includes("import('./inline3d.js')"), 'public/index.js should import its SDK chunk on demand');
        assert.ok(!source.includes('sharedInline3D(opts'), 'public/index.js should not contain the SDK itself');
        assert.ok(existsSync(url('../../public/inline3d.js')), 'public/inline3d.js is missing');
        assert.ok(pkg.files.includes('public/inline3d.js'), 'the package should ship the SDK chunk');
    });

    it('declares the SDK as an optional peer dependency', () => {
        assert.ok(pkg.peerDependencies?.['@displayxr/inline3d'], 'the SDK should be a peer dependency');
        assert.equal(pkg.peerDependenciesMeta?.['@displayxr/inline3d']?.optional, true);
    });
});
