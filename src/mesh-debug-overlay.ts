import {
    type AppBase,
    BLEND_NONE,
    BLEND_PREMULTIPLIED,
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
    SEMANTIC_NORMAL,
    SEMANTIC_POSITION,
    ShaderMaterial,
    SORTMODE_MANUAL
} from 'playcanvas';

import type { MeshCollision } from './collision';

// Single-layer overlay rendered after the gaussian splats:
//
//   1. Layer clears the depth buffer (color is left untouched) so the mesh
//      has a fresh depth context.
//   2. Surface depth pre-pass: the collision mesh renders with color writes
//      disabled and depth test/write on, establishing the front-most surface
//      depth at each pixel.
//   3. Surface color pass: the same mesh renders again with depthFunc EQUAL
//      and depth write off, so only the front-most fragment from pass 2
//      survives. Premultiplied alpha blends that one fragment onto the camera
//      target — no order-dependent overdraw inside the mesh.
//   4. Wireframe pass: black lines (RENDERSTYLE_WIREFRAME), depth-tested
//      against the surface depth so back-facing edges are hidden.
//
// Per-triangle flat normals are baked into the vertex buffer (un-welded
// vertices) to avoid derivative shimmer at triangle boundaries.

const surfaceVertexGLSL = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec3 vertex_normal;
    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    uniform mat3 matrix_normal;
    varying vec3 vNormal;
    void main(void) {
        vNormal = normalize(matrix_normal * vertex_normal);
        gl_Position = matrix_viewProjection * (matrix_model * vec4(vertex_position, 1.0));
    }
`;

const surfaceFragmentGLSL = /* glsl */ `
    varying vec3 vNormal;
    void main(void) {
        vec3 n = abs(normalize(vNormal));
        vec3 color;
        if (n.x > n.y && n.x > n.z) {
            color = vec3(0.85);
        } else if (n.y > n.z) {
            color = vec3(0.55);
        } else {
            color = vec3(0.3);
        }
        float alpha = 0.55;
        gl_FragColor = vec4(color * alpha, alpha);
    }
`;

const surfaceVertexWGSL = /* wgsl */ `
    attribute vertex_position: vec3f;
    attribute vertex_normal: vec3f;
    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;
    uniform matrix_normal: mat3x3f;
    varying vNormal: vec3f;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.vNormal = normalize(uniform.matrix_normal * input.vertex_normal);
        output.position = uniform.matrix_viewProjection * (uniform.matrix_model * vec4f(input.vertex_position, 1.0));
        return output;
    }
`;

const surfaceFragmentWGSL = /* wgsl */ `
    varying vNormal: vec3f;
    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let n = abs(normalize(input.vNormal));
        var color: vec3f;
        if (n.x > n.y && n.x > n.z) {
            color = vec3f(0.85);
        } else if (n.y > n.z) {
            color = vec3f(0.55);
        } else {
            color = vec3f(0.3);
        }
        let alpha = 0.55;
        output.color = vec4f(color * alpha, alpha);
        return output;
    }
`;

// Position-only vertex shader for the depth pre-pass and the wireframe.
// Includes a dummy varying so PlayCanvas emits the WGSL FragmentInput struct.
const positionOnlyVertexGLSL = /* glsl */ `
    attribute vec3 vertex_position;
    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    varying float vDummy;
    void main(void) {
        vDummy = 0.0;
        gl_Position = matrix_viewProjection * (matrix_model * vec4(vertex_position, 1.0));
    }
`;

const positionOnlyVertexWGSL = /* wgsl */ `
    attribute vertex_position: vec3f;
    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;
    varying vDummy: f32;
    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.vDummy = 0.0;
        output.position = uniform.matrix_viewProjection * (uniform.matrix_model * vec4f(input.vertex_position, 1.0));
        return output;
    }
`;

const constantBlackFragmentGLSL = /* glsl */ `
    varying float vDummy;
    void main(void) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }
`;

const constantBlackFragmentWGSL = /* wgsl */ `
    varying vDummy: f32;
    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        output.color = vec4f(0.0, 0.0, 0.0, 1.0);
        return output;
    }
