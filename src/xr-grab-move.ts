import { math, Mat4, Vec3 } from 'playcanvas';
import type { AppBase, Entity, XrInputSource } from 'playcanvas';

// Below these the hand pair's separation, and its length across the floor (the hands stacked
// vertically), give no spread or heading, which are then held
const EPS_SEPARATION = 1e-3;
const EPS_XZ = 1e-4;

// Changes in the hands' height within HEIGHT_DEAD_ZONE of the grab's (meters), and in their
// separation within SPREAD_DEAD_ZONE of its share (as the engine's XrManipulation), do not scale,
// so the hands drifting while they drag does not, and scaling starts from the bands' edges. Heights
// below MIN_HEIGHT count as it, as the scale divides by them
const HEIGHT_DEAD_ZONE = 0.05;
const SPREAD_DEAD_ZONE = 0.15;
const MIN_HEIGHT = 0.1;

// how small and large the scene can look, which the user's scale is the inverse of
const MIN_SCENE_SCALE = 0.25;
const MAX_SCENE_SCALE = 4;

const left = new Vec3();
const right = new Vec3();
const mid = new Vec3();
const delta = new Vec3();
const grabbed = new Vec3();
const position = new Vec3();
const rigInverse = new Mat4();

// v rotated about the world's Y axis by angle, in place, as an entity yawed by angle rotates it
const rotateY = (v: Vec3, angle: number) => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const x = v.x * c + v.z * s;
    v.z = -v.x * s + v.z * c;
    v.x = x;
    return v;
};

const wrapPi = (angle: number) => {
    angle %= Math.PI * 2;
    if (angle > Math.PI) return angle - Math.PI * 2;
    if (angle <= -Math.PI) return angle + Math.PI * 2;
    return angle;
};

const yawOf = (entity: Entity) => {
    const { forward } = entity;
    return Math.atan2(-forward.x, -forward.z);
};

const usable = (source: XrInputSource) => source.grip || !!(source.hand?.tracking && source.hand.wrist);

/**
 * Grabbing a scene with both hands (squeezing both controllers' grips, or two fists) moves the user
 * through it rather than moving it, so it stays on its collision. The point between the hands stays
 * in them while the user's feet stay on the floor: dragging moves the user across the floor and
 * swinging the hands turns them. Raising the hands lifts the scene with them, which with the floor
 * underfoot grows it around the user, shrinking them, and spreading the hands grows it too, as the
 * engine's XrManipulation scales objects (lowering or closing the hands grows the user).
 */
class XrGrabMove {
    /** The user's scale, the rig's, relative to real size. */
    scale = 1;

    private app: AppBase;

    private rig: Entity;

    private onScale: (scale: number) => void;

    private first: XrInputSource | null = null;

    private second: XrInputSource | null = null;

    // the grab's start, or the last rebase: the rig's transform, and in its space the hands'
    // midpoint, whose height is above the floor, their heading across it (null when degenerate) and
    // their separation
    private rigPosition = new Vec3();

    private rigYaw = 0;

    private rigScale = 1;

    private grabMid = new Vec3();

    private grabHeading: number | null = null;

    private grabDistance = 0;

    // the rig's transform as last set, to notice a teleport or turn during the grab
    private setPosition = new Vec3();

    private setYaw = 0;

    private updating: { off(): void } | null;

    /**
     * @param app - The application.
     * @param rig - The camera's parent, which the session's poses are relative to.
     * @param onScale - Called when the user's scale changes.
     */
    constructor(app: AppBase, rig: Entity, onScale: (scale: number) => void) {
        this.app = app;
        this.rig = rig;
        this.onScale = onScale;
        // as each frame's poses arrive, before the scripts update: the engine's XrControllers
        // poses the hand and controller models in the world in its update, from the rig as it is
        // then, so moving the rig after it would leave them a frame behind the eyes
        this.updating = app.xr?.on('update', () => this.update()) ?? null;
    }

    /** Ends the grab, if any. */
    end() {
        this.first = null;
        this.second = null;
    }

    /** Ends the grab, if any, and puts the user back to real size. */
    reset() {
        this.end();
        if (this.scale !== 1) {
            this.rig.setLocalScale(1, 1, 1);
            this.scale = 1;
            this.onScale(1);
        }
    }

    destroy() {
        this.updating?.off();
        this.end();
    }

