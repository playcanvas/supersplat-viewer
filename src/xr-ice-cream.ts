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
import type { AppBase, BoundingBox, XrHand, XrInputSource } from 'playcanvas';

import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// Holding the splat on top of the left fist, where a cone's scoop would be: the world in miniature
// (Stoakley, Conway and Pausch, CHI 1995). Closing the left hand, held upright and looked at, while
// the right is open fills a ring on top of the fist over ARM_TIME seconds; then the splat pops
// there, standing along the axis through the fist: a scene at SCENE_SCALE pinned where the user
// stands, an object fitted to OBJECT_SIZE. Twisting the wrist turns it like a turntable and bending
// it tips it.
// Opening the hand, or losing it for LOST_TIME, puts it back where it was at once. The sizes are for
// a user at real size and scale with them as the hold starts; a scene held keeps its size while the
// two-hand grab scales the user, so the grab grows or shrinks it in the hand.
//
// A fist closes by the engine's test (all four fingers folded back, its emulated squeeze), and
// then holds while HELD_FINGERS of them stay folded past a right angle: on Apple Vision Pro the
// engine's test reads a closed fist's index finger open for half a second at a time. A left hand
// open, and a right fist, count once they last FLICKER_TIME, as a relaxed right hand curls into the
// engine's fist for a few frames now and then. And the left keeps its state while the right is a
// fist (the two-hand grab) or within COVER_DISTANCE of it: a right hand over the left hides its
// fingers, which visionOS then reports open.
//
// The ring fills while the fist is upright, where its top is in view: the axis through it within
// UPRIGHT_START of straight up as it starts (the cosine, about 50 degrees) and UPRIGHT_KEEP once
// filling (about 65); and while the user looks at it: its top within LOOK_START of the middle of
// the view as it starts (about 25 degrees) and LOOK_KEEP once filling (about 40)
const UPRIGHT_START = 0.65;
const UPRIGHT_KEEP = 0.42;
const LOOK_START = 0.9;
const LOOK_KEEP = 0.77;
const ARM_TIME = 2;
const FLICKER_TIME = 0.2;
const HELD_FINGERS = 3;
const LOST_TIME = 1;
const COVER_DISTANCE = 0.15;
const SCENE_SCALE = 0.01;
const OBJECT_SIZE = 0.15;
// above the top of the fist along its axis: the splat's floor or bottom, and the ring
const LIFT = 0.02;
const RING_LIFT = 0.02;
const RING_SIZE = 0.0625;
// The ring's juice: its fill speeds up as it goes (FILL_LINEAR of it linear, the rest cubic), and
// it grows from RING_GROW of its size and throbs faster as it fills, PULSE_START to PULSE_END times
// a second. Full, it bursts out to BURST_SCALE times its size over BURST_TIME, fading, as the splat
// pops onto the fist over POP_TIME, overshooting a little
const FILL_LINEAR = 0.35;
const RING_GROW = 0.8;
const PULSE_START = 1.5;
const PULSE_END = 6;
const BURST_TIME = 0.35;
const BURST_SCALE = 1.8;
const POP_TIME = 0.4;
// the fill's colours: PlayCanvas orange (#f60, the SuperSplat editor's highlight), which stands out
// against the hands' cyan, a little deeper where the fill starts, and a warm white for its head
const FILL_START = [0.85, 0.3, 0.0];
const FILL_HEAD = [1.0, 0.4, 0.0];
const FILL_CAP = [1.0, 0.85, 0.7];
// the right hand's joint the cover test measures from
const COVER_JOINT = 'middle-finger-metacarpal';