`;

// Build an unindexed mesh where every triangle has three unique vertices, each
// carrying that triangle's flat face normal. This trades ~3x vertex memory for
// stable per-fragment shading with no derivative artifacts.
const buildFlatMesh = (positions: Float32Array, indices: Uint32Array | Uint16Array) => {
    const numTris = Math.floor(indices.length / 3);
    const flatPositions = new Float32Array(numTris * 9);
    const flatNormals = new Float32Array(numTris * 9);
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
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-10) {
            const inv = 1 / len;
            nx *= inv; ny *= inv; nz *= inv;
        }

        const o = i * 9;
        flatPositions[o]     = v0x; flatPositions[o + 1] = v0y; flatPositions[o + 2] = v0z;
        flatPositions[o + 3] = v1x; flatPositions[o + 4] = v1y; flatPositions[o + 5] = v1z;
        flatPositions[o + 6] = v2x; flatPositions[o + 7] = v2y; flatPositions[o + 8] = v2z;

        flatNormals[o]     = nx; flatNormals[o + 1] = ny; flatNormals[o + 2] = nz;
        flatNormals[o + 3] = nx; flatNormals[o + 4] = ny; flatNormals[o + 5] = nz;
        flatNormals[o + 6] = nx; flatNormals[o + 7] = ny; flatNormals[o + 8] = nz;

        const oi = i * 3;
        flatIndices[oi] = oi;
        flatIndices[oi + 1] = oi + 1;
        flatIndices[oi + 2] = oi + 2;
    }

    return { flatPositions, flatNormals, flatIndices };
};

class MeshDebugOverlay {
    private layer: Layer;

    private entity: Entity;

    private _enabled = false;

    constructor(app: AppBase, collision: MeshCollision, camera: Entity) {
        const device = app.graphicsDevice;
        const { positions, indices } = collision;

        const { flatPositions, flatNormals, flatIndices } = buildFlatMesh(positions, indices);

        const mesh = new Mesh(device);
        mesh.setPositions(flatPositions);
        mesh.setNormals(flatNormals);
        mesh.setIndices(flatIndices);
        mesh.update(PRIMITIVE_TRIANGLES);
        mesh.generateWireframe();

        // One overlay layer rendered after everything, with a fresh depth
        // buffer. Manual sort lets the three passes execute in drawOrder.
        this.layer = new Layer({
            name: 'CollisionOverlay',
            clearColorBuffer: false,
            clearDepthBuffer: true,
            opaqueSortMode: SORTMODE_MANUAL,
            transparentSortMode: SORTMODE_MANUAL
        });
        app.scene.layers.push(this.layer);
        camera.camera.layers = [...camera.camera.layers, this.layer.id];

        // Pass 1: depth pre-pass. No color writes, normal depth test/write.
        const depthMaterial = new ShaderMaterial();
        depthMaterial.cull = CULLFACE_BACK;
        depthMaterial.blendType = BLEND_NONE;
        depthMaterial.depthTest = true;
        depthMaterial.depthWrite = true;
        depthMaterial.redWrite = false;
        depthMaterial.greenWrite = false;
        depthMaterial.blueWrite = false;
        depthMaterial.alphaWrite = false;
        depthMaterial.shaderDesc = {
            uniqueName: 'CollisionDepthPrepass',
            vertexGLSL: positionOnlyVertexGLSL,
            fragmentGLSL: constantBlackFragmentGLSL,
            vertexWGSL: positionOnlyVertexWGSL,
            fragmentWGSL: constantBlackFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        };
        depthMaterial.update();

        const depthInstance = new MeshInstance(mesh, depthMaterial);
        depthInstance.drawOrder = 0;

        const depthEntity = new Entity('CollisionDepthPrepass');
        depthEntity.addComponent('render', {
            meshInstances: [depthInstance],
            layers: [this.layer.id]
        });

        // Pass 2: color pass with depth EQUAL. Only the front-most fragment
        // from pass 1 survives, so premultiplied alpha blends a single layer
        // of mesh color onto the camera target.
        const surfaceMaterial = new ShaderMaterial();
        surfaceMaterial.cull = CULLFACE_BACK;
        surfaceMaterial.blendType = BLEND_PREMULTIPLIED;
        surfaceMaterial.depthTest = true;
        surfaceMaterial.depthFunc = FUNC_EQUAL;
        surfaceMaterial.depthWrite = false;
        surfaceMaterial.shaderDesc = {
            uniqueName: 'CollisionSurface',
            vertexGLSL: surfaceVertexGLSL,
            fragmentGLSL: surfaceFragmentGLSL,
            vertexWGSL: surfaceVertexWGSL,
            fragmentWGSL: surfaceFragmentWGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_normal: SEMANTIC_NORMAL
            }
        };
        surfaceMaterial.update();

        const surfaceInstance = new MeshInstance(mesh, surfaceMaterial);
        surfaceInstance.drawOrder = 1;

        const surfaceEntity = new Entity('CollisionSurface');
        surfaceEntity.addComponent('render', {
            meshInstances: [surfaceInstance],
            layers: [this.layer.id]
        });

        // Pass 3: wireframe — black lines depth-tested against the surface so
        // back-facing edges are hidden. LESSEQUAL keeps front-edge lines from
        // failing against the depth their own surface wrote.
        const wireframeMaterial = new ShaderMaterial();
        wireframeMaterial.cull = CULLFACE_NONE;
        wireframeMaterial.blendType = BLEND_NONE;
        wireframeMaterial.depthTest = true;
        wireframeMaterial.depthFunc = FUNC_LESSEQUAL;
        wireframeMaterial.depthWrite = false;
        wireframeMaterial.shaderDesc = {
            uniqueName: 'CollisionWireframeFlat',
            vertexGLSL: positionOnlyVertexGLSL,
            fragmentGLSL: constantBlackFragmentGLSL,
            vertexWGSL: positionOnlyVertexWGSL,
            fragmentWGSL: constantBlackFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        };
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
