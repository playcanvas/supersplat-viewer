import { Mat4, Vec3, Vec4 } from 'playcanvas';
import type { AppBase, Entity } from 'playcanvas';

import { Picker, withoutXrViews } from './picker';

// Where a scene without collision can be stood on in XR, found from its splats: the surface the
// eyes see where the teleport aims. It is picked through the session's own camera, as the engine
// draws the splats for that camera alone (its gsplat mesh is visible to the camera it sorts for),
// in a PICK_SIZE square render of the camera's view. A surface whose normal is within STAND_SLOPE
// of straight up (the cosine, about 30 degrees) can be stood on; a wall, or a fit with too few
// samples, cannot. Picks run between frames, as the picker needs, PICK_INTERVAL apart while the
// teleport aims, and one taken within MATCH_DISTANCE of the aim across the floor stands for it.
// The start's floor is picked AHEAD in front of the user, at about STAND_HEIGHT below their eyes,
// and taken only within FLOOR_DROP below them, so stray splats under a scene are not a floor.
// The picks see the sorted renderer's splats only: the stochastic renderer draws the splats in the
// engine's place and leaves no depth for a stereo frame, so with it the floor stays where it is
const PICK_SIZE = 256;
const STAND_SLOPE = 0.87;
const PICK_INTERVAL = 150;
const MATCH_DISTANCE = 0.75;
const AHEAD = 1.5;
const STAND_HEIGHT = 1.6;
const FLOOR_DROP = 3;

const viewProjection = new Mat4();
const clip = new Vec4();
const ahead = new Vec3();

/** The splats' floor where the eyes see it, for the XR teleport in a scene without collision. */
class XrSplatFloor {
    private camera: Entity;

    private picker: Picker;

    // the latest aim, and whether a pick is waiting or under way
    private point = new Vec3();

    private aimed = false;

    private timer: ReturnType<typeof setTimeout> | null = null;

    private picking = false;

    private released = false;

    // the last pick's result: where it found a surface, and whether it can be stood on
    private found = new Vec3();

    private standable = false;

    /**
     * @param app - The application.
     * @param camera - The session's camera, the user's eyes.
     */
    constructor(app: AppBase, camera: Entity) {
        this.camera = camera;
        this.picker = new Picker(app, camera, { width: PICK_SIZE, height: PICK_SIZE });
    }

    /**
     * Aims the next pick where the teleport would land.
     *
     * @param point - Where the teleport would land.
     */
    aim(point: Vec3) {
        this.point.copy(point);
        this.aimed = true;
        if (!this.timer && !this.picking && !this.released) {
            this.timer = setTimeout(() => this.pick(), PICK_INTERVAL);
        }
    }

    /**
     * The floor the last pick found near a point across the floor: its height, or null where it
     * found none to stand on, or picked too far away.
     *
     * @param point - Where the teleport would land.
     * @returns The floor's height, or null.
     */
    floorNear(point: Vec3) {
        if (!this.standable) return null;
        const dx = this.found.x - point.x;
        const dz = this.found.z - point.z;
        return dx * dx + dz * dz < MATCH_DISTANCE * MATCH_DISTANCE ? this.found.y : null;
    }

    /**
     * Picks the floor in front of the user at once, between frames, as a session starts.
     *
     * @returns The floor's height, or null where it found none to stand on.
     */
    async floorAhead() {
        const eyes = this.camera.getPosition();
        const { forward } = this.camera;
        const across = Math.hypot(forward.x, forward.z) || 1;
        ahead.set(eyes.x + (forward.x / across) * AHEAD, eyes.y - STAND_HEIGHT, eyes.z + (forward.z / across) * AHEAD);
        if (!(await this.pickAt(ahead))) return null;
        const drop = eyes.y - this.found.y;
        return drop >= 0 && drop <= FLOOR_DROP ? this.found.y : null;
    }

    destroy() {
        this.released = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.picker.release();
    }

    private async pick() {
        this.timer = null;
        if (!this.aimed || this.released) return;
        this.aimed = false;
        await this.pickAt(this.point);
    }

    // picks the surface the camera sees in the direction of a point, keeping what it found
    private async pickAt(point: Vec3) {
        // into the camera's own single view, which the pick renders (withoutXrViews)
        const cam = this.camera.camera;
        withoutXrViews(this.camera, () => viewProjection.mul2(cam.projectionMatrix, cam.viewMatrix));
        clip.set(point.x, point.y, point.z, 1);
        viewProjection.transformVec4(clip, clip);
        // a point out of view has no floor to pick; otherwise the last result stands until this
        // pick's arrives
        const x = clip.x / clip.w;
        const y = clip.y / clip.w;
        if (clip.w <= 1e-6 || Math.abs(x) > 1 || Math.abs(y) > 1) {
            this.standable = false;
            return false;
        }
        this.picking = true;
        try {
            const surface = await this.picker.pickSurface((x + 1) / 2, (1 - y) / 2);
            if (this.released) return false;
            this.standable = !!surface && surface.fitted && surface.normal.y > STAND_SLOPE;
            if (surface) this.found.copy(surface.position);
            return this.standable;
        } finally {
            this.picking = false;
        }
    }
}

export { XrSplatFloor };
