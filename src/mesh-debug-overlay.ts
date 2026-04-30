import {
    type AppBase,
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

import type { MeshCollision, TriangleSoA } from './collision';

// Single-layer overlay rendered after the gaussians, three passes on a fresh
// depth buffer:
//
//   1. Surface depth pre-pass: color writes masked off, depth test/write on.
//      Stamps the front-most surface depth into the depth buffer.
//   2. Surface color pass: depthFunc EQUAL, depth write off, vertex-color
//      tinted via StandardMaterial. Only the front-most fragment from pass 1
//      survives so a single layer of semi-transparent surface color blends
//      onto the camera target.
//   3. Wireframe pass: opaque-looking black lines (RENDERSTYLE_WIREFRAME),
//      depth-tested against the surface depth so back-facing edges are
//      hidden.
//
// All three passes use BLEND_NORMAL so they share the layer's *transparent*
// render action. PlayCanvas creates separate opaque and transparent render
// actions per layer and `clearDepthBuffer` clears the depth buffer for each
// of them — if the depth pre-pass were opaque, the transparent action would
// wipe the depth before pass 2 and FUNC_EQUAL would always fail.

// Linear gray levels picked by dominant face axis, plus the surface alpha.
// These values are what we want the framebuffer to actually contain — pre-
// encoding below makes that true regardless of the gamma path taken.
const SURFACE_GRAY_X = 0.85;
const SURFACE_GRAY_Y = 0.55;
const SURFACE_GRAY_Z = 0.30;
const SURFACE_ALPHA  = 0.30;

// Build an unindexed mesh where every triangle has three unique vertices that
// share the triangle's flat face color (tint by dominant axis of the face
// normal, alpha baked in). Per-triangle vertices give the surface a faceted
// look matching the voxel overlay.
//
// `cameraFrameEnabled` controls how the per-vertex color is encoded so the
// overlay looks identical between the WebGL (no CameraFrame) and
// WebGPU/compute (CameraFrame) paths. With CameraFrame on, the engine's
// `gammaCorrectOutput` is a no-op (GAMMA_NONE) and the StandardMaterial
// output lands in the framebuffer as-is — so we feed the raw gray value.
// Without CameraFrame, `gammaCorrectOutput` applies `pow(1/2.2)` to the
// material output, so we feed `pow(gray, 2.2)` here and gamma-correct
// undoes it; the framebuffer ends up storing the same raw gray value.
const buildFlatMesh = (tris: TriangleSoA, cameraFrameEnabled: boolean) => {
    const encode = (v: number) => Math.round((cameraFrameEnabled ? v : Math.pow(v, 2.2)) * 255);
    const grayX = encode(SURFACE_GRAY_X);
    const grayY = encode(SURFACE_GRAY_Y);
    const grayZ = encode(SURFACE_GRAY_Z);
    const alpha = Math.round(SURFACE_ALPHA * 255);

    const numTris = tris.count;
    const flatPositions = new Float32Array(numTris * 9);
    const flatColors = new Uint8Array(numTris * 12);
    const flatIndices = new Uint32Array(numTris * 3);

    for (let i = 0; i < numTris; i++) {
        const ax = Math.abs(tris.nx[i]);
        const ay = Math.abs(tris.ny[i]);
        const az = Math.abs(tris.nz[i]);
        let gray;
        if (ax > ay && ax > az) {
            gray = grayX;
        } else if (ay > az) {
            gray = grayY;
        } else {
            gray = grayZ;
        }

        const op = i * 9;
        flatPositions[op]     = tris.v0x[i]; flatPositions[op + 1] = tris.v0y[i]; flatPositions[op + 2] = tris.v0z[i];
        flatPositions[op + 3] = tris.v1x[i]; flatPositions[op + 4] = tris.v1y[i]; flatPositions[op + 5] = tris.v1z[i];
        flatPositions[op + 6] = tris.v2x[i]; flatPositions[op + 7] = tris.v2y[i]; flatPositions[op + 8] = tris.v2z[i];

        const oc = i * 12;
        for (let j = 0; j < 3; j++) {
            const k = oc + j * 4;
            flatColors[k]     = gray;
            flatColors[k + 1] = gray;
            flatColors[k + 2] = gray;
            flatColors[k + 3] = alpha;
        }

        const oi = i * 3;
        flatIndices[oi]     = oi;
        flatIndices[oi + 1] = oi + 1;
        flatIndices[oi + 2] = oi + 2;
    }

    return { flatPositions, flatColors, flatIndices };
};

// Configures a StandardMaterial that emits the per-vertex color directly. The
// depth pre-pass and the color pass use the same configuration (so they
// compile to identical shaders and produce bit-identical depth values for
// FUNC_EQUAL); only their write masks and depth state differ.
const makeSurfaceMaterial = () => {
    const m = new StandardMaterial();
    m.useLighting = false;
    m.useSkybox = false;
    m.useFog = false;
    m.useTonemap = false;
    m.ambient = new Color(0, 0, 0);
    m.diffuse = new Color(0, 0, 0);
    m.specular = new Color(0, 0, 0);
    m.emissive = new Color(1, 1, 1);
    m.emissiveVertexColor = true;
    m.emissiveVertexColorChannel = 'rgb';
    m.opacityVertexColor = true;
    m.opacityVertexColorChannel = 'a';
    m.opacity = 1;
    return m;
};

class MeshDebugOverlay {
    private app: AppBase;

    private camera: Entity;

    private layer: Layer;

    private entity: Entity;

    private materials: StandardMaterial[];

    private _enabled = false;

    constructor(app: AppBase, collision: MeshCollision, camera: Entity, cameraFrameEnabled: boolean) {
        this.app = app;
        this.camera = camera;
        const device = app.graphicsDevice;

        const { flatPositions, flatColors, flatIndices } =
            buildFlatMesh(collision.triangles, cameraFrameEnabled);

        const mesh = new Mesh(device);
        mesh.setPositions(flatPositions);
        mesh.setColors32(flatColors);
        mesh.setIndices(flatIndices);
        mesh.update(PRIMITIVE_TRIANGLES);
        mesh.generateWireframe();

        this.layer = new Layer({
            name: 'CollisionOverlay',
            clearColorBuffer: false,
            clearDepthBuffer: true,
            opaqueSortMode: SORTMODE_MANUAL,
            transparentSortMode: SORTMODE_MANUAL
        });
        app.scene.layers.push(this.layer);
        camera.camera.layers = [...camera.camera.layers, this.layer.id];

        // Pass 1: depth pre-pass. Color writes masked off so only depth lands
        // in the buffer. Both this and pass 2 use the same depthBias /
        // slopeDepthBias so they write/test identical depth values
        // (FUNC_EQUAL relies on this) while still sitting slightly behind the
        // wireframe lines so pass 3's FUNC_LESSEQUAL passes reliably without
        // z-fighting.
        const depthMaterial = makeSurfaceMaterial();
        depthMaterial.cull = CULLFACE_BACK;
        depthMaterial.blendType = BLEND_NORMAL;
        depthMaterial.depthTest = true;
        depthMaterial.depthWrite = true;
        depthMaterial.depthBias = 1;
        depthMaterial.slopeDepthBias = 1;
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

        // Pass 2: surface color, depth EQUAL. Only the front-most fragment
        // from pass 1 survives, so a single layer of vertex color blends onto
        // the camera target.
        const surfaceMaterial = makeSurfaceMaterial();
        surfaceMaterial.cull = CULLFACE_BACK;
        surfaceMaterial.blendType = BLEND_NORMAL;
        surfaceMaterial.depthTest = true;
        surfaceMaterial.depthFunc = FUNC_EQUAL;
        surfaceMaterial.depthWrite = false;
        surfaceMaterial.depthBias = 1;
        surfaceMaterial.slopeDepthBias = 1;
        surfaceMaterial.update();

        const surfaceInstance = new MeshInstance(mesh, surfaceMaterial);
        surfaceInstance.drawOrder = 1;

        const surfaceEntity = new Entity('CollisionSurface');
        surfaceEntity.addComponent('render', {
            meshInstances: [surfaceInstance],
            layers: [this.layer.id]
        });

        // Pass 3: wireframe — black lines depth-tested against the surface so
        // back-facing edges are hidden. BLEND_NORMAL with opacity = 1 looks
        // opaque but routes through the same transparent render action as the
        // other two passes, keeping all three under one depth clear.
        const wireframeMaterial = new StandardMaterial();
        wireframeMaterial.useLighting = false;
        wireframeMaterial.useSkybox = false;
        wireframeMaterial.useFog = false;
        wireframeMaterial.useTonemap = false;
        wireframeMaterial.ambient = new Color(0, 0, 0);
        wireframeMaterial.diffuse = new Color(0, 0, 0);
        wireframeMaterial.specular = new Color(0, 0, 0);
        wireframeMaterial.emissive = new Color(0, 0, 0);
        wireframeMaterial.opacity = 1;
        wireframeMaterial.blendType = BLEND_NORMAL;
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

        this.materials = [depthMaterial, surfaceMaterial, wireframeMaterial];

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
        // Entity.destroy() removes child entities and tears down their render
        // components, which destroy the MeshInstances and decref the shared
        // Mesh (the last decref destroys its GPU buffers). Materials are not
        // owned by MeshInstance so destroy them explicitly here.
        this.entity?.destroy();
        for (const m of this.materials) m.destroy();
        this.materials.length = 0;
        this.app.scene.layers.remove(this.layer);
        this.camera.camera.layers = this.camera.camera.layers.filter(id => id !== this.layer.id);
    }
}

export { MeshDebugOverlay };
