import {
    type AppBase,
    BLEND_NONE,
    BLEND_NORMAL,
    Color,
    CULLFACE_BACK,
    CULLFACE_NONE,
    Entity,
    FUNC_EQUAL,
    FUNC_LESSEQUAL,
    Layer,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    RENDERSTYLE_WIREFRAME,
    SORTMODE_MANUAL,
    StandardMaterial
} from 'playcanvas';

import type { MeshCollision } from './collision';

// Single-layer overlay rendered after the gaussians, three passes on a fresh
// depth buffer, all using stock StandardMaterial:
//
//   1. Surface depth pre-pass: depth test/write on, color writes off — stamps
//      the front-most surface depth into the depth buffer.
//   2. Surface color pass: depthFunc EQUAL, depth write off — only the
//      front-most fragment from pass 1 survives, so a single layer of
//      semi-transparent surface color blends onto the camera target. Tint is
//      baked per-vertex from each triangle's face normal at construction
//      time, so no custom shader is needed.
//   3. Wireframe pass: black lines (RENDERSTYLE_WIREFRAME) depth-tested
//      against the surface depth so back-facing edges are hidden.

const SURFACE_ALPHA = 0.3;

// Build an unindexed mesh where every triangle has three unique vertices that
// share the triangle's flat face color (tint by dominant axis of the face
// normal, alpha baked in). Using per-triangle vertices avoids derivative
// shimmer and gives the surface a faceted look matching the voxel overlay.
const buildFlatMesh = (positions: Float32Array, indices: Uint32Array | Uint16Array) => {
    const numTris = Math.floor(indices.length / 3);
    const flatPositions = new Float32Array(numTris * 9);
    const flatColors = new Float32Array(numTris * 12);
    const flatIndices = new Uint32Array(numTris * 3);

    for (let i = 0; i < numTris; i++) {
        const i0 = indices[i * 3] * 3;
        const i1 = indices[i * 3 + 1] * 3;
        const i2 = indices[i * 3 + 2] * 3;

        const v0x = positions[i0], v0y = positions[i0 + 1], v0z = positions[i0 + 2];
        const v1x = positions[i1], v1y = positions[i1 + 1], v1z = positions[i1 + 2];
        const v2x = positions[i2], v2y = positions[i2 + 1], v2z = positions[i2 + 2];

        const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
        const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;

        const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
        let gray;
        if (ax > ay && ax > az) {
            gray = 0.85;
        } else if (ay > az) {
            gray = 0.55;
        } else {
            gray = 0.3;
        }

        const op = i * 9;
        flatPositions[op]     = v0x; flatPositions[op + 1] = v0y; flatPositions[op + 2] = v0z;
        flatPositions[op + 3] = v1x; flatPositions[op + 4] = v1y; flatPositions[op + 5] = v1z;
        flatPositions[op + 6] = v2x; flatPositions[op + 7] = v2y; flatPositions[op + 8] = v2z;

        const oc = i * 12;
        for (let j = 0; j < 3; j++) {
            const k = oc + j * 4;
            flatColors[k]     = gray;
            flatColors[k + 1] = gray;
            flatColors[k + 2] = gray;
            flatColors[k + 3] = SURFACE_ALPHA;
        }

        const oi = i * 3;
        flatIndices[oi]     = oi;
        flatIndices[oi + 1] = oi + 1;
        flatIndices[oi + 2] = oi + 2;
    }

    return { flatPositions, flatColors, flatIndices };
};

const makeUnlit = () => {
    const m = new StandardMaterial();
    m.useLighting = false;
    m.useSkybox = false;
    m.ambient = new Color(0, 0, 0);
    m.diffuse = new Color(0, 0, 0);
    m.specular = new Color(0, 0, 0);
    m.emissive = new Color(0, 0, 0);
    return m;
};

class MeshDebugOverlay {
    private layer: Layer;

    private entity: Entity;

    private _enabled = false;

