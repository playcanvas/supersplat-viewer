import {
    BLEND_NORMAL,
    BLENDEQUATION_ADD,
    BLENDMODE_SRC_ALPHA,
    BLENDMODE_ZERO,
    BlendState,
    CULLFACE_NONE,
    Entity,
    Quat,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    ShaderMaterial,
    StandardMaterial,
    Vec3,
    XRTRACKABLE_MESH,
    XRTRACKABLE_PLANE
} from 'playcanvas';
import type { AppBase, XrHitTestSource, XrInputSource } from 'playcanvas';

import type { XrObjectGrab } from './xr-object-grab';
import { createQuad, uploadQuad } from './xr-palm-menu';
import type { Quad } from './xr-palm-menu';
import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// Placing the splat in AR, as the teleport moves the user in VR: a select held (a pinch, a trigger)
// draws a thin ray from that hand or controller, and a ring where it meets a surface of the room,
// which the browser's hit test finds among the planes and mesh it has of it along the pointer's own
// ray; letting go moves the splat there. On a phone a touch does the same where the finger touches
// the room, and two fingers pinch to scale and twist to turn the splat about its base. Only a surface
// within LEVEL of horizontal (the cosine) takes it, a floor or a table top; letting go with no ring
// leaves it where it is. As the session starts the splat stands on the table in front of the user
// (XrObjectGrab.place), drawn at PREVIEW_ALPHA until its first placing, with a hint, above the ring
// or in front of the eyes, saying what to do. The ring glides to each new hit at SMOOTH (a lerp a
// second), and holds where it is for HOLD seconds without one; the splat glides to where it is placed
// the same way. The ring is RING_SIZE across, RING_LIFT above the surface, and draws over
// everything, as there is no depth of the room
const LEVEL = 0.8;
const PREVIEW_ALPHA = 0.35;
const SMOOTH = 10;
const HOLD = 1;
const RING_SIZE = 0.12;
const RING_LIFT = 0.003;
// the ray from the pointing hand: RAY_WIDTH thick at RAY_OPACITY, and RAY_REACH long while it has
// no surface
const RAY_WIDTH = 0.004;
const RAY_OPACITY = 0.55;
const RAY_REACH = 1.5;
// the hint: HINT_WIDTH by HINT_HEIGHT at HINT_PIXELS per meter, HINT_RISE above the ring, or
// HINT_AHEAD in front of the eyes and HINT_DROP below them; on a phone, where that reads small,
// fixed to the screen instead, HINT_SCREEN_WIDTH of its width across and HINT_SCREEN_LOW of the way
// from its middle to its bottom edge, HINT_SCREEN_AHEAD in front of the camera
const HINT_WIDTH = 0.26;
const HINT_HEIGHT = 0.036;
const HINT_PIXELS = 4000;
const HINT_RISE = 0.09;
const HINT_AHEAD = 0.8;
const HINT_DROP = 0.2;
const HINT_SCREEN_WIDTH = 0.9;
const HINT_SCREEN_LOW = 0.7;
const HINT_SCREEN_AHEAD = 0.3;
// The preview's fade: a quad over the whole view, given in clip space so it covers each eye's,
// which multiplies what is drawn by the fade, colour and alpha alike, as the frame is premultiplied
// and its alpha is what shows the room through. Drawn in FADE_DRAW_BUCKET, after the splats (127,
// either renderer's) and before XR's overlays (0, the ring, the hint, the menu), which stay solid
const FADE_DRAW_BUCKET = 64;

const ringVertexGLSL = /* glsl */ `
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

const ringVertexWGSL = /* wgsl */ `
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

// a band near the edge, and a faint fill inside it
const ringFragmentGLSL = /* glsl */ `
    varying vec2 uv0;

    void main(void) {
        float r = length(uv0 * 2.0 - 1.0);
        float aa = fwidth(r);
        float band = smoothstep(0.72 - aa, 0.72, r) * (1.0 - smoothstep(0.95 - aa, 0.95, r));
        float fill = 0.15 * (1.0 - smoothstep(0.0, 0.72, r));
        gl_FragColor = vec4(vec3(0.95), max(0.85 * band, fill));
    }
`;

