import {
    BLEND_NORMAL,
    CULLFACE_BACK,
    Entity,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    ShaderMaterial,
    Vec3
} from 'playcanvas';
import type { AppBase, Color } from 'playcanvas';

import type { VoxelCollision } from './collision';
import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// The floor around an XR teleport target, drawn as a grid of its voxels' tops: the floor joined to
// the target's across steps of a voxel at most, within FLOOR_DRIFT of its height and with
// FLOOR_HEADROOM clear above (so not under a pew or a table), fading out from the target. Ripples
// run out through it from the target like a drop in water, and it grows from the target when it
// first appears. The grid is built around the target on the cpu and rebuilt only once it moves
// REBUILD_DISTANCE from where it was built; the fade follows the live target, so the grid reaches
// RADIUS + REBUILD_DISTANCE. The sizes here are for a user at real size and scale with them, the
// grid up to GRID_SCALE_MAX (its squares are the voxels', which stay put, and it would rebuild far
// more of them).
const RADIUS = 0.8;
const REBUILD_DISTANCE = 0.4;
const REVEAL_TIME = 0.3;
const FLOOR_DRIFT = 0.15;
const FLOOR_HEADROOM = 0.5;
// just above the floor, below the navigation's target ring
const FLOOR_LIFT = 0.005;
const GRID_SCALE_MAX = 2;

// A drop every DROP_PERIOD seconds sends a ring of ripples out from the target at DROP_SPEED, dying
// away as it goes. The crests brighten the lines a little
const vertexGLSL = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec2 aUv0;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    uniform vec3 uTarget;
    uniform float uTime;
    uniform float uScale;

    varying vec2 uv0;
    varying float dist;
    varying float crest;

    const float DROP_PERIOD = 1.6;
    const float DROP_SPEED = 0.6;
    const float RIPPLE_LENGTH = 0.12;
    const float RIPPLE_WIDTH = 0.1;
    const float RIPPLE_HEIGHT = 0.012;

    void main(void) {
        vec4 world = matrix_model * vec4(vertex_position, 1.0);
        float r = distance(world.xz, uTarget.xz) / uScale;
        float age = fract(uTime / DROP_PERIOD) * DROP_PERIOD;
        float x = r - age * DROP_SPEED;
        float envelope = exp(-(x * x) / (RIPPLE_WIDTH * RIPPLE_WIDTH)) * (1.0 - age / DROP_PERIOD);
        float wave = cos(6.2831853 * x / RIPPLE_LENGTH) * envelope;
        world.y += RIPPLE_HEIGHT * uScale * wave;
        gl_Position = matrix_viewProjection * world;
        uv0 = aUv0;
        dist = r;
        crest = max(wave, 0.0);
    }
`;

const vertexWGSL = /* wgsl */ `
    attribute vertex_position: vec3f;
    attribute aUv0: vec2f;

    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;
    uniform uTarget: vec3f;
    uniform uTime: f32;
    uniform uScale: f32;

    varying uv0: vec2f;
    varying dist: f32;
    varying crest: f32;

    const DROP_PERIOD: f32 = 1.6;
    const DROP_SPEED: f32 = 0.6;
    const RIPPLE_LENGTH: f32 = 0.12;
    const RIPPLE_WIDTH: f32 = 0.1;
    const RIPPLE_HEIGHT: f32 = 0.012;

    @vertex
    fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        var world = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
        let r = distance(world.xz, uniform.uTarget.xz) / uniform.uScale;
        let age = fract(uniform.uTime / DROP_PERIOD) * DROP_PERIOD;
        let x = r - age * DROP_SPEED;
        let envelope = exp(-(x * x) / (RIPPLE_WIDTH * RIPPLE_WIDTH)) * (1.0 - age / DROP_PERIOD);
        let wave = cos(6.2831853 * x / RIPPLE_LENGTH) * envelope;
        world.y += RIPPLE_HEIGHT * uniform.uScale * wave;
        output.position = uniform.matrix_viewProjection * world;
        output.uv0 = input.aUv0;
        output.dist = r;
        output.crest = max(wave, 0.0);
        return output;
    }
