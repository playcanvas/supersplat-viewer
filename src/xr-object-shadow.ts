import {
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_ZERO,
    BlendState,
    CULLFACE_NONE,
    Entity,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    ShaderMaterial,
    Vec3
} from 'playcanvas';
import type { AppBase, BoundingBox } from 'playcanvas';

// A soft shadow under an object placed in AR, where the room is real and the object would
// otherwise float over it: a dark patch on the surface it was placed on, under the footprint of its
// bounds as it stands (turned with it), SPREAD of it across (the bounds reach a little past what
// shows), OPACITY at its middle, flat across most of it and falling off to its edge by SHARPNESS
// (a gaussian of the fourth power of the distance from its middle). Lifting the object leaves the
// shadow on that surface as it is. It draws before the splats (SHADOW_DRAW_BUCKET above theirs,
// 127: the World layer draws its transparent instances by bucket, highest first), so the object
// covers its own shadow wherever it stands over it, and it writes no depth; LIFT keeps it off the
// surface. The frame is premultiplied, its alpha what hides the room, so the patch darkens what is
// drawn, and covers the room, by its opacity once
const OPACITY = 0.7;
const SPREAD = 0.85;
const SHARPNESS = 3;
const LIFT = 0.002;
const SHADOW_DRAW_BUCKET = 200;

const vertexGLSL = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec2 aUv0;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;

    varying vec2 uv0;

    void main(void) {
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
        uv0 = aUv0;
    }
`;

const vertexWGSL = /* wgsl */ `
    attribute vertex_position: vec3f;
    attribute aUv0: vec2f;

    uniform matrix_model: mat4x4f;
    uniform matrix_viewProjection: mat4x4f;

    varying uv0: vec2f;

    @vertex
    fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(input.vertex_position, 1.0);
        output.uv0 = input.aUv0;
        return output;
    }
`;

// flat across most of the quad, falling off to nearly nothing at its edge
const fragmentGLSL = /* glsl */ `
    uniform float uOpacity;
    uniform float uSharpness;

    varying vec2 uv0;

    void main(void) {
        vec2 p = uv0 * 2.0 - 1.0;
        float r2 = dot(p, p);
        gl_FragColor = vec4(0.0, 0.0, 0.0, uOpacity * exp(-uSharpness * r2 * r2));
    }
`;

const fragmentWGSL = /* wgsl */ `
    uniform uOpacity: f32;
    uniform uSharpness: f32;

    varying uv0: vec2f;

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let p = input.uv0 * 2.0 - vec2f(1.0);
        let r2 = dot(p, p);
        output.color = vec4f(0.0, 0.0, 0.0, uniform.uOpacity * exp(-uniform.uSharpness * r2 * r2));
        return output;
    }
`;

const corner = new Vec3();
const center = new Vec3();
const across = new Vec3();

/** A soft shadow under an object the user has placed on a surface of the room in AR. */
class XrObjectShadow {
    private entity: Entity;

    private splat: Entity;

    private material: ShaderMaterial;

    private updating: { off(): void };

    /**
     * @param app - The application.
     * @param splat - The object's splat entity.
     * @param surface - Where the object was last placed on a surface of the room, in the world, or
     * null while it has not been (or where the shadow should not show: it is held, or not in AR).
     */
    constructor(app: AppBase, splat: Entity, surface: () => Vec3 | null) {
        this.splat = splat;
        this.material = new ShaderMaterial({
            uniqueName: 'sse-xr-object-shadow',
            vertexGLSL,
            fragmentGLSL,
            vertexWGSL,
            fragmentWGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                aUv0: SEMANTIC_TEXCOORD0
            }
        });
        // black, so what is drawn is scaled by one less the opacity, and the alpha that hides the
        // room gains it: over a premultiplied frame
        this.material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD,
            BLENDMODE_ZERO,
            BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD,
            BLENDMODE_ONE,
            BLENDMODE_ONE_MINUS_SRC_ALPHA
        );
        this.material.cull = CULLFACE_NONE;
        this.material.depthWrite = false;
        this.material.setParameter('uOpacity', OPACITY);
        this.material.setParameter('uSharpness', SHARPNESS);
        this.material.update();

        this.entity = new Entity('XrObjectShadow', app);
        this.entity.addComponent('render', { type: 'plane', castShadows: false, receiveShadows: false });
        this.entity.render.material = this.material;
        for (const meshInstance of this.entity.render.meshInstances) meshInstance.drawBucket = SHADOW_DRAW_BUCKET;
        this.entity.enabled = false;
        app.root.addChild(this.entity);

        this.updating = app.on('update', () => this.update(surface()));
    }

    destroy() {
        this.updating.off();
        this.entity.destroy();
        this.material.destroy();
    }

    private update(surface: Vec3 | null) {
        const aabb = (this.splat.gsplat?.resource as { aabb?: BoundingBox } | null)?.aabb;
        if (!surface || !aabb) {
            this.entity.enabled = false;
            return;
        }

        // the footprint of the bounds as the object stands: their corners across the floor along the
        // object's own right (its X axis, flattened) and the way square to it
        const world = this.splat.getWorldTransform();
        world.getX(across);
        across.y = 0;
        if (across.lengthSq() < 1e-8) {
            world.getZ(across);
            across.y = 0;
        }
        if (across.lengthSq() < 1e-8) across.set(1, 0, 0);
        across.normalize();
        world.transformPoint(aabb.center, center);
        let halfA = 0;
        let halfB = 0;
        const { halfExtents: h } = aabb;
        for (let i = 0; i < 8; i++) {
            corner.set(i & 1 ? h.x : -h.x, i & 2 ? h.y : -h.y, i & 4 ? h.z : -h.z).add(aabb.center);
            world.transformPoint(corner, corner).sub(center);
            halfA = Math.max(halfA, Math.abs(corner.x * across.x + corner.z * across.z));
            halfB = Math.max(halfB, Math.abs(corner.z * across.x - corner.x * across.z));
        }

        this.entity.enabled = true;
        this.entity.setPosition(center.x, surface.y + LIFT, center.z);
        this.entity.setEulerAngles(0, Math.atan2(-across.z, across.x) * (180 / Math.PI), 0);
        this.entity.setLocalScale(2 * halfA * SPREAD, 1, 2 * halfB * SPREAD);
    }
}

export { XrObjectShadow };
