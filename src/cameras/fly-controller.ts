import {
    FlyController as FlyControllerPC,
    Pose,
    Vec2
} from 'playcanvas';

import type { Collision, PushOut } from '../collision';
import type { CameraFrame, Camera, CameraController } from './camera';

/** Radius of the camera collision sphere (meters) */
const CAMERA_RADIUS = 0.2;

const p = new Pose();

/** Pre-allocated push-out vector for sphere collision */
const pushOut: PushOut = { x: 0, y: 0, z: 0 };

class FlyController implements CameraController {
    controller: FlyControllerPC;

    fov = 90;

    /** Optional collision for sphere collision with sliding */
    collision: Collision | null = null;

    constructor() {
        this.controller = new FlyControllerPC();
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
    }

    onEnter(camera: Camera): void {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, false);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const pose = this.controller.update(inputFrame, deltaTime);

        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;

        if (this.collision) {
            // Resolve collision on _targetPose first. The engine's update() already
            // applied input to _targetPose and lerped _pose toward it. By correcting
            // _targetPose now, we ensure next frame's lerp interpolates toward a safe
            // position, preventing the camera from overshooting into the wall.
            const target = (this.controller as any)._targetPose;

            if (this.collision.querySphere(target.position.x, target.position.y, target.position.z, CAMERA_RADIUS, pushOut)) {
                target.position.x += pushOut.x;
                target.position.y += pushOut.y;
                target.position.z += pushOut.z;
            }

            if (this.collision.querySphere(pose.position.x, pose.position.y, pose.position.z, CAMERA_RADIUS, pushOut)) {
                pose.position.x += pushOut.x;
                pose.position.y += pushOut.y;
                pose.position.z += pushOut.z;
            }
        }

        camera.position.copy(pose.position);
        camera.fov = this.fov;
    }

    onExit(camera: Camera): void {

    }

    goto(pose: Pose) {
        this.controller.attach(pose, true);
    }
}

export { FlyController };
