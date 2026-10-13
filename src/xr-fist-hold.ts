import {
    BLEND_NORMAL,
    CULLFACE_NONE,
    Entity,
    Mat4,
    Quat,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    ShaderMaterial,
    Vec3
} from 'playcanvas';
import type { AppBase, BoundingBox, Color, XrHand, XrInputSource } from 'playcanvas';

import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// Holding the splat on the back of the left fist, the world in miniature (Stoakley, Conway and
// Pausch, CHI 1995). Closing the left hand, palm down, while the right is open fills a ring on its
// back over ARM_TIME seconds; then the splat jumps onto the fist, upright on the back of the hand: a scene at
// SCENE_SCALE pinned where the user stands, an object fitted to OBJECT_SIZE. Opening the hand, or
// losing it for LOST_TIME, puts it back where it was at once. The sizes are for a user at real size
// and scale with them as the hold starts; a scene held keeps its size while the two-hand grab
// scales the user, so the grab grows or shrinks it in the hand.
//
// A fist closes by the engine's test (all four fingers folded back, its emulated squeeze), and
// then holds while HELD_FINGERS of them stay folded past a right angle: on Apple Vision Pro the
// engine's test reads a closed fist's index finger open for half a second at a time. A left hand
// open, and a right fist, count once they last FLICKER_TIME, as a relaxed right hand curls into the
// engine's fist for a few frames now and then. And the left keeps its state while the right is a
// fist (the two-hand grab) or within COVER_DISTANCE of it: a right hand over the left hides its
// fingers, which visionOS then reports open.
// The ring fills while the back of the hand faces up, where it is in view: within FACE_START of
// straight up as it starts (the cosine, about 50 degrees) and FACE_KEEP once filling (about 65)
const FACE_START = 0.65;
const FACE_KEEP = 0.42;
const ARM_TIME = 2;
const FLICKER_TIME = 0.2;
const HELD_FINGERS = 3;
const LOST_TIME = 1;
const COVER_DISTANCE = 0.15;
const SCENE_SCALE = 0.01;
const OBJECT_SIZE = 0.15;
// above the joint along the back of the hand's normal: the splat's floor or bottom, and the ring
const LIFT = 0.01;
const RING_LIFT = 0.03;
const RING_SIZE = 0.05;
// the joint the splat sits on, whose +Y points out of the back of the hand (WebXR Hand Input)
const JOINT = 'middle-finger-metacarpal';

// The ring fills clockwise from the top, a faint track ahead of it
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

const fragmentGLSL = /* glsl */ `
    uniform vec4 uColor;
    uniform float uProgress;

    varying vec2 uv0;

    // the ring's inner radius, a share of its outer
    const float INNER = 0.72;

    void main(void) {
        vec2 p = uv0 * 2.0 - 1.0;
        float r = length(p);
        float aa = fwidth(r);
        float band = smoothstep(INNER - aa, INNER, r) * (1.0 - smoothstep(1.0 - aa, 1.0, r));
        float angle = fract(atan(p.x, p.y) / 6.2831853 + 1.0);
        float filled = step(angle, uProgress);
        gl_FragColor = vec4(uColor.rgb, uColor.a * band * mix(0.25, 1.0, filled));
    }
`;

const fragmentWGSL = /* wgsl */ `
    uniform uColor: vec4f;
    uniform uProgress: f32;

    varying uv0: vec2f;

    const INNER: f32 = 0.72;

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let p = input.uv0 * 2.0 - vec2f(1.0);
        let r = length(p);
        let aa = fwidth(r);
        let band = smoothstep(INNER - aa, INNER, r) * (1.0 - smoothstep(1.0 - aa, 1.0, r));
        let angle = fract(atan2(p.x, p.y) / 6.2831853 + 1.0);
        let filled = step(angle, uniform.uProgress);
        output.color = vec4f(uniform.uColor.rgb, uniform.uColor.a * band * mix(0.25, 1.0, filled));
        return output;
    }
`;

const up = new Vec3();
const target = new Vec3();
const offset = new Vec3();
const position = new Vec3();
const rotation = new Quat();
const inverse = new Mat4();
const turn = new Mat4();

const handOf = (sources: XrInputSource[], handedness: string) =>
    sources.find((source) => source.hand && source.handedness === handedness) ?? null;

