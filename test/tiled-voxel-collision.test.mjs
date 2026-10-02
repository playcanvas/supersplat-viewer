import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { rollup } from 'rollup';
import ts from 'typescript';

// Bundle the real TypeScript implementation without changing the package's public exports.
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await rollup({
    input: 'collision-test-entry',
    plugins: [
        {
            name: 'typescript-test',
            resolveId(source, importer) {
                if (source === 'collision-test-entry') return source;
                if (source === 'playcanvas') return { id: import.meta.resolve('playcanvas'), external: true };
                if (importer && source.startsWith('.')) return path.resolve(path.dirname(importer), `${source}.ts`);
            },
            async load(id) {
                if (id === 'collision-test-entry')
                    return [
                        `export * from ${JSON.stringify(path.join(root, 'src/collision/tiled-voxel-collision.ts'))};`,
                        `export { WalkController } from ${JSON.stringify(path.join(root, 'src/cameras/walk-controller.ts'))};`,
                        `export { Camera } from ${JSON.stringify(path.join(root, 'src/cameras/camera.ts'))};`,
                        `export { TiledVoxelDebugOverlay } from ${JSON.stringify(path.join(root, 'src/voxel-debug-overlay.ts'))};`
                    ].join('\n');
                return ts.transpileModule(await readFile(id, 'utf8'), {
                    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
                }).outputText;
            }
        }
    ]
});
const { output } = await bundle.generate({ format: 'es' });
await bundle.close();
const {
    TiledVoxelCollision,
    loadVoxelCollisionAsset,
    validateVoxelTileManifest,
    WalkController,
    Camera,
    TiledVoxelDebugOverlay
} = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`);

const base = 'https://example.test/collision/';
const flush = async () => {
    for (let i = 0; i < 4; i++) await new Promise(setImmediate);
};
const bounds = (x0, z0, x1, z1) => ({ min: [x0, 0, z0], max: [x1, 4, z1] });
const manifest = (nx = 4, nz = 3) => ({
    version: 1,
    voxelResolution: 1,
    tileSize: 4,
    overlap: 0,
    fullBounds: bounds(0, 0, nx * 4, nz * 4),
    tiles: Array.from({ length: nx * nz }, (_, i) => {
        const ix = i % nx;
        const iz = Math.floor(i / nx);
        return {
            id: `${ix}-${iz}`,
            ix,
            iz,
            coreBounds: bounds(ix * 4, iz * 4, ix * 4 + 4, iz * 4 + 4),
            dataBounds: bounds(ix * 4, iz * 4, ix * 4 + 4, iz * 4 + 4),
            url: `tiles/${ix}-${iz}.voxel.json`
        };
    })
});

const voxel = (min = [0, 0, 0], solid = [], version = '1.1') => {
    const words = new Uint32Array(3);
    for (const [x, y, z] of solid) {
        const bit = z * 16 + y * 4 + x;
        words[1 + (bit >>> 5)] |= 1 << (bit & 31);
    }
    return {
        metadata: {
            version,
            voxelResolution: 1,
            leafSize: 4,
            treeDepth: 0,
            gridBounds: { min, max: min.map((v) => v + 4) },
            gaussianBounds: { min, max: min.map((v) => v + 4) },
            nodeCount: 1,
            leafDataCount: 2,
            numInteriorNodes: 0,
            numMixedLeaves: 1
        },
        binary: words.buffer
    };
};

const serve = (t, m, fixtures = new Map()) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
        url = String(url);
        calls.push({ url, signal: options.signal });
        if (url === `${base}voxel-tiles.json`) return Response.json(m);
        const tile = m.tiles.find(
            (entry) =>
                url === new URL(entry.url, base).href || url === new URL(entry.url.replace('.json', '.bin'), base).href
        );
        assert.ok(tile, `unexpected fetch ${url}`);
        const data = fixtures.get(tile.id) ?? voxel(tile.coreBounds.min);
        return url.endsWith('.json') ? Response.json(data.metadata) : new Response(data.binary.slice(0));
    });
    return calls;
};

test('detects a manifest through collisionUrl and loads only a deduplicated 3x3 neighborhood', async (t) => {
    const m = manifest();
    const calls = serve(t, m);
    const collision = await loadVoxelCollisionAsset(`${base}voxel-tiles.json`);
    t.after(() => collision.destroy());
    assert.ok(collision instanceof TiledVoxelCollision);
    assert.equal(calls.length, 1);
    collision.updatePosition(6, 6);
    collision.updatePosition(6, 6);
    assert.equal(collision.isReadyAt(6, 6), false);
    await flush();
    assert.equal(collision.getActiveColliders().length, 9);
    assert.equal(calls.length, 19);
    assert.equal(collision.isReadyAt(6, 6, 0.2), true);
    collision.updatePosition(14, 2);
    await flush();
    assert.equal(collision.getActiveColliders().length, 4);
    assert.equal(collision.isReadyAt(2, 2), false);
});

test('gaps and outside bounds have no nearest-tile fallback, and footprints cannot cross missing cores', async (t) => {
    const m = manifest(3, 1);
    m.tiles.splice(1, 1);
    serve(t, m);
    const collision = new TiledVoxelCollision(m, `${base}voxel-tiles.json`);
    t.after(() => collision.destroy());
    collision.updatePosition(2, 2);
    await flush();
    assert.equal(collision.isReadyAt(2, 2), true);
    assert.equal(collision.isReadyAt(3.9, 2, 0.2), false);
    collision.updatePosition(6, 2);
    assert.equal(collision.isReadyAt(6, 2), false);
    assert.equal(collision.getActiveColliders().length, 0);
    collision.updatePosition(-1, 2);
    assert.equal(collision.isReadyAt(-1, 2), false);
});

test('failed center tiles retry while stationary, without blocking a successful neighboring center', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'warn', () => undefined);
    const m = manifest(2, 1);
    let failures = 1;
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (String(url).includes('0-0.voxel.json') && failures-- > 0) return new Response('', { status: 503 });
        const data = voxel(String(url).includes('1-0') ? [4, 0, 0] : [0, 0, 0]);
        return String(url).endsWith('.json') ? Response.json(data.metadata) : new Response(data.binary);
    });
    const collision = new TiledVoxelCollision(m, `${base}voxel-tiles.json`);
    t.after(() => collision.destroy());
    collision.updatePosition(2, 2);
    await flush();
    assert.equal(collision.isReadyAt(2, 2), false);
    assert.equal(collision.isReadyAt(6, 2), true);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(collision.isReadyAt(2, 2), true);
    assert.equal(console.warn.mock.callCount(), 1);
});

test('aborts evicted requests and ignores late results after eviction or destroy', async (t) => {
    const m = manifest(4, 1);
    const pending = [];
    t.mock.method(
        globalThis,
        'fetch',
        (url, { signal }) =>
            new Promise((resolve) => {
                pending.push({ url: String(url), signal, resolve });
            })
    );
    const collision = new TiledVoxelCollision(m, `${base}voxel-tiles.json`);
    collision.updatePosition(2, 2);
    const old = pending.slice();
    collision.updatePosition(14, 2);
    assert.ok(old.every((request) => request.signal.aborted));
    collision.destroy();
    assert.ok(pending.every((request) => request.signal.aborted));
    for (const request of pending.splice(0)) request.resolve(Response.json(voxel().metadata));
    await flush();
    for (const request of pending.splice(0)) request.resolve(new Response(voxel().binary));
    await flush();
    assert.equal(collision.getActiveColliders().length, 0);
    assert.equal(collision.isReadyAt(14, 2), false);
});

test('destroy cancels retry timers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'warn', () => undefined);
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
    const collision = new TiledVoxelCollision(manifest(1, 1), `${base}voxel-tiles.json`);
    collision.updatePosition(2, 2);
    await flush();
    collision.destroy();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(fetch.mock.callCount(), 1);
});

test('overlap uses occupied union for free-space, ray, sphere and capsule queries', async (t) => {
    const m = manifest(2, 1);
    m.fullBounds = bounds(0, 0, 4, 4);
    m.tileSize = 2;
    m.overlap = 2;
    m.tiles[0].coreBounds = bounds(0, 0, 2, 2);
    m.tiles[1].coreBounds = bounds(2, 0, 4, 2);
    for (const tile of m.tiles) tile.dataBounds = bounds(0, 0, 4, 4);
    const wall = [];
    for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) wall.push([2, y, z]);
    const fixtures = new Map([
        ['0-0', voxel()],
        ['1-0', voxel([0, 0, 0], wall)]
    ]);
    serve(t, m, fixtures);
    const collision = new TiledVoxelCollision(m, `${base}voxel-tiles.json`);
    t.after(() => collision.destroy());
    collision.updatePosition(1, 1.5);
    await flush();
    assert.equal(collision.isFreeAt(2.2, 1.5, 1.5), false, 'a free overlapping tile must not erase a solid tile');
    assert.equal(collision.isFreeAt(1.5, 1.5, 1.5), true);
    assert.deepEqual(collision.queryRay(1.5, 1.5, 1.5, 1, 0, 0, 10), { x: 2, y: 1.5, z: 1.5 });
    const out = { x: 0, y: 0, z: 0 };
    assert.equal(collision.querySphere(1.9, 1.5, 1.5, 0.2, out), true);
    assert.ok(Math.abs(out.x + 0.1) < 1e-9);
    assert.equal(collision.queryCapsule(1.9, 1.5, 1.5, 0.5, 0.2, out), true);
    assert.ok(Math.abs(out.x + 0.1) < 1e-9);
    assert.ok(collision.querySurfaceNormal(2, 1.5, 1.5, 1, 0, 0).nx < 0);

    // Repeat with the same occupied wall present in both overlapping tiles.
    fixtures.set('0-0', voxel([0, 0, 0], wall));
    collision.updatePosition(-1, 2);
    collision.updatePosition(1, 1.5);
    await flush();
    assert.equal(collision.querySphere(1.9, 1.5, 1.5, 0.2, out), true);
    assert.ok(Math.abs(out.x + 0.1) < 1e-9, 'duplicate overlap must not double the push-out');
});

test('ordinary and legacy voxel URLs still load through the shared entry without fetching JSON twice', async (t) => {
    let version = '1.1';
    const fetch = t.mock.method(globalThis, 'fetch', async (url) => {
        const data = voxel([0, 0, 0], [[1, 1, 1]], version);
        return String(url).endsWith('.json') ? Response.json(data.metadata) : new Response(data.binary);
    });
    const normal = await loadVoxelCollisionAsset(`${base}walk.voxel.json`);
    assert.equal(normal.isSolidAt(1.5, 1.5, 1.5), true);
    assert.equal(fetch.mock.callCount(), 2);
    version = '1.0';
    const legacy = await loadVoxelCollisionAsset(`${base}walk.voxel.json`);
    assert.equal(legacy.isSolidAt(-1.5, -1.5, 1.5), true);
});

test('invalid manifests fail before any tile requests', () => {
    const m = manifest(1, 1);
    assert.throws(() => validateVoxelTileManifest({ ...m, version: 2 }), /Invalid/);
    assert.throws(() => validateVoxelTileManifest({ ...m, voxelResolution: 0 }), /Invalid/);
    assert.throws(() => validateVoxelTileManifest({ ...m, tiles: [m.tiles[0], m.tiles[0]] }), /Invalid/);
    assert.throws(() => validateVoxelTileManifest({ ...m, fullBounds: bounds(4, 0, 0, 4) }), /Invalid/);
    assert.throws(
        () => validateVoxelTileManifest({ ...m, tiles: [{ ...m.tiles[0], coreBounds: bounds(1, 0, 4, 4) }] }),
        /grid bounds/
    );
    assert.doesNotThrow(() => validateVoxelTileManifest({ ...m, tiles: [] }));
    assert.throws(
        () => new TiledVoxelCollision({ ...m, tiles: [{ ...m.tiles[0], url: 'http://[' }] }, base),
        /Invalid URL/
    );
});

test('an active walk controller stops before an unloaded target footprint and resumes after recovery', () => {
    let ready = true;
    let edge = 4;
    const collision = {
        voxelResolution: 1,
        isReadyAt: (x, _z, radius) => ready && x + radius <= edge,
        queryCapsule: () => false,
        queryRay: (x, _y, z) => ({ x, y: 0, z })
    };
    const controller = new WalkController();
    const camera = new Camera();
    camera.position.set(3.75, 1.5, 1.5);
    controller.goto(camera);
    controller.collision = collision;
    const input = { read: () => ({ move: [100, 0, 0], rotate: [0, 0, 0] }) };
    for (let i = 0; i < 3; i++) controller.update(1 / 60, input, camera);
    assert.equal(camera.position.x, 3.75, 'walking must not enter an unloaded adjacent tile');
    assert.equal(camera.position.y, 1.5, 'missing data must not cause falling');
    ready = false;
    controller.update(1 / 60, input, camera);
    assert.equal(camera.position.x, 3.75);
    ready = true;
    edge = 100;
    for (let i = 0; i < 3; i++) controller.update(1 / 60, input, camera);
    assert.ok(camera.position.x > 3.75, 'movement should resume with newly available coverage');
});

test('capsule resolution cannot push a walking camera into an unloaded core', () => {
    let pushAcross = false;
    const collision = {
        voxelResolution: 1,
        isReadyAt: (x, _z, radius) => x + radius <= 4,
        queryCapsule: (_x, _y, _z, _half, _radius, out) => {
            if (!pushAcross) return false;
            Object.assign(out, { x: 1, y: 0, z: 0 });
            return true;
        },
        queryRay: (x, _y, z) => ({ x, y: 0, z })
    };
    const controller = new WalkController();
    const camera = new Camera();
    camera.position.set(3.75, 1.5, 1.5);
    controller.goto(camera);
    controller.collision = collision;
    pushAcross = true;
    const input = { read: () => ({ move: [0, 0, 0], rotate: [0, 0, 0] }) };
    for (let i = 0; i < 3; i++) controller.update(1 / 60, input, camera);
    assert.equal(camera.position.x, 3.75);
});

test('tile overlays allocate lazily and release resources on eviction, hiding and destroy', () => {
    const a = {};
    const b = {};
    let active = [a, b];
    const resources = [];
    const overlay = new TiledVoxelDebugOverlay(null, { getActiveColliders: () => active }, null, (tile) => {
        const resource = {
            tile,
            enabled: false,
            mode: 'overlay',
            updates: 0,
            destroyed: 0,
            update() {
                this.updates++;
            },
            destroy() {
                this.destroyed++;
            }
        };
        resources.push(resource);
        return resource;
    });
    overlay.update();
    assert.equal(resources.length, 0);
    overlay.enabled = true;
    overlay.mode = 'heatmap';
    overlay.update();
    overlay.update();
    assert.equal(resources.length, 2);
    assert.ok(resources.every((r) => r.enabled && r.mode === 'heatmap' && r.updates === 2));
    active = [b];
    overlay.update();
    assert.equal(resources[0].destroyed, 1);
    overlay.enabled = false;
    overlay.update();
    assert.equal(resources[1].destroyed, 1);
    overlay.enabled = true;
    overlay.update();
    assert.equal(resources.length, 3);
    overlay.destroy();
    overlay.destroy();
    assert.ok(resources.every((r) => r.destroyed === 1));
});
