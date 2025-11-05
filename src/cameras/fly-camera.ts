import {
    FlyController,
    Pose,
    Vec2
} from 'playcanvas';

import type { Camera, CameraFrame } from './camera';


class FlyCamera implements Camera {
    controller: FlyController;

    controllerPose: Pose;

    constructor() {
        this.controller = new FlyController();
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
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

export { FlyCamera };