// how many of the hand's four fingers fold past a right angle: the knuckle's bone against the
// finger's last but one, as the engine's test measures them
const boneA = new Vec3();
const boneB = new Vec3();
const foldedFingers = (hand: XrHand) => {
    let folded = 0;
    for (let i = 1; i <= 4; i++) {
        const { joints } = hand.fingers[i];
        boneA.sub2(joints[0].getPosition(), joints[1].getPosition());
        boneB.sub2(joints[2].getPosition(), joints[3].getPosition());
        if (boneA.dot(boneB) < 0) folded++;
    }
    return folded;
};

/**
 * Holds the loaded splat on the back of the left fist while {@link XrFistHold#enabled} (the XR
 * menu's World on Fist). The two-hand grab carries on while it is held; the viewer pauses the
 * teleport ({@link XrFistHold#holding}).
 */
class XrFistHold {
    private app: AppBase;

    private entity: Entity;

    private scene: boolean;

    private rig: Entity;

    private userScale: () => number;

    private onHolding: (holding: boolean) => void;

    private ring: Entity;

    private material: ShaderMaterial;

    private color = new Float32Array(4);

    private on = false;

    // seconds the left fist has been held with the right hand open, the left hand open (while
    // tracked) and lost, and the right a fist
    private armed = 0;

    private openFor = FLICKER_TIME;

    private lostFor = 0;

    private rightFor = 0;

    // whether the splat is on the fist
    private hold = false;

    // the left hand's joint as last tracked
    private handPosition = new Vec3();

    private handRotation = new Quat();

    // where the splat was, the point that sits on the fist (in the splat's space), the splat's
    // scale on the fist and the height of its bottom above that point
    private homePosition = new Vec3();

    private homeRotation = new Quat();

    private homeScale = new Vec3();

    private pinLocal = new Vec3();

    private holdScale = 1;

    private bottom = 0;

    private updating: { off(): void };

