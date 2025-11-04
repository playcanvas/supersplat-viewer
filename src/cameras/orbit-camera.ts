import type { Camera, CameraFrame } from './camera';
import {
    OrbitController,
    Pose,
    Vec2
} from 'playcanvas';

class OrbitCamera implements Camera {
    controller: OrbitController;

    controllerPose: Pose;

    constructor() {
        this.controller = new OrbitController();
        this.controller.zoomRange = new Vec2(0.01, Infinity);
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
        this.controller.zoomDamping = 0.97;
    }

    get pose() {
        return this.controllerPose;
    }

    update(inputFrame: CameraFrame, dt: number) {
        this.controllerPose = this.controller.update(inputFrame, dt);
    }

    goto(pose: Pose, smooth = false) {
        this.controller.attach(pose, smooth);
    }
}

export { OrbitCamera };
