import { BLEND_NORMAL, CULLFACE_NONE, Entity, SEMANTIC_POSITION, ShaderMaterial } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// The ground of a scene without collision, in XR: a patch of the floor the user stands on (the
// splats', xr-splat-floor.ts), RADIUS across around the user's feet and following them, so content
// with no floor of its own (a car, a statue) shows where the floor is, wherever they stand. Lines
// CELL apart, fixed in the world, show it passing underfoot as they move; it fades out to its edge.
// The sizes are for a user at real size and scale with them. It sits just above that floor, below
// the navigation's ring, and draws after the splats as XR's other overlays do (xr-teleport-arc.ts):
// the stochastic renderer's depth then hides it behind what stands in front, and the sorted one,
// which leaves none, draws it over its splats
const RADIUS = 2.5;
const CELL = 0.5;
const LIFT = 0.002;

const vertexGLSL = /* glsl */ `
    attribute vec3 vertex_position;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    varying vec3 world;

    void main(void) {
        vec4 position = matrix_model * vec4(vertex_position, 1.0);
        world = position.xyz;
        gl_Position = matrix_viewProjection * position;
    }
`;

const vertexWGSL = /* wgsl */ `
    attribute vertex_position: vec3f;

    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;

    varying world: vec3f;

    @vertex
    fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        let position = uniform.matrix_model * vec4f(input.vertex_position, 1.0);
        output.world = position.xyz;
        output.position = uniform.matrix_viewProjection * position;
        return output;
    }
`;

const fragmentGLSL = /* glsl */ `
    uniform vec3 uCenter;
    uniform float uRadius;
    uniform float uCell;

    varying vec3 world;

    void main(void) {
        float fade = 1.0 - smoothstep(0.25, 1.0, distance(world.xz, uCenter.xz) / uRadius);
        vec2 cell = world.xz / uCell;
        vec2 edge = abs(fract(cell - 0.5) - 0.5) / fwidth(cell);
        float line = 1.0 - min(min(edge.x, edge.y), 1.0);
        gl_FragColor = vec4(vec3(0.85, 0.9, 0.95), fade * (0.06 + 0.3 * line));
    }
`;

const fragmentWGSL = /* wgsl */ `
    uniform uCenter: vec3f;
    uniform uRadius: f32;
    uniform uCell: f32;

    varying world: vec3f;

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let fade = 1.0 - smoothstep(0.25, 1.0, distance(input.world.xz, uniform.uCenter.xz) / uniform.uRadius);
        let cell = input.world.xz / uniform.uCell;
        let edge = abs(fract(cell - vec2f(0.5)) - vec2f(0.5)) / fwidth(cell);
        let line = 1.0 - min(min(edge.x, edge.y), 1.0);
        output.color = vec4f(vec3f(0.85, 0.9, 0.95), fade * (0.06 + 0.3 * line));
        return output;
    }
`;

/** A patch of the teleport plane around the user's feet in a scene without collision, in XR. */
class XrGroundDisc {
    private entity: Entity;

    private material: ShaderMaterial;

    private center = new Float32Array(3);

    private updating: { off(): void };

    /**
     * @param app - The application.
     * @param camera - The camera, the user's eyes; the patch follows it across the floor.
     * @param groundY - The height of the floor the user stands on.
     * @param userScale - The user's scale.
     */
    constructor(app: AppBase, camera: Entity, groundY: () => number, userScale: () => number) {
        this.material = new ShaderMaterial({
            uniqueName: 'sse-xr-ground-disc',
            vertexGLSL,
            fragmentGLSL,
            vertexWGSL,
            fragmentWGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION
            }
        });
        this.material.blendType = BLEND_NORMAL;
        this.material.cull = CULLFACE_NONE;
        this.material.depthWrite = false;
        this.material.update();

        this.entity = new Entity('XrGroundDisc', app);
        this.entity.addComponent('render', { type: 'plane', castShadows: false, receiveShadows: false });
        this.entity.render.material = this.material;
        for (const meshInstance of this.entity.render.meshInstances) meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
        this.entity.enabled = false;
        app.root.addChild(this.entity);

        this.updating = app.on('update', () => {
            if (!this.entity.enabled) return;
            const s = userScale();
            const eyes = camera.getPosition();
            this.entity.setPosition(eyes.x, groundY() + LIFT * s, eyes.z);
            this.entity.setLocalScale(RADIUS * 2 * s, 1, RADIUS * 2 * s);
            this.center[0] = eyes.x;
            this.center[1] = groundY();
            this.center[2] = eyes.z;
            this.material.setParameter('uCenter', this.center);
            this.material.setParameter('uRadius', RADIUS * s);
            this.material.setParameter('uCell', CELL * s);
        });
    }

    set visible(value: boolean) {
        this.entity.enabled = value;
    }

    destroy() {
        this.updating.off();
        this.entity.destroy();
        this.material.destroy();
    }
}

export { XrGroundDisc };
