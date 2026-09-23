import { math, Vec3, Quat } from 'playcanvas';
import type { InputFrame } from 'playcanvas';

import { mod, vecToAngles } from '../core/math';

type CameraFrame = InputFrame<{
    move: [number, number, number];
    rotate: [number, number, number];
}>;

const rotation = new Quat();
const avec = new Vec3();
const bvec = new Vec3();

class Camera {
    position = new Vec3();

    angles = new Vec3();

    distance = 1;

    fov = 65;

    constructor(other?: Camera) {
        if (other) {
            this.copy(other);
        }
    }

    copy(source: Camera) {
        this.position.copy(source.position);
        this.angles.copy(source.angles);
        this.distance = source.distance;
        this.fov = source.fov;
    }

    lerp(a: Camera, b: Camera, t: number) {
        a.calcFocusPoint(avec);
        b.calcFocusPoint(bvec);

        this.position.lerp(a.position, b.position, t);
        avec.lerp(avec, bvec, t).sub(this.position);

        this.distance = avec.length();

        vecToAngles(this.angles, avec.mulScalar(1.0 / this.distance));

        this.fov = math.lerp(a.fov, b.fov, t);
    }

    // Blend position, view angles and distance directly, rather than through the look-at
    // point as `lerp` does: the view then turns steadily across the move, the heading the
    // shorter way round, and with the horizon kept level. `turn` is the angles' own progress,
    // so the view can turn ahead of the travel.
    lerpAngles(a: Camera, b: Camera, t: number, turn = t) {
        this.position.lerp(a.position, b.position, t);
        this.angles.x = math.lerp(a.angles.x, b.angles.x, turn);
        this.angles.y = a.angles.y + (mod(b.angles.y - a.angles.y + 180, 360) - 180) * turn;
        this.angles.z = math.lerp(a.angles.z, b.angles.z, turn);
        this.distance = math.lerp(a.distance, b.distance, t);
        this.fov = math.lerp(a.fov, b.fov, t);
    }

    look(from: Vec3, to: Vec3) {
        this.position.copy(from);
        this.distance = from.distance(to);
        const dir = avec.sub2(to, from).normalize();
        vecToAngles(this.angles, dir);
    }

    calcFocusPoint(result: Vec3) {
        rotation
            .setFromEulerAngles(this.angles)
            .transformVector(Vec3.FORWARD, result)
            .mulScalar(this.distance)
            .add(this.position);
    }
}

type CameraController = {
    onEnter(camera: Camera): void;
    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera): void;
    onExit(camera: Camera): void;
};

export type { CameraFrame, CameraController };

export { Camera };