    /**
     * @param app - The application.
     * @param entity - The splat's entity, a child of the root.
     * @param scene - Whether it is a scene, held pinned where the user stands, or an object.
     * @param rig - The camera's parent, where the user stands.
     * @param userScale - The user's scale.
     * @param color - The ring's color.
     * @param onHolding - Called as the hold takes the splat and gives it back.
     */
    constructor(
        app: AppBase,
        entity: Entity,
        scene: boolean,
        rig: Entity,
        userScale: () => number,
        color: Color,
        onHolding: (holding: boolean) => void
    ) {
        this.app = app;
        this.entity = entity;
        this.scene = scene;
        this.rig = rig;
        this.userScale = userScale;
        this.onHolding = onHolding;

        this.material = new ShaderMaterial({
            uniqueName: 'sse-fist-hold-ring',
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
        this.material.cull = CULLFACE_NONE;
        // over the hand model, which would hide it in part
        this.material.depthTest = false;
        this.material.depthWrite = false;
        this.material.update();
        this.color.set([color.r, color.g, color.b, color.a]);
        this.material.setParameter('uColor', this.color);

        this.ring = new Entity('XrFistHoldRing', app);
        this.ring.addComponent('render', { type: 'plane', castShadows: false, receiveShadows: false });
        this.ring.render.material = this.material;
        for (const meshInstance of this.ring.render.meshInstances) meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
        this.ring.enabled = false;
        app.root.addChild(this.ring);

        // after the scripts and the grab have moved the rig, so the splat sits where the hand
        // model is drawn
        this.updating = app.on('update', (dt: number) => this.update(dt));
    }

    /** Whether a left fist summons the splat. Turning it off gives a held splat back. */
    set enabled(value: boolean) {
        this.on = value;
        if (!value) {
            this.armed = 0;
            this.release();
        }
    }

    get enabled() {
        return this.on;
    }

    /** Whether the splat is on the fist. */
    get holding() {
        return this.hold;
    }

    /** Puts the splat back at once, as the session ends or the user is put back at the start. */
    cancel() {
        this.armed = 0;
        this.openFor = FLICKER_TIME;
        this.rightFor = 0;
        this.ring.enabled = false;
        this.release();
    }

    destroy() {
        this.cancel();
        this.updating.off();
        this.ring.destroy();
        this.material.destroy();
    }

    private update(dt: number) {
        const { xr } = this.app;
        if (!xr?.active) return;
        const sources = xr.input.inputSources;
        const left = handOf(sources, 'left');
        const joint = left?.hand.tracking ? left.hand.getJointById(JOINT) : null;
        if (joint) {
            this.handPosition.copy(joint.getPosition());
            this.handRotation.copy(joint.getRotation());
            this.lostFor = 0;
        } else {
            this.lostFor += dt;
        }
        const right = handOf(sources, 'right');
        const rightJoint = right?.hand.tracking ? right.hand.getJointById(JOINT) : null;
        const covered =
            !!right?.squeezing ||
            (!!joint &&
                !!rightJoint &&
                rightJoint.getPosition().distance(this.handPosition) < COVER_DISTANCE * this.userScale());
        // a hand out of sight, or covered, is neither open nor closed: losing it counts by LOST_TIME
        if (joint && left && !covered) {
            const wasFist = this.openFor < FLICKER_TIME;
            const closed = left.squeezing || (wasFist && foldedFingers(left.hand) >= HELD_FINGERS);
            this.openFor = closed ? 0 : this.openFor + dt;
        }
        const fist = this.openFor < FLICKER_TIME;
        this.rightFor = right?.squeezing ? this.rightFor + dt : 0;
        const rightFist = this.rightFor >= FLICKER_TIME;

        if (this.hold) {
            if (!fist || this.lostFor > LOST_TIME || !this.on) this.release();
        } else if (this.on && fist && !rightFist && this.lostFor < FLICKER_TIME && this.facingUp()) {
            // a moment without the hand pauses the ring
            if (joint) this.armed += dt;
            if (this.armed >= ARM_TIME) {
                this.armed = 0;
                this.take();
            }
        } else {
            this.armed = 0;
        }

        this.ring.enabled = this.armed > 0;
        if (this.ring.enabled) this.placeRing();

        if (this.hold) this.place();
    }

    // whether the back of the hand faces up (the palm down), with the ring on it in view
    private facingUp() {
        this.handRotation.transformVector(Vec3.UP, up);
        return up.y > (this.armed > 0 ? FACE_KEEP : FACE_START);
    }

    private placeRing() {
        const s = this.userScale();
        this.handRotation.transformVector(Vec3.UP, up);
        target
            .copy(up)
            .mulScalar(RING_LIFT * s)
            .add(this.handPosition);
        this.ring.setPosition(target);
        this.ring.setRotation(this.handRotation);
        this.ring.setLocalScale(RING_SIZE * s, 1, RING_SIZE * s);
        this.material.setParameter('uProgress', this.armed / ARM_TIME);
    }

    // records where the splat is and how it sits on the fist, and takes it
    private take() {
        const { entity } = this;
        this.homePosition.copy(entity.getLocalPosition());
        this.homeRotation.copy(entity.getLocalRotation());
        this.homeScale.copy(entity.getLocalScale());

        const world = entity.getWorldTransform();
        const s = this.userScale();
        const aabb = (entity.gsplat?.resource as { aabb?: BoundingBox } | null)?.aabb;
        if (this.scene || !aabb) {
            // the floor where the user stands; the bounds of a scene reach its stray splats
            inverse.copy(world).invert();
            inverse.transformPoint(this.rig.getPosition(), this.pinLocal);
            this.holdScale = SCENE_SCALE * s;
            this.bottom = 0;
        } else {
            // the bounds' middle, the bottom resting on the hand, as it stands upright now
            const { halfExtents: h } = aabb;
            this.pinLocal.copy(aabb.center);
            this.holdScale = (OBJECT_SIZE * s) / (2 * Math.max(h.x, h.y, h.z, 1e-6));
            turn.setTRS(Vec3.ZERO, entity.getRotation(), Vec3.ONE);
            const m = turn.data;
            this.bottom = this.holdScale * (Math.abs(m[1]) * h.x + Math.abs(m[5]) * h.y + Math.abs(m[9]) * h.z);
        }
        this.hold = true;
        this.onHolding(true);
    }

    // the splat on the fist: its pinned point above the joint, turned with the hand
    private place() {
        const { entity } = this;
        this.handRotation.transformVector(Vec3.UP, up);
        target
            .copy(up)
            .mulScalar(LIFT * this.userScale() + this.bottom)
            .add(this.handPosition);
        rotation.mul2(this.handRotation, this.homeRotation);
        offset.copy(this.pinLocal).mulScalar(this.holdScale);
        rotation.transformVector(offset, offset);
        position.sub2(target, offset);
        entity.setPosition(position);
        entity.setRotation(rotation);
        entity.setLocalScale(this.holdScale, this.holdScale, this.holdScale);
    }

    // puts a held splat back where it was
    private release() {
        if (!this.hold) return;
        this.hold = false;
        const { entity } = this;
        entity.setLocalPosition(this.homePosition);
        entity.setLocalRotation(this.homeRotation);
        entity.setLocalScale(this.homeScale);
        this.onHolding(false);
    }
}

export { XrFistHold };