    constructor(app: AppBase, collision: MeshCollision, camera: Entity) {
        const device = app.graphicsDevice;
        const { positions, indices } = collision;

        const { flatPositions, flatColors, flatIndices } = buildFlatMesh(positions, indices);

        const mesh = new Mesh(device);
        mesh.setPositions(flatPositions);
        mesh.setColors(flatColors);
        mesh.setIndices(flatIndices);
        mesh.update(PRIMITIVE_TRIANGLES);
        mesh.generateWireframe();

        // Overlay layer rendered after everything, with a fresh depth buffer.
        // Manual sort keeps the three passes ordered by drawOrder.
        this.layer = new Layer({
            name: 'CollisionOverlay',
            clearColorBuffer: false,
            clearDepthBuffer: true,
            opaqueSortMode: SORTMODE_MANUAL,
            transparentSortMode: SORTMODE_MANUAL
        });
        app.scene.layers.push(this.layer);
        camera.camera.layers = [...camera.camera.layers, this.layer.id];

        // Pass 1: depth pre-pass. No color writes.
        const depthMaterial = makeUnlit();
        depthMaterial.blendType = BLEND_NONE;
        depthMaterial.depthTest = true;
        depthMaterial.depthWrite = true;
        depthMaterial.cull = CULLFACE_BACK;
        depthMaterial.redWrite = false;
        depthMaterial.greenWrite = false;
        depthMaterial.blueWrite = false;
        depthMaterial.alphaWrite = false;
        depthMaterial.update();

        const depthInstance = new MeshInstance(mesh, depthMaterial);
        depthInstance.drawOrder = 0;

        const depthEntity = new Entity('CollisionDepthPrepass');
        depthEntity.addComponent('render', {
            meshInstances: [depthInstance],
            layers: [this.layer.id]
        });

        // Pass 2: surface color, depth EQUAL. Vertex color drives both the
        // emissive tint and the opacity, no shaders required.
        const surfaceMaterial = makeUnlit();
        surfaceMaterial.emissive = new Color(1, 1, 1);
        surfaceMaterial.emissiveVertexColor = true;
        surfaceMaterial.emissiveVertexColorChannel = 'rgb';
        surfaceMaterial.opacityVertexColor = true;
        surfaceMaterial.opacityVertexColorChannel = 'a';
        surfaceMaterial.opacity = 1;
        surfaceMaterial.blendType = BLEND_NORMAL;
        surfaceMaterial.depthTest = true;
        surfaceMaterial.depthFunc = FUNC_EQUAL;
        surfaceMaterial.depthWrite = false;
        surfaceMaterial.cull = CULLFACE_BACK;
        surfaceMaterial.update();

        const surfaceInstance = new MeshInstance(mesh, surfaceMaterial);
        surfaceInstance.drawOrder = 1;

        const surfaceEntity = new Entity('CollisionSurface');
        surfaceEntity.addComponent('render', {
            meshInstances: [surfaceInstance],
            layers: [this.layer.id]
        });

        // Pass 3: wireframe, opaque black, depth-tested against the surface.
        const wireframeMaterial = makeUnlit();
        wireframeMaterial.opacity = 1;
        wireframeMaterial.blendType = BLEND_NONE;
        wireframeMaterial.depthTest = true;
        wireframeMaterial.depthFunc = FUNC_LESSEQUAL;
        wireframeMaterial.depthWrite = false;
        wireframeMaterial.cull = CULLFACE_NONE;
        wireframeMaterial.update();

        const wireframeInstance = new MeshInstance(mesh, wireframeMaterial);
        wireframeInstance.drawOrder = 2;

        const wireframeEntity = new Entity('CollisionWireframe');
        wireframeEntity.addComponent('render', {
            meshInstances: [wireframeInstance],
            layers: [this.layer.id]
        });
        wireframeEntity.render.renderStyle = RENDERSTYLE_WIREFRAME;

        this.entity = new Entity('MeshCollisionDebug');
        this.entity.addChild(depthEntity);
        this.entity.addChild(surfaceEntity);
        this.entity.addChild(wireframeEntity);
        this.entity.enabled = false;
        app.root.addChild(this.entity);
    }

    set enabled(value: boolean) {
        this._enabled = value;
        this.entity.enabled = value;
    }

    get enabled(): boolean {
        return this._enabled;
    }

    destroy(): void {
        this.entity?.destroy();
    }
}

export { MeshDebugOverlay };
