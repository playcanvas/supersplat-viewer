import { BoundingBox, Mat4, math, Quat, Vec3 } from 'playcanvas';
import type { AppBase, Entity, XrInputSource } from 'playcanvas';

// An object is brought to the user as the session starts: standing PLACE_HEIGHT above their floor
// (about a table's), its near side PLACE_GAP in front of them, at real size up to PLACE_SIZE across
// and fitted to it beyond, and turned as it was, so they see the side the orbit camera showed. A
// scene held as one (an AR diorama) is shrunk by DIORAMA_SCALE instead, its bounds reaching its
// stray splats, and pinned at the start camera's spot on its floor, DIORAMA_REACH in front of them
const PLACE_HEIGHT = 0.8;
const PLACE_GAP = 0.35;
const PLACE_SIZE = 0.8;
const DIORAMA_SCALE = 1 / 40;
const DIORAMA_REACH = 0.6;

// Changes in the hands' separation within SPREAD_DEAD_ZONE of the grab's do not scale (as the
// two-hand grab's elsewhere), and the object stays from MIN_SCALE to MAX_SCALE of its placed size
const SPREAD_DEAD_ZONE = 0.15;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
// below these the hands' separation, and its length across the floor, give no spread or heading
const EPS_SEPARATION = 1e-3;
const EPS_XZ = 1e-4;

const left = new Vec3();
const right = new Vec3();
const mid = new Vec3();
const delta = new Vec3();
const base = new Vec3();
const offset = new Vec3();
const point = new Vec3();
const turn = new Quat();
const bound = new BoundingBox();
const inverse = new Mat4();

const wrapPi = (angle: number) => {
    angle %= Math.PI * 2;
    if (angle > Math.PI) return angle - Math.PI * 2;
    if (angle <= -Math.PI) return angle + Math.PI * 2;
    return angle;
};

const usable = (source: XrInputSource) => source.grip || !!(source.hand?.tracking && source.hand.wrist);

// a hand's position in the world: its grip's, or a tracked hand's wrist
const handPosition = (source: XrInputSource, out: Vec3) =>
    out.copy(source.grip ? source.getPosition() : source.hand.wrist.getPosition());

/**
 * Holds an object in XR, or a scene as a diorama in AR, where the user manipulates it rather than
 * themselves. As the session starts it is placed in front of them at table height
 * ({@link XrObjectGrab#place}), and grabbing it with both hands (both grips, or two fists) moves it
 * about its base, the point the placement stood on the table: moving the hands together drags it,
 * lifting included, swinging them turns it about the vertical through its base, and spreading them
 * grows it there, so it stays standing where it is. Grabs only while {@link XrObjectGrab#enabled},
 * and waits while `xr:menu:active` is set, as the engine's XrManipulation does.
 */
class XrObjectGrab {
    /** Whether the user handles the splat this session (an object, or any splat in AR). */
    enabled = false;

    private app: AppBase;

    private entity: Entity;

    private rig: Entity;

    private scene: boolean;

    // the base the placement stands on the table, in the splat's own space
    private pinLocal = new Vec3();

    // the authored transform, which the session's end puts back, as the viewer's camera, collision
    // and annotations assume it
    private homePosition = new Vec3();

    private homeRotation = new Quat();

    private homeScale = new Vec3();

    // the scale the placement gave it, which the grab's bounds are relative to
    private placedScale = 1;

    private paused = false;

    private first: XrInputSource | null = null;

    private second: XrInputSource | null = null;

    // the grab's start: the hands' midpoint, separation and heading across the floor (null when
    // degenerate), the object's base and transform, and the rig's, to notice a turn mid-grab
    private grabMid = new Vec3();

    private grabDistance = 0;

    private grabHeading: number | null = null;

    private grabBase = new Vec3();

    private grabPosition = new Vec3();

    private grabRotation = new Quat();

    private grabScale = new Vec3();

    private grabRigPosition = new Vec3();

    private grabRigRotation = new Quat();

    // the turn as last applied, held while the heading is degenerate
    private yaw = 0;

    private updating: { off(): void };

    private menuActive: { off(): void };

