import { math, Vec3, Quat } from 'playcanvas';
import type { InputFrame } from 'playcanvas';

import { vecToAngles } from '../core/math';

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

    look(from: Vec3, to: Vec3) {
        this.position.copy(from);
        this.distance = from.distance(to);
        const dir = avec.sub2(to, from).normalize();
        vecToAngles(this.angles, dir);
    }

    calcFocusPoint(result: Vec3) {
        rotation.setFromEulerAngles(this.angles)
        .transformVector(Vec3.FORWARD, result)
        .mulScalar(this.distance)
        .add(this.position);
    }
}

interface CameraController {
    onEnter(camera: Camera): void;
    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera): void;
    onExit(camera: Camera): void;
}

export type { CameraFrame, CameraController };

export { Camera };