`;

// Each square draws half of its edges' width, so where two meet the line is whole. uRadius is the
// reveal's radius
const fragmentGLSL = /* glsl */ `
    uniform vec4 uColor;
    uniform float uRadius;

    varying vec2 uv0;
    varying float dist;
    varying float crest;

    // half a line's width in pixels
    const float LINE_HALF = 0.75;

    void main(void) {
        float fade = 1.0 - smoothstep(uRadius * 0.3, uRadius, dist);
        vec2 edge = min(uv0, 1.0 - uv0) / max(fwidth(uv0), vec2(1e-6));
        float line = 1.0 - smoothstep(LINE_HALF - 0.5, LINE_HALF + 0.5, min(edge.x, edge.y));
        gl_FragColor = vec4(uColor.rgb, uColor.a * fade * (line * (0.55 + 0.3 * crest) + 0.04));
    }
`;

const fragmentWGSL = /* wgsl */ `
    uniform uColor: vec4f;
    uniform uRadius: f32;

    varying uv0: vec2f;
    varying dist: f32;
    varying crest: f32;

    const LINE_HALF: f32 = 0.75;

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let fade = 1.0 - smoothstep(uniform.uRadius * 0.3, uniform.uRadius, input.dist);
        let edge = min(input.uv0, vec2f(1.0) - input.uv0) / max(fwidth(input.uv0), vec2f(1e-6));
        let line = 1.0 - smoothstep(LINE_HALF - 0.5, LINE_HALF + 0.5, min(edge.x, edge.y));
        output.color = vec4f(uniform.uColor.rgb, uniform.uColor.a * fade * (line * (0.55 + 0.3 * input.crest) + 0.04));
        return output;
    }