const ringFragmentWGSL = /* wgsl */ `
    varying uv0: vec2f;

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        let r = length(input.uv0 * 2.0 - vec2f(1.0));
        let aa = fwidth(r);
        let band = smoothstep(0.72 - aa, 0.72, r) * (1.0 - smoothstep(0.95 - aa, 0.95, r));
        let fill = 0.15 * (1.0 - smoothstep(0.0, 0.72, r));
        output.color = vec4f(vec3f(0.95), max(0.85 * band, fill));
        return output;
    }
`;

// the engine's plane spans -0.5 to 0.5 in x and z, which twice over is the whole clip space
const fadeVertexGLSL = /* glsl */ `
    attribute vec3 vertex_position;

    void main(void) {
        gl_Position = vec4(vertex_position.x * 2.0, vertex_position.z * 2.0, 0.0, 1.0);
    }
`;

const fadeVertexWGSL = /* wgsl */ `
    attribute vertex_position: vec3f;

    @vertex
    fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.position = vec4f(input.vertex_position.x * 2.0, input.vertex_position.z * 2.0, 0.0, 1.0);
        return output;
    }
`;

const fadeFragmentGLSL = /* glsl */ `
    uniform float uFade;

    void main(void) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, uFade);
    }
`;

const fadeFragmentWGSL = /* wgsl */ `
    uniform uFade: f32;

    @fragment
    fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;
        output.color = vec4f(0.0, 0.0, 0.0, uniform.uFade);
        return output;
    }
`;

const up = new Vec3();
const point = new Vec3();
const facing = new Vec3();
const turn = new Quat();
const aimed = new Vec3();
const rayStart = new Vec3();
const rayEnd = new Vec3();

// The parts of WebXR the pointers' hit tests use: the engine's own wraps a transient input's hit
// test (a screen's touch) and the viewer's, not one from a pointer's ray, and the viewer is built
// without WebXR's typings
type RayHitTest = { cancel(): void };
type RayHitResult = {
    getPose(space: unknown): { transform: { position: DOMPointReadOnly; orientation: DOMPointReadOnly } } | null;
};
type RayPose = { transform: { position: DOMPointReadOnly; orientation: DOMPointReadOnly } };
type RaySession = { requestHitTestSource?(options: { space: unknown; entityTypes: string[] }): Promise<RayHitTest> };
type RayFrame = {
    getHitTestResults(source: RayHitTest): RayHitResult[];
    getPose(space: unknown, base: unknown): RayPose | undefined;
};

// A hand's or controller's hit test from its own ray, the browser's (its target ray space, which
// for a hand on Quest is the system's pointer, not the engine's ray from the fingers); that ray,
// this frame, in the session's space, where it has one; its last level hit there; and that hit's
// age in seconds
type Pointer = {
    space: unknown;
    test: RayHitTest | null;
    origin: Vec3;
    direction: Vec3;
    posed: boolean;
    hit: Vec3;
    age: number;
    cancelled: boolean;
};

/**
 * Places the splat on a surface of the room in AR until the user selects: where a hand or
 * controller points, in a headset, or where a finger touches, on a phone.
 */
class XrArPlacement {
    private app: AppBase;

    private rig: Entity;

    private camera: Entity;

    private grab: XrObjectGrab;

    private claimed: (source: XrInputSource) => boolean;

    private hintText: (pointing: boolean) => string;

    private ring: Entity;

    private ringMaterial: ShaderMaterial;

    private ray: Entity;

    private rayMaterial: StandardMaterial;

    private fade: Entity;

    private fadeMaterial: ShaderMaterial;

    // the hint, on a holder turned to face the eyes, and the text it was drawn with
    private hintHolder: Entity;

    private hint: Quad;

    private hintDrawn = '';

    // whether an AR session places the splat, and whether it has been placed yet
    private active = false;

    private placed = false;

    // A phone's touches: the hit test of the screen's transient inputs (null while it is requested),
    // and each touch's last level hit, in the session's space, with its age; the touches held, the
    // one placing, and the two pinching and twisting, with their spread and heading on the screen
    // as the second came down
    private source: XrHitTestSource | null = null;