    // a hand's position in the rig's space: the grip's pose is already, a tracked hand's wrist is in
    // the world
    private handPosition(source: XrInputSource, out: Vec3) {
        if (source.grip) return out.copy(source.getLocalPosition());
        return rigInverse.transformPoint(source.hand.wrist.getPosition(), out);
    }

    private rebase() {
        const { rig } = this;
        this.rigPosition.copy(rig.getPosition());
        this.rigYaw = yawOf(rig);
        this.rigScale = this.scale;
        this.setPosition.copy(this.rigPosition);
        this.setYaw = this.rigYaw;

        this.grabMid.add2(left, right).mulScalar(0.5);
        delta.sub2(right, left);
        this.grabDistance = delta.length();
        this.grabHeading = Math.hypot(delta.x, delta.z) > EPS_XZ ? Math.atan2(delta.x, delta.z) : null;
    }

    private update() {
        const { xr } = this.app;
        if (!xr?.active) {
            this.end();
            return;
        }
        const sources = xr.input.inputSources;
        const holding = (source: XrInputSource) => sources.includes(source) && source.squeezing;
        if (this.first && !(holding(this.first) && holding(this.second))) {
            this.end();
        }

        rigInverse.copy(this.rig.getWorldTransform()).invert();

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
            if (this.first && this.second) {
                this.handPosition(this.first, left);
                this.handPosition(this.second, right);
                this.rebase();
            } else {
                this.end();
            }
            return;
        }

        this.handPosition(this.first, left);
        this.handPosition(this.second, right);

        // moved by something else (a teleport, a turn): carry on from where the rig is now
        const { rig } = this;
        if (!rig.getPosition().equals(this.setPosition) || yawOf(rig) !== this.setYaw) {
            this.rebase();
        }

        mid.add2(left, right).mulScalar(0.5);
        delta.sub2(right, left);
        const separation = delta.length();
        const heading = Math.hypot(delta.x, delta.z) > EPS_XZ ? Math.atan2(delta.x, delta.z) : null;

        // Turning the hands turns the scene with them, so the rig the other way. A held turn or
        // scale (a degenerate heading, or the scale at its limit) rebases the grab on what was
        // applied, so the hands take over again at once
        let held = false;
        let yaw = this.rigYaw;
        if (heading !== null && this.grabHeading !== null) {
            yaw -= wrapPi(heading - this.grabHeading);
        } else {
            held = true;
        }
        // Raising the hands keeps the grabbed point's height above the floor in them (the scale
        // times the height stays), and spreading them grows the scene by the spread
        const rise = mid.y - this.grabMid.y;
        const lift = Math.sign(rise) * Math.max(Math.abs(rise) - HEIGHT_DEAD_ZONE, 0);
        const height = Math.max(this.grabMid.y, MIN_HEIGHT);
        let spread = 1;
        if (separation > EPS_SEPARATION && this.grabDistance > EPS_SEPARATION) {
            spread = separation / this.grabDistance;
            if (spread > 1 + SPREAD_DEAD_ZONE) spread /= 1 + SPREAD_DEAD_ZONE;
            else if (spread < 1 - SPREAD_DEAD_ZONE) spread /= 1 - SPREAD_DEAD_ZONE;
            else spread = 1;
        } else {
            held = true;
        }
        const wanted = (this.rigScale * height) / (Math.max(height + lift, MIN_HEIGHT) * spread);
        const scale = math.clamp(wanted, 1 / MAX_SCENE_SCALE, 1 / MIN_SCENE_SCALE);
        held ||= scale !== wanted;

        // the world point between the hands at the grab's start stays between them across the
        // floor, and the rig, which stands on the floor, keeps its height
        grabbed.copy(this.grabMid);
        rotateY(grabbed, this.rigYaw).mulScalar(this.rigScale).add(this.rigPosition);
        position.copy(mid);
        rotateY(position, yaw).mulScalar(scale);
        position.sub2(grabbed, position);
        position.y = this.rigPosition.y;

        rig.setPosition(position);
        rig.setEulerAngles(0, yaw * math.RAD_TO_DEG, 0);
        rig.setLocalScale(scale, scale, scale);
        // read back, as the world transform rounds them to single precision
        this.setPosition.copy(rig.getPosition());
        this.setYaw = yawOf(rig);
        if (scale !== this.scale) {
            this.scale = scale;
            this.onScale(scale);
        }

        // the hands' rig-space positions are the same in the moved rig
        if (held) this.rebase();
    }
}

export { XrGrabMove };