// The ring fills clockwise from the top, a faint track ahead of it, its colour running from start to
// head, brightest at the head, which is a round cap a little wider than the band
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
    uniform float uProgress;
    uniform float uPulse;
    uniform float uBurst;

    varying vec2 uv0;

    // the ring's outer radius, a share of the quad's half width (the head's cap reaches past it),
    // and its inner, a share of that
    const float OUTER = 0.8;
    const float INNER = OUTER * 0.72;
    const vec3 START = vec3(${FILL_START.join(', ')});
    const vec3 HEAD = vec3(${FILL_HEAD.join(', ')});
    const vec3 CAP = vec3(${FILL_CAP.join(', ')});

    void main(void) {
        vec2 p = uv0 * 2.0 - 1.0;
        float r = length(p);
        float aa = fwidth(r);
        float band = smoothstep(INNER - aa, INNER, r) * (1.0 - smoothstep(OUTER - aa, OUTER, r));
        float angle = fract(atan(p.x, p.y) / 6.2831853 + 1.0);
        float filled = step(angle, uProgress);
        float tail = exp(-(uProgress - angle) * 10.0);
        vec3 fill = mix(START, HEAD, angle / max(uProgress, 0.001)) * (1.0 + 0.5 * tail + 0.3 * uPulse);
        vec3 rgb = mix(vec3(1.0), fill, filled);
        float a = band * mix(0.2, 0.75 + 0.25 * tail, filled);
        float headAngle = uProgress * 6.2831853;
        vec2 head = vec2(sin(headAngle), cos(headAngle)) * 0.5 * (INNER + OUTER);
        float capRadius = 0.5 * (OUTER - INNER) * (1.25 + 0.35 * uPulse);
        float cap = (1.0 - smoothstep(capRadius - aa, capRadius + aa, length(p - head))) * step(0.001, uProgress);
        rgb = mix(rgb, CAP, 0.7 * cap);
        a = max(a, cap);
        gl_FragColor = vec4(rgb, a * (1.0 - uBurst) * (1.0 - uBurst));
    }
`;

const fragmentWGSL = /* wgsl */ `
    uniform uProgress: f32;
    uniform uPulse: f32;
    uniform uBurst: f32;

    varying uv0: vec2f;

    const OUTER: f32 = 0.8;
    const INNER: f32 = OUTER * 0.72;
    const START = vec3f(${FILL_START.join(', ')});
    const HEAD = vec3f(${FILL_HEAD.join(', ')});
    const CAP = vec3f(${FILL_CAP.join(', ')});

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let p = input.uv0 * 2.0 - vec2f(1.0);
        let r = length(p);
        let aa = fwidth(r);
        let band = smoothstep(INNER - aa, INNER, r) * (1.0 - smoothstep(OUTER - aa, OUTER, r));
        let angle = fract(atan2(p.x, p.y) / 6.2831853 + 1.0);
        let progress = uniform.uProgress;
        let filled = step(angle, progress);
        let tail = exp(-(progress - angle) * 10.0);
        let fill = mix(START, HEAD, angle / max(progress, 0.001)) * (1.0 + 0.5 * tail + 0.3 * uniform.uPulse);
        var rgb = mix(vec3f(1.0), fill, filled);
        var a = band * mix(0.2, 0.75 + 0.25 * tail, filled);
        let headAngle = progress * 6.2831853;
        let head = vec2f(sin(headAngle), cos(headAngle)) * 0.5 * (INNER + OUTER);
        let capRadius = 0.5 * (OUTER - INNER) * (1.25 + 0.35 * uniform.uPulse);
        let cap = (1.0 - smoothstep(capRadius - aa, capRadius + aa, length(p - head))) * step(0.001, progress);
        rgb = mix(rgb, CAP, 0.7 * cap);
        a = max(a, cap);
        let fade = 1.0 - uniform.uBurst;
        output.color = vec4f(rgb, a * fade * fade);
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
const toFist = new Vec3();

// 0 to 1 over 0 to 1, past 1 by a tenth at about three quarters, then back
const overshoot = (x: number) => {
    const c = 1.70158;
    const y = x - 1;
    return 1 + (c + 1) * y * y * y + c * y * y;
};

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