    private touches = new Map<XrInputSource, { hit: Vec3; age: number }>();

    private held = new Set<XrInputSource>();

    private placingTouch: XrInputSource | null = null;

    private pinch: [XrInputSource, XrInputSource] | null = null;

    private pinchSpread = 0;

    private pinchHeading = 0;

    // the headset's pointers, and the one whose select is held, aiming
    private pointers = new Map<XrInputSource, Pointer>();

    private aiming: Pointer | null = null;

    // where the ring is, in the world, once it has shown this aim
    private ringAt = new Vec3();

    private ringFound = false;

    // where the splat's base is gliding from and to
    private baseAt = new Vec3();

    private goal = new Vec3();

    private gliding = false;

    private released = false;

    private handles: { off(): void }[];

    /**
     * @param app - The application.
     * @param rig - The camera's parent, whose space the hit test reports in.
     * @param camera - The camera, the user's eyes.
     * @param grab - The splat's grab, which stands it on the surface.
     * @param claimed - Whether a select belongs to something else (the system, the menu).
     * @param hintText - The hint's text, in the user's language, for pointing with a hand or
     * controller, or touching the screen (a phone).
     */
    constructor(
        app: AppBase,
        rig: Entity,
        camera: Entity,
        grab: XrObjectGrab,
        claimed: (source: XrInputSource) => boolean,
        hintText: (pointing: boolean) => string
    ) {
        this.app = app;
        this.rig = rig;
        this.camera = camera;
        this.grab = grab;
        this.claimed = claimed;
        this.hintText = hintText;

        this.ringMaterial = new ShaderMaterial({
            uniqueName: 'sse-xr-ar-placement-ring',
            vertexGLSL: ringVertexGLSL,
            fragmentGLSL: ringFragmentGLSL,
            vertexWGSL: ringVertexWGSL,
            fragmentWGSL: ringFragmentWGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                aUv0: SEMANTIC_TEXCOORD0
            }
        });
        this.ringMaterial.blendType = BLEND_NORMAL;
        this.ringMaterial.cull = CULLFACE_NONE;
        this.ringMaterial.depthTest = false;
        this.ringMaterial.depthWrite = false;
        this.ringMaterial.update();
        this.ring = new Entity('XrArPlacementRing', app);
        this.ring.addComponent('render', { type: 'plane', castShadows: false, receiveShadows: false });
        this.ring.render.material = this.ringMaterial;
        for (const meshInstance of this.ring.render.meshInstances) meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
        this.ring.setLocalScale(RING_SIZE, 1, RING_SIZE);
        this.ring.enabled = false;
        app.root.addChild(this.ring);

        // the pointing ray, painted over the scene like the ring
        this.rayMaterial = new StandardMaterial();
        this.rayMaterial.useLighting = false;
        this.rayMaterial.useSkybox = false;
        this.rayMaterial.useFog = false;
        this.rayMaterial.useTonemap = false;
        this.rayMaterial.diffuse.set(0, 0, 0);
        this.rayMaterial.emissive.set(0.95, 0.95, 0.95);
        this.rayMaterial.opacity = RAY_OPACITY;
        this.rayMaterial.blendType = BLEND_NORMAL;
        this.rayMaterial.depthTest = false;
        this.rayMaterial.depthWrite = false;
        this.rayMaterial.update();
        this.ray = new Entity('XrArPlacementRay', app);
        this.ray.addComponent('render', { type: 'cylinder', castShadows: false, receiveShadows: false });
        this.ray.render.material = this.rayMaterial;
        for (const meshInstance of this.ray.render.meshInstances) meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
        this.ray.enabled = false;
        app.root.addChild(this.ray);