`;

const blockMask = new Uint32Array(2);

/**
 * The floor around a world-space point on it (the top of a voxel): a square per floor column within
 * a radius, uvs 0 to 1 across it. Empty where the point is not on a floor.
 *
 * @param collision - The scene's voxel collision.
 * @param x - World X of the point.
 * @param y - World Y of the point.
 * @param z - World Z of the point.
 * @param radius - Distance from the point in meters.
 * @param scale - The user's scale, which the floor's drift and headroom scale with.
 * @returns The squares' positions, uvs and triangle indices.
 */
const buildFloorPatch = (collision: VoxelCollision, x: number, y: number, z: number, radius: number, scale: number) => {
    const { voxelResolution: res, leafSize, gridMinX, gridMinY, gridMinZ, flipXY } = collision;
    // The voxels here are indexed along the world's axes from a world origin: legacy data is
    // stored with x and y negated (FlippedVoxelCollision), where world voxel w is stored voxel
    // -w - 1, and stored voxel s world voxel -s - 1
    const flip = flipXY ? -1 : 1;
    const mirror = (i: number) => (flip > 0 ? i : -i - 1);
    const originX = flip * gridMinX;
    const originY = flip * gridMinY;
    const n = Math.ceil(radius / res);
    const drift = Math.ceil((FLOOR_DRIFT * scale) / res);
    const headroom = Math.ceil((FLOOR_HEADROOM * scale) / res);
    // the point is on the top of the voxel below the boundary nearest it
    const floorY = Math.round((y - originY) / res) - 1;
    // the columns around the point, and the voxels from below the lowest floor to above the
    // highest floor's headroom
    const size = 2 * n + 1;
    const height = 2 * drift + headroom + 1;
    const x0 = Math.floor((x - originX) / res) - n;
    const y0 = floorY - drift;
    const z0 = Math.floor((z - gridMinZ) / res) - n;
    const solid = new Uint8Array(size * height * size);
    const index = (lx: number, ly: number, lz: number) => (lz * height + ly) * size + lx;

    // read them a block at a time, in stored coordinates
    const storedX = [mirror(x0), mirror(x0 + size - 1)];
    const storedY = [mirror(y0), mirror(y0 + height - 1)];
    const bx0 = Math.floor(Math.min(storedX[0], storedX[1]) / leafSize);
    const bx1 = Math.floor(Math.max(storedX[0], storedX[1]) / leafSize);
    const by0 = Math.floor(Math.min(storedY[0], storedY[1]) / leafSize);
    const by1 = Math.floor(Math.max(storedY[0], storedY[1]) / leafSize);
    const bz0 = Math.floor(z0 / leafSize);
    const bz1 = Math.floor((z0 + size - 1) / leafSize);
    for (let bz = bz0; bz <= bz1; bz++) {
        for (let by = by0; by <= by1; by++) {
            for (let bx = bx0; bx <= bx1; bx++) {
                collision.readBlock(bx, by, bz, blockMask);
                if (blockMask[0] === 0 && blockMask[1] === 0) continue;
                for (let bit = 0; bit < 64; bit++) {
                    if (((blockMask[bit >> 5] >>> (bit & 31)) & 1) === 0) continue;
                    const lx = mirror(bx * leafSize + (bit & 3)) - x0;
                    const ly = mirror(by * leafSize + ((bit >> 2) & 3)) - y0;
                    const lz = bz * leafSize + (bit >> 4) - z0;
                    if (lx >= 0 && ly >= 0 && lz >= 0 && lx < size && ly < height && lz < size) {
                        solid[index(lx, ly, lz)] = 1;
                    }
                }
            }
        }
    }

    // each column's floor: its highest solid voxel within the drift with the headroom clear above
    // (beyond the region's top counts as clear), or -1
    const floors = new Int16Array(size * size).fill(-1);
    for (let lz = 0; lz < size; lz++) {
        for (let lx = 0; lx < size; lx++) {
            for (let ly = 2 * drift; ly >= 0; ly--) {
                if (!solid[index(lx, ly, lz)]) continue;
                let clear = true;
                for (let h = ly + 1; h <= ly + headroom && h < height && clear; h++) {
                    clear = !solid[index(lx, h, lz)];
                }
                if (clear) floors[lz * size + lx] = ly;
                break;
            }
        }
    }

    // the floor joined to the point's column, within the radius, across steps of a voxel
    const joined = new Uint8Array(size * size);
    const queue: number[] = [];
    const start = n * size + n;
    if (floors[start] >= 0 && Math.abs(floors[start] - drift) <= 1) {
        joined[start] = 1;
        queue.push(start);
    }
    const limit = (n + 0.5) * (n + 0.5);
    while (queue.length) {
        const column = queue.pop() as number;
        const cx = column % size;
        const cz = (column - cx) / size;
        for (let i = 0; i < 4; i++) {
            const nx = cx + (i === 0 ? 1 : i === 1 ? -1 : 0);
            const nz = cz + (i === 2 ? 1 : i === 3 ? -1 : 0);
            if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
            if ((nx - n) * (nx - n) + (nz - n) * (nz - n) > limit) continue;
            const next = nz * size + nx;
            if (joined[next] || floors[next] < 0 || Math.abs(floors[next] - floors[column]) > 1) continue;
            joined[next] = 1;
            queue.push(next);
        }
    }

    // the floor's height at each corner of the columns, the mean of the joined columns around it, so
    // the grid runs smoothly over a voxel's step rather than breaking at it
    const corners = size + 1;
    const cornerSum = new Float32Array(corners * corners);
    const cornerCount = new Uint8Array(corners * corners);
    for (let lz = 0; lz < size; lz++) {
        for (let lx = 0; lx < size; lx++) {
            const column = lz * size + lx;
            if (!joined[column]) continue;
            for (let i = 0; i < 4; i++) {
                const corner = (lz + (i >> 1)) * corners + lx + (i & 1);
                cornerSum[corner] += floors[column] + 1;
                cornerCount[corner]++;
            }
        }
    }

    // a square on top of each joined column, wound counter-clockwise seen from above
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let lz = 0; lz < size; lz++) {
        for (let lx = 0; lx < size; lx++) {
            if (!joined[lz * size + lx]) continue;
            const base = positions.length / 3;
            for (let i = 0; i < 4; i++) {
                const a = i & 1;
                const b = i >> 1;
                const corner = (lz + a) * corners + lx + b;
                const top = originY + (y0 + cornerSum[corner] / cornerCount[corner]) * res + FLOOR_LIFT;
                positions.push(originX + (x0 + lx + b) * res, top, gridMinZ + (z0 + lz + a) * res);
                uvs.push(a, b);
            }
            indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
        }
    }

    return {
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices)
    };
};

/**
 * Shows the floor around a teleport target while one is aimed at.
 */
class TeleportTarget {
    private app: AppBase;

    private collision: VoxelCollision;

    private material: ShaderMaterial;

    private entity: Entity;

    private centre = new Vec3();

    private built = false;

    // the scale the grid was built at
    private scale = 1;

    private time = 0;

    private color = new Float32Array(4);

    private target = new Float32Array(3);

    constructor(app: AppBase, collision: VoxelCollision) {
        this.app = app;
        this.collision = collision;
        this.material = new ShaderMaterial({
            uniqueName: 'sse-teleport-target',
            vertexGLSL,
            fragmentGLSL,
            vertexWGSL,
            fragmentWGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                aUv0: SEMANTIC_TEXCOORD0
            }
        });
        this.material.blendType = BLEND_NORMAL;
        this.material.cull = CULLFACE_BACK;
        // drawn over everything: the floor's splats would otherwise hide it in patches
        this.material.depthTest = false;
        this.material.depthWrite = false;
        this.material.update();

        this.entity = new Entity('TeleportTarget', app);
        this.entity.addComponent('render', { castShadows: false });
        this.entity.enabled = false;
        app.root.addChild(this.entity);
    }

    /**
     * Shows the floor around a target this frame.
     *
     * @param point - The target in world space.
     * @param color - The color to draw it in.
     * @param dt - Seconds since the last frame.
     * @param scale - The user's scale.
     */
    show(point: Vec3, color: Color, dt: number, scale: number) {
        if (!this.entity.enabled) {
            this.entity.enabled = true;
            this.time = 0;
        } else {
            this.time += dt;
        }

        const gridScale = Math.min(scale, GRID_SCALE_MAX);
        if (!this.built || gridScale !== this.scale || this.centre.distance(point) > REBUILD_DISTANCE * gridScale) {
            this.scale = gridScale;
            this.build(point);
        }

        const reveal = Math.min(this.time / REVEAL_TIME, 1);
        this.target[0] = point.x;
        this.target[1] = point.y;
        this.target[2] = point.z;
        this.color[0] = color.r;
        this.color[1] = color.g;
        this.color[2] = color.b;
        this.color[3] = color.a;
        this.material.setParameter('uTarget', this.target);
        this.material.setParameter('uTime', this.time);
        this.material.setParameter('uColor', this.color);
        this.material.setParameter('uScale', gridScale);
        this.material.setParameter('uRadius', RADIUS * (1 - (1 - reveal) * (1 - reveal)));
    }

    hide() {
        this.entity.enabled = false;
    }

    destroy() {
        this.entity.destroy();
        this.material.destroy();
    }

    private build(point: Vec3) {
        this.centre.copy(point);
        this.built = true;
        const { positions, uvs, indices } = buildFloorPatch(
            this.collision,
            point.x,
            point.y,
            point.z,
            (RADIUS + REBUILD_DISTANCE) * this.scale,
            this.scale
        );
        // the render component destroys the previous instance, and with it the previous mesh
        if (indices.length === 0) {
            this.entity.render.meshInstances = [];
            return;
        }
        const mesh = new Mesh(this.app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setUvs(0, uvs);
        mesh.setIndices(indices);
        mesh.update(PRIMITIVE_TRIANGLES);
        const meshInstance = new MeshInstance(mesh, this.material);
        meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
        this.entity.render.meshInstances = [meshInstance];
    }
}

export { buildFloorPatch, TeleportTarget };