// The top of a fist, where a cone held in it would come out, and the fist's frame there: +Y along
// the axis through the fist (the little finger's knuckle to the index finger's, which points out of
// the top of a thumb-up fist), -Z the way the knuckles point from the wrist. The top is between the
// index finger's knuckle and the thumb's last joint, the rim of the fist's opening. False where the
// hand lacks a joint
const axisX = new Vec3();
const axisY = new Vec3();
const axisZ = new Vec3();
const frame = new Mat4();
const measureFist = (hand: XrHand, top: Vec3, turned: Quat) => {
    const pinky = hand.getJointById('pinky-finger-phalanx-proximal');
    const index = hand.getJointById('index-finger-phalanx-proximal');
    const middle = hand.getJointById('middle-finger-phalanx-proximal');
    const thumb = hand.getJointById('thumb-phalanx-distal');
    const wrist = hand.getJointById('wrist');
    if (!pinky || !index || !middle || !thumb || !wrist) return false;

    axisY.sub2(index.getPosition(), pinky.getPosition()).normalize();
    // back along the hand, square to the axis
    axisZ.sub2(wrist.getPosition(), middle.getPosition());
    axisX.copy(axisY).mulScalar(axisZ.dot(axisY));
    axisZ.sub(axisX).normalize();
    axisX.cross(axisY, axisZ);
    const m = frame.data;
    m[0] = axisX.x;
    m[1] = axisX.y;
    m[2] = axisX.z;
    m[4] = axisY.x;
    m[5] = axisY.y;
    m[6] = axisY.z;
    m[8] = axisZ.x;
    m[9] = axisZ.y;
    m[10] = axisZ.z;
    turned.setFromMat4(frame);

    top.add2(index.getPosition(), thumb.getPosition()).mulScalar(0.5);
    return true;
};

/**
 * Holds the loaded splat on top of the left fist, like an ice cream in its cone, while
 * {@link XrIceCream#enabled} (the XR menu's Ice Cream). The two-hand grab carries on while it is
 * held; the viewer pauses the teleport ({@link XrIceCream#holding}).
 */
class XrIceCream {
    private app: AppBase;

    private entity: Entity;

    private scene: boolean;

    private rig: Entity;

    private camera: Entity;

    private userScale: () => number;

    private onHolding: (holding: boolean) => void;

    private ring: Entity;

    private material: ShaderMaterial;

    private on = false;

    // seconds the left fist has been held with the right hand open, the left hand open (while
    // tracked) and lost, and the right a fist
    private armed = 0;

    private openFor = FLICKER_TIME;

    private lostFor = 0;

    private rightFor = 0;

    // the ring's throb, its phase in turns, and the seconds since the ring burst and the splat
    // popped onto the fist (past BURST_TIME and POP_TIME when neither is under way)
    private pulse = 0;

    private burstFor = BURST_TIME;

    private popFor = POP_TIME;

    // whether the splat is on the fist
    private hold = false;

    // the top of the left fist and its frame (measureFist), as last tracked
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
     * @param camera - The camera, the user's eyes.
     * @param userScale - The user's scale.
     * @param onHolding - Called as the hold takes the splat and gives it back.
     */
    constructor(
        app: AppBase,
        entity: Entity,
        scene: boolean,
        rig: Entity,
        camera: Entity,
        userScale: () => number,
        onHolding: (holding: boolean) => void
    ) {
        this.app = app;
        this.entity = entity;
        this.scene = scene;
        this.rig = rig;
        this.camera = camera;
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

        this.ring = new Entity('XrIceCreamRing', app);
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
        this.burstFor = BURST_TIME;
        this.popFor = POP_TIME;
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
        const tracked = !!left?.hand.tracking && measureFist(left.hand, this.handPosition, this.handRotation);
        if (tracked) {
            this.lostFor = 0;
        } else {
            this.lostFor += dt;
        }
        const right = handOf(sources, 'right');
        const rightJoint = right?.hand.tracking ? right.hand.getJointById(COVER_JOINT) : null;
        const covered =
            !!right?.squeezing ||
            (tracked &&
                !!rightJoint &&
                rightJoint.getPosition().distance(this.handPosition) < COVER_DISTANCE * this.userScale());
        // a hand out of sight, or covered, is neither open nor closed: losing it counts by LOST_TIME
        if (tracked && left && !covered) {
            const wasFist = this.openFor < FLICKER_TIME;
            const closed = left.squeezing || (wasFist && foldedFingers(left.hand) >= HELD_FINGERS);
            this.openFor = closed ? 0 : this.openFor + dt;
        }
        const fist = this.openFor < FLICKER_TIME;
        this.rightFor = right?.squeezing ? this.rightFor + dt : 0;
        const rightFist = this.rightFor >= FLICKER_TIME;

        if (this.hold) {
            if (!fist || this.lostFor > LOST_TIME || !this.on) this.release();
        } else if (this.on && fist && !rightFist && this.lostFor < FLICKER_TIME && this.upright() && this.looking()) {
            // a moment without the hand pauses the ring
            if (tracked) this.armed += dt;
            if (this.armed >= ARM_TIME) {
                this.armed = 0;
                this.burstFor = 0;
                this.popFor = 0;
                this.take();
            }
        } else {
            this.armed = 0;
        }
        if (this.armed === 0) this.pulse = 0;

        this.ring.enabled = this.armed > 0 || this.burstFor < BURST_TIME;
        if (this.ring.enabled) this.placeRing(dt);

        if (this.hold) {
            this.popFor += dt;
            this.place();
        }
    }