    /**
     * @param app - The application.
     * @param entity - The splat's entity, a child of the root.
     * @param rig - The camera's parent, where the user stands.
     * @param scene - Whether it is a scene, held as a diorama, or an object.
     */
    constructor(app: AppBase, entity: Entity, rig: Entity, scene: boolean) {
        this.app = app;
        this.entity = entity;
        this.rig = rig;
        this.scene = scene;
        this.homePosition.copy(entity.getPosition());
        this.homeRotation.copy(entity.getRotation());
        this.homeScale.copy(entity.getLocalScale());
        this.updating = app.on('update', () => this.update());
        this.menuActive = app.on('xr:menu:active', (active: boolean) => {
            this.paused = !!active;
        });
    }

    /** Places the object in front of the rig, facing where it faces, from its authored transform. */
    place() {
        this.end();
        this.restoreHome();
        const { entity, rig } = this;
        const rigPosition = rig.getPosition();
        let scale: number;
        let reach: number;
        if (this.scene) {
            base.copy(rigPosition);
            scale = DIORAMA_SCALE;
            reach = DIORAMA_REACH;
        } else {
            this.worldBound();
            const { center, halfExtents: h } = bound;
            base.set(center.x, center.y - h.y, center.z);
            scale = Math.min(1, PLACE_SIZE / (2 * Math.max(h.x, h.y, h.z, 1e-6)));
            reach = PLACE_GAP + Math.max(h.x, h.z) * scale;
        }
        inverse.copy(entity.getWorldTransform()).invert();
        inverse.transformPoint(base, this.pinLocal);
        const { forward } = rig;
        delta.set(forward.x, 0, forward.z);
        if (delta.lengthSq() < 1e-8) delta.set(0, 0, -1);
        delta.normalize();
        // the base's new place, and the splat about it, scaled
        mid.set(rigPosition.x + delta.x * reach, rigPosition.y + PLACE_HEIGHT, rigPosition.z + delta.z * reach);
        offset.sub2(entity.getPosition(), base).mulScalar(scale);
        entity.setPosition(mid.add(offset));
        entity.setLocalScale(this.homeScale.x * scale, this.homeScale.y * scale, this.homeScale.z * scale);
        this.placedScale = scale;
    }

    /**
     * Moves the placed splat so its base stands at a point (an AR surface), keeping its size and turn.
     *
     * @param point - Where its base goes, in the world.
     */
    moveTo(point: Vec3) {
        this.end();
        this.basePoint(base);
        offset.sub2(point, base).add(this.entity.getPosition());
        this.entity.setPosition(offset);
    }

    /** Puts the object back where it was authored, ending a grab. */
    restore() {
        this.end();
        this.restoreHome();
        this.placedScale = 1;
    }

    destroy() {
        this.updating.off();
        this.menuActive.off();
        this.end();
    }

    private restoreHome() {
        this.entity.setPosition(this.homePosition);
        this.entity.setRotation(this.homeRotation);
        this.entity.setLocalScale(this.homeScale);
    }

    /**
     * Where the splat's base is in the world, as it stands now.
     *
     * @param out - Receives the base.
     * @returns `out`.
     */
    basePoint(out: Vec3) {
        return this.entity.getWorldTransform().transformPoint(this.pinLocal, out);
    }

    // the object's bounds in the world, as it stands now, into bound
    private worldBound() {
        const aabb = (this.entity.gsplat?.resource as { aabb?: BoundingBox } | null)?.aabb;
        if (aabb) {
            bound.setFromTransformedAabb(aabb, this.entity.getWorldTransform());
        } else {
            bound.center.copy(this.entity.getPosition());
            bound.halfExtents.set(0, 0, 0);
        }
    }

    private end() {
        this.first = null;
        this.second = null;
    }

    private begin() {
        handPosition(this.first, left);
        handPosition(this.second, right);
        this.grabMid.add2(left, right).mulScalar(0.5);
        delta.sub2(right, left);
        this.grabDistance = delta.length();
        this.grabHeading = Math.hypot(delta.x, delta.z) > EPS_XZ ? Math.atan2(delta.x, delta.z) : null;
        this.basePoint(this.grabBase);
        this.grabPosition.copy(this.entity.getPosition());
        this.grabRotation.copy(this.entity.getRotation());
        this.grabScale.copy(this.entity.getLocalScale());
        this.grabRigPosition.copy(this.rig.getPosition());
        this.grabRigRotation.copy(this.rig.getRotation());
        this.yaw = 0;
    }

