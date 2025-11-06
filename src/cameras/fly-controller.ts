import {
    FlyController as FlyControllerPC,
    Pose,
    Vec2
} from 'playcanvas';

import type { CameraFrame, Camera, CameraController } from './camera';

const p = new Pose();

class FlyController implements CameraController {
    controller: FlyControllerPC;

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

        camera.position.copy(pose.position);
        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;
    }

    onExit(camera: Camera): void {

    }

    goto(pose: Pose) {
        this.controller.attach(pose, true);
    }
}

export { FlyController };