        this.fadeMaterial = new ShaderMaterial({
            uniqueName: 'sse-xr-ar-placement-fade',
            vertexGLSL: fadeVertexGLSL,
            fragmentGLSL: fadeFragmentGLSL,
            vertexWGSL: fadeVertexWGSL,
            fragmentWGSL: fadeFragmentWGSL,
            attributes: { vertex_position: SEMANTIC_POSITION }
        });
        this.fadeMaterial.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD,
            BLENDMODE_ZERO,
            BLENDMODE_SRC_ALPHA,
            BLENDEQUATION_ADD,
            BLENDMODE_ZERO,
            BLENDMODE_SRC_ALPHA
        );
        this.fadeMaterial.cull = CULLFACE_NONE;
        this.fadeMaterial.depthTest = false;
        this.fadeMaterial.depthWrite = false;
        this.fadeMaterial.update();
        this.fade = new Entity('XrArPlacementFade', app);
        this.fade.addComponent('render', { type: 'plane', castShadows: false, receiveShadows: false });
        this.fade.render.material = this.fadeMaterial;
        for (const meshInstance of this.fade.render.meshInstances) {
            meshInstance.drawBucket = FADE_DRAW_BUCKET;
            // it covers the view wherever the camera looks
            meshInstance.cull = false;
        }
        this.fade.enabled = false;
        app.root.addChild(this.fade);

        this.hintHolder = new Entity('XrArPlacementHint', app);
        app.root.addChild(this.hintHolder);
        this.hint = createQuad(app, this.hintHolder, HINT_WIDTH, HINT_HEIGHT, HINT_PIXELS);

        // A held select aims with its pointer, and letting go places where the ring is. On a phone,
        // a touch does the same where the finger touches, and a second finger pinches and twists
        // instead, scaling and turning the splat about its base until one of them lifts
        const onSelectStart = (source: XrInputSource) => {
            if (!this.active || this.claimed(source)) return;
            const pointer = this.pointers.get(source);
            if (pointer) {
                this.aiming = pointer;
                this.ringFound = false;
                return;
            }
            if (source.targetRayMode !== 'screen') return;
            this.held.add(source);
            if (this.held.size === 1) {
                this.placingTouch = source;
                this.ringFound = false;
            } else if (this.held.size === 2 && !this.pinch) {
                this.placingTouch = null;
                const [a, b] = this.held;
                this.startPinch(a, b);
            }
        };
        const onSelectEnd = (source: XrInputSource) => {
            if (!this.active) return;
            const pointer = this.pointers.get(source);
            if (pointer) {
                if (pointer !== this.aiming) return;
                this.aiming = null;
                if (this.ring.enabled) this.placeAt(this.ringAt);
                this.ring.enabled = false;
                this.ray.enabled = false;
                return;
            }
            this.releaseTouch(source, true);
        };
        const onAdd = (source: XrInputSource) => {
            if (this.active) this.addPointer(source);
        };
        const onRemove = (source: XrInputSource) => {
            this.removePointer(source);
            this.releaseTouch(source, false);
        };
        const { input } = app.xr;
        input.on('selectstart', onSelectStart);
        input.on('selectend', onSelectEnd);
        input.on('add', onAdd);
        input.on('remove', onRemove);
        this.handles = [
            app.on('update', (dt: number) => this.update(dt)),
            app.xr.on('update', (frame: RayFrame) => this.readPointers(frame)),
            {
                off: () => {
                    input.off('selectstart', onSelectStart);
                    input.off('selectend', onSelectEnd);
                    input.off('add', onAdd);
                    input.off('remove', onRemove);
                }
            }
        ];
    }

    /**
     * Starts an AR session's placing, the splat standing where the session put it, faint, until it
     * is first placed. Again (the menu's reset), it is faint again. A session without a hit test
     * leaves it solid where it is.
     */
    start() {
        const { hitTest } = this.app.xr;
        if (this.released || !hitTest.supported) return;
        this.placed = false;
        this.gliding = false;
        this.aiming = null;
        this.setFade(PREVIEW_ALPHA);
        if (this.active) return;
        this.active = true;
        for (const source of this.app.xr.input.inputSources) this.addPointer(source);
        this.requestTouches([XRTRACKABLE_PLANE, XRTRACKABLE_MESH]);
    }

    /** Ends placing as the session ends, leaving the splat where it stands, solid. */
    stop() {
        this.active = false;
        this.aiming = null;
        this.gliding = false;
        this.ring.enabled = false;
        this.ray.enabled = false;
        this.hint.entity.enabled = false;
        this.fade.enabled = false;
        this.source?.remove();
        this.source = null;
        this.touches.clear();
        this.held.clear();
        this.placingTouch = null;
        this.pinch = null;
        for (const source of [...this.pointers.keys()]) this.removePointer(source);
    }

    destroy() {
        this.released = true;
        this.stop();
        for (const handle of this.handles) handle.off();
        this.ring.destroy();
        this.ringMaterial.destroy();
        this.ray.destroy();
        this.rayMaterial.destroy();
        this.fade.destroy();
        this.fadeMaterial.destroy();
        this.hintHolder.destroy();
        this.hint.material.destroy();
        this.hint.texture.destroy();
    }

    private setFade(value: number) {
        this.fadeMaterial.setParameter('uFade', value);
        this.fade.enabled = true;
    }

    // glides the splat's base to a point, solid from now on
    private placeAt(target: Vec3) {
        this.grab.basePoint(this.baseAt);
        this.goal.copy(target);
        this.gliding = true;
        this.placed = true;
        this.fade.enabled = false;
        this.hint.entity.enabled = false;
    }

    // starts a hand's or controller's hit test from its own ray, against planes alone where the
    // room's mesh is not offered
    private addPointer(source: XrInputSource) {
        if (source.targetRayMode !== 'tracked-pointer' || this.pointers.has(source)) return;
        const space = (source.inputSource as unknown as { targetRaySpace: unknown }).targetRaySpace;
        const pointer: Pointer = {
            space,
            test: null,
            origin: new Vec3(),
            direction: new Vec3(),
            posed: false,
            hit: new Vec3(),
            age: Infinity,
            cancelled: false
        };
        this.pointers.set(source, pointer);
        const session = this.app.xr.session as unknown as RaySession | null;
        const request = session?.requestHitTestSource?.bind(session);
        if (!request) return;
        request({ space, entityTypes: [XRTRACKABLE_PLANE, XRTRACKABLE_MESH] })
            .catch(() => request({ space, entityTypes: [XRTRACKABLE_PLANE] }))
            .then((test: RayHitTest) => {
                if (pointer.cancelled) test.cancel();
                else pointer.test = test;
            })
            .catch(() => {
                // this pointer has no hit test; the others, or the view's, place
            });
    }

    private removePointer(source: XrInputSource) {
        const pointer = this.pointers.get(source);
        if (!pointer) return;
        pointer.cancelled = true;
        pointer.test?.cancel();
        this.pointers.delete(source);
    }

    // each pointer's ray and nearest level hit this frame, in the session's space
    private readPointers(frame: RayFrame) {
        if (!this.active) return;
        const space = (this.app.xr as unknown as { _referenceSpace: unknown })._referenceSpace;
        for (const pointer of this.pointers.values()) {
            const ray = frame.getPose(pointer.space, space);
            pointer.posed = !!ray;
            if (ray) {
                const { position: p, orientation: o } = ray.transform;
                pointer.origin.set(p.x, p.y, p.z);
                turn.set(o.x, o.y, o.z, o.w).transformVector(Vec3.FORWARD, pointer.direction);
            }
            if (!pointer.test) continue;
            const results = frame.getHitTestResults(pointer.test);
            for (const result of results) {
                const pose = result.getPose(space);
                if (!pose) continue;
                const { position: p, orientation: o } = pose.transform;
                turn.set(o.x, o.y, o.z, o.w).transformVector(Vec3.UP, up);
                if (up.y >= LEVEL) {
                    pointer.hit.set(p.x, p.y, p.z);
                    pointer.age = 0;
                }
                break;
            }
        }
    }

    // asks for a hit test from where the screen is touched, against planes alone where the room's
    // mesh is not offered
    private requestTouches(entityTypes: string[]) {
        this.app.xr.hitTest.start({
            profile: 'generic-touchscreen',
            entityTypes,
            callback: (error: Error | null, source: XrHitTestSource | null) => {
                if (error || !source) {
                    if (entityTypes.length > 1 && this.active) this.requestTouches([XRTRACKABLE_PLANE]);
                    return;
                }
                if (!this.active || this.released) {
                    source.remove();
                    return;
                }
                this.source = source;
                source.on('result', (position: Vec3, rotation: Quat, touch: XrInputSource) => {
                    rotation.transformVector(Vec3.UP, up);
                    if (up.y < LEVEL || !touch) return;
                    let hit = this.touches.get(touch);
                    if (!hit) {
                        hit = { hit: new Vec3(), age: Infinity };
                        this.touches.set(touch, hit);
                    }
                    hit.hit.copy(position);
                    hit.age = 0;
                });
            }
        });
    }

    // a touch lifting: the one placing places where the ring is (when it lifts, not when its input
    // goes), and one of a pinch ends it
    private releaseTouch(source: XrInputSource, lifted: boolean) {
        if (!this.held.delete(source)) {
            this.touches.delete(source);
            return;
        }
        this.touches.delete(source);
        if (this.pinch) {
            if (this.pinch.includes(source)) this.pinch = null;
            return;
        }
        if (source === this.placingTouch) {
            this.placingTouch = null;
            if (lifted && this.ring.enabled) this.placeAt(this.ringAt);
            this.ring.enabled = false;
        }
    }

    // where a touch is on the screen, as its ray's direction from the eyes, in tangents
    private screenOf(source: XrInputSource, out: Vec3) {
        turn.copy(this.camera.getRotation()).invert().transformVector(source.getDirection(), out);
        const depth = -out.z || 1e-6;
        return out.set(out.x / depth, out.y / depth, 0);
    }

    private startPinch(a: XrInputSource, b: XrInputSource) {
        this.pinch = [a, b];
        this.screenOf(a, rayStart);
        this.screenOf(b, rayEnd);
        aimed.sub2(rayEnd, rayStart);
        this.pinchSpread = Math.max(aimed.length(), 1e-6);
        this.pinchHeading = Math.atan2(aimed.y, aimed.x);
        this.gliding = false;
        this.ring.enabled = false;
        this.grab.startAdjust();
    }

    // the pinch's spread scales the splat, and its twist turns it, as seen from above
    private updatePinch() {
        if (!this.pinch) return;
        const [a, b] = this.pinch;
        this.screenOf(a, rayStart);
        this.screenOf(b, rayEnd);
        aimed.sub2(rayEnd, rayStart);
        const spread = aimed.length() / this.pinchSpread;
        const heading = Math.atan2(aimed.y, aimed.x);
        let yaw = (heading - this.pinchHeading) % (Math.PI * 2);
        if (yaw > Math.PI) yaw -= Math.PI * 2;
        else if (yaw <= -Math.PI) yaw += Math.PI * 2;
        this.grab.adjust(spread, yaw);
    }

    private update(dt: number) {
        if (!this.active) return;
        for (const pointer of this.pointers.values()) pointer.age += dt;
        for (const touch of this.touches.values()) touch.age += dt;

        // the ring: where the aiming pointer, or on a phone the placing touch, meets a surface,
        // held a moment between hits
        let target: Vec3 | null = null;
        const aiming = this.aiming;
        if (aiming) {
            if (aiming.posed && aiming.age < HOLD) target = aiming.hit;
        } else if (this.placingTouch) {
            const touch = this.touches.get(this.placingTouch);
            if (touch && touch.age < HOLD) target = touch.hit;
        }
        this.updatePinch();
        if (target) {
            this.rig.getWorldTransform().transformPoint(target, point);
            if (this.ringFound) {
                this.ringAt.lerp(this.ringAt, point, 1 - Math.exp(-SMOOTH * dt));
            } else {
                this.ringAt.copy(point);
                this.ringFound = true;
            }
            this.ring.setPosition(this.ringAt.x, this.ringAt.y + RING_LIFT, this.ringAt.z);
        }
        this.ring.enabled = !!target;
        this.placeRay();

        // the splat's base gliding to where it was placed
        if (this.gliding) {
            this.baseAt.lerp(this.baseAt, this.goal, 1 - Math.exp(-SMOOTH * dt));
            if (this.baseAt.distance(this.goal) < 1e-3) {
                this.baseAt.copy(this.goal);
                this.gliding = false;
            }
            this.grab.moveTo(this.baseAt);
        }

        if (this.placed) this.hint.entity.enabled = false;
        else this.placeHint();
    }

    // the ray from the aiming pointer, to the ring where it shows, else RAY_REACH along its aim
    private placeRay() {
        const pointer = this.aiming;
        if (!pointer?.posed) {
            this.ray.enabled = false;
            return;
        }
        const rig = this.rig.getWorldTransform();
        rig.transformPoint(pointer.origin, rayStart);
        if (this.ring.enabled) {
            rayEnd.copy(this.ringAt);
        } else {
            rig.transformVector(pointer.direction, aimed).normalize();
            rayEnd.copy(aimed).mulScalar(RAY_REACH).add(rayStart);
        }
        aimed.sub2(rayEnd, rayStart);
        const length = aimed.length();
        if (length < 1e-3) {
            this.ray.enabled = false;
            return;
        }
        aimed.mulScalar(1 / length);
        turn.setFromDirections(Vec3.UP, aimed);
        this.ray.setRotation(turn);
        this.ray.setPosition(point.add2(rayStart, rayEnd).mulScalar(0.5));
        this.ray.setLocalScale(RAY_WIDTH, length, RAY_WIDTH);
        this.ray.enabled = true;
    }

    // the hint above the ring, or in front of the eyes before there is one, facing them; on a phone,
    // which has no pointers, on the screen
    private placeHint() {
        const view = this.pointers.size === 0 ? this.camera.camera.camera.xrViews?.[0] : undefined;
        if (view) {
            this.placeHintOnScreen(view.projMat.data);
        } else {
            this.placeHintInWorld();
        }

        const text = this.hintText(this.pointers.size > 0);
        if (text !== this.hintDrawn) this.drawHint(text);
        this.hint.entity.enabled = true;
    }

    // low in the middle of the screen, a share of its width across: a point of the view's
    // projection at HINT_SCREEN_AHEAD, square to the camera
    private placeHintOnScreen(m: Float32Array) {
        const ahead = HINT_SCREEN_AHEAD;
        point.set((m[8] * ahead) / m[0], ((m[9] - HINT_SCREEN_LOW) * ahead) / m[5], -ahead);
        this.camera.getWorldTransform().transformPoint(point, point);
        this.hintHolder.setPosition(point);
        this.hintHolder.setRotation(this.camera.getRotation());
        const scale = ((2 * HINT_SCREEN_WIDTH * ahead) / m[0] / HINT_WIDTH) * this.camera.getScale().x;
        this.hintHolder.setLocalScale(scale, scale, scale);
    }

    private placeHintInWorld() {
        const eyes = this.camera.getPosition();
        if (this.ring.enabled) {
            point.set(this.ringAt.x, this.ringAt.y + HINT_RISE, this.ringAt.z);
        } else {
            const { forward } = this.camera;
            facing.set(forward.x, 0, forward.z).normalize();
            point.set(eyes.x + facing.x * HINT_AHEAD, eyes.y - HINT_DROP, eyes.z + facing.z * HINT_AHEAD);
        }
        this.hintHolder.setPosition(point);
        // its quad faces the holder's +z, so the holder looks away from the eyes
        facing.sub2(point, eyes).add(point);
        this.hintHolder.lookAt(facing.x, point.y, facing.z);
        this.hintHolder.setLocalScale(1, 1, 1);
    }

    private drawHint(text: string) {
        this.hintDrawn = text;
        const { canvas } = this.hint;
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(20, 22, 28, 0.86)';
        ctx.beginPath();
        ctx.roundRect(1, 1, width - 2, height - 2, height * 0.3);
        ctx.fill();
        const font = (size: number) => `500 ${size}px -apple-system, system-ui, sans-serif`;
        const size = Math.round(height * 0.42);
        ctx.font = font(size);
        const room = width - height;
        const measured = ctx.measureText(text).width;
        if (measured > room) ctx.font = font(Math.floor((size * room) / measured));
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, width / 2, height / 2);
        uploadQuad(this.hint);
    }
}

export { XrArPlacement };