    private update() {
        const { xr } = this.app;
        if (!xr?.active || this.paused || !this.enabled) {
            this.end();
            return;
        }
        const sources = xr.input.inputSources;
        const holding = (source: XrInputSource) => sources.includes(source) && source.squeezing && usable(source);
        if (this.first && !(holding(this.first) && holding(this.second))) this.end();

        if (!this.first) {
            let leftHand: XrInputSource | null = null;
            let rightHand: XrInputSource | null = null;
            let any: XrInputSource | null = null;
            let other: XrInputSource | null = null;
            for (const source of sources) {
                if (!source.squeezing || !usable(source)) continue;
                if (source.handedness === 'left' && !leftHand) leftHand = source;
                else if (source.handedness === 'right' && !rightHand) rightHand = source;
                if (!any) any = source;
                else if (!other) other = source;
            }
            // a pair of 'none' handedness, which some devices report, falls back to the first two
            [this.first, this.second] = leftHand && rightHand ? [leftHand, rightHand] : [any, other];
            if (this.first && this.second) this.begin();
            else this.end();
            return;
        }

        // turned or moved by something else (a snap turn): carry on from where everything is now
        const { rig } = this;
        if (!rig.getPosition().equals(this.grabRigPosition) || !rig.getRotation().equals(this.grabRigRotation)) {
            this.begin();
            return;
        }

        handPosition(this.first, left);
        handPosition(this.second, right);
        mid.add2(left, right).mulScalar(0.5);
        delta.sub2(right, left);
        const separation = delta.length();
        if (Math.hypot(delta.x, delta.z) > EPS_XZ && this.grabHeading !== null) {
            this.yaw = wrapPi(Math.atan2(delta.x, delta.z) - this.grabHeading);
        }

        // spreading the hands grows it past the dead zone, within its bounds about the placed size
        const spread =
            separation > EPS_SEPARATION && this.grabDistance > EPS_SEPARATION ? separation / this.grabDistance : 1;

        // the base follows the hands' midpoint; the object turns and scales about it
        base.sub2(mid, this.grabMid).add(this.grabBase);
        this.apply(this.ratioOf(spread), this.yaw, base);
    }

    /**
     * Starts scaling and turning the splat about its base by other means than the hands (a
     * phone's two fingers), from where it stands now; ends a grab.
     */
    startAdjust() {
        this.end();
        this.basePoint(this.grabBase);
        this.grabPosition.copy(this.entity.getPosition());
        this.grabRotation.copy(this.entity.getRotation());
        this.grabScale.copy(this.entity.getLocalScale());
    }

    /**
     * Scales and turns the splat about its base, against where it stood at
     * {@link XrObjectGrab#startAdjust}, as the hands' grab does.
     *
     * @param spread - How far apart the fingers are against their start, which scales it past the
     * grab's dead zone and within its bounds.
     * @param yaw - The turn about the vertical, in radians.
     */
    adjust(spread: number, yaw: number) {
        this.apply(this.ratioOf(spread), yaw, this.grabBase);
    }

    // the scale against the grab's start for a spread of the hands, past the dead zone and within
    // its bounds about the placed size
    private ratioOf(spread: number) {
        const ratio =
            spread > 1 + SPREAD_DEAD_ZONE
                ? spread / (1 + SPREAD_DEAD_ZONE)
                : spread < 1 - SPREAD_DEAD_ZONE
                  ? spread / (1 - SPREAD_DEAD_ZONE)
                  : 1;
        const homeScale = this.homeScale.x || 1;
        const total = math.clamp(
            (this.grabScale.x * ratio) / homeScale,
            this.placedScale * MIN_SCALE,
            this.placedScale * MAX_SCALE
        );
        return (total * homeScale) / this.grabScale.x;
    }

    // the splat as it stood at the grab's start, scaled by ratio and turned by yaw about its base,
    // which stands at baseAt
    private apply(ratio: number, yaw: number, baseAt: Vec3) {
        turn.setFromAxisAngle(Vec3.UP, yaw * math.RAD_TO_DEG);
        offset.sub2(this.grabPosition, this.grabBase);
        turn.transformVector(offset, offset).mulScalar(ratio);
        const { entity } = this;
        entity.setPosition(point.add2(baseAt, offset));
        entity.setRotation(turn.mul(this.grabRotation));
        entity.setLocalScale(this.grabScale.x * ratio, this.grabScale.y * ratio, this.grabScale.z * ratio);
    }
}

export { XrObjectGrab };