    // whether the fist is upright, with its top in view
    private upright() {
        this.handRotation.transformVector(Vec3.UP, up);
        return up.y > (this.armed > 0 ? UPRIGHT_KEEP : UPRIGHT_START);
    }

    // whether the user looks at the top of the fist
    private looking() {
        toFist.sub2(this.handPosition, this.camera.getPosition()).normalize();
        return toFist.dot(this.camera.forward) > (this.armed > 0 ? LOOK_KEEP : LOOK_START);
    }

    // the ring on top of the fist: filling and throbbing, or full and bursting out
    private placeRing(dt: number) {
        let progress = 1;
        let pulse = 0;
        let burst = 0;
        let size: number;
        if (this.burstFor < BURST_TIME) {
            this.burstFor += dt;
            burst = Math.min(this.burstFor / BURST_TIME, 1);
            size = 1 + (BURST_SCALE - 1) * (1 - (1 - burst) * (1 - burst));
        } else {
            const t = this.armed / ARM_TIME;
            progress = t * (FILL_LINEAR + (1 - FILL_LINEAR) * t * t);
            this.pulse += dt * (PULSE_START + (PULSE_END - PULSE_START) * t);
            pulse = 0.5 + 0.5 * Math.sin(this.pulse * 2 * Math.PI);
            size = RING_GROW + (1 - RING_GROW) * progress + 0.04 * pulse;
        }
        const s = this.userScale() * size;
        this.handRotation.transformVector(Vec3.UP, up);
        target
            .copy(up)
            .mulScalar(RING_LIFT * this.userScale())
            .add(this.handPosition);
        this.ring.setPosition(target);
        this.ring.setRotation(this.handRotation);
        this.ring.setLocalScale(RING_SIZE * s, 1, RING_SIZE * s);
        this.material.setParameter('uProgress', progress);
        this.material.setParameter('uPulse', pulse);
        this.material.setParameter('uBurst', burst);
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

    // the splat on the fist: its pinned point above the top, turned with the fist, popping up to its
    // size from its pinned point as it arrives
    private place() {
        const { entity } = this;
        const pop = this.popFor < POP_TIME ? Math.max(overshoot(this.popFor / POP_TIME), 0.01) : 1;
        const scale = this.holdScale * pop;
        this.handRotation.transformVector(Vec3.UP, up);
        target
            .copy(up)
            .mulScalar(LIFT * this.userScale() + this.bottom * pop)
            .add(this.handPosition);
        rotation.mul2(this.handRotation, this.homeRotation);
        offset.copy(this.pinLocal).mulScalar(scale);
        rotation.transformVector(offset, offset);
        position.sub2(target, offset);
        entity.setPosition(position);
        entity.setRotation(rotation);
        entity.setLocalScale(scale, scale, scale);
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

export { XrIceCream };
