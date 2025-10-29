import {
    FlyController,
    InputFrame,
    OrbitController,
    Pose,
    Vec2
} from 'playcanvas';

import { AnimState } from './anim-state';

type CameraFrame = InputFrame<{
    move: [number, number, number];
    rotate: [number, number, number];
}>;

type Camera = {
    pose: Pose;
    update(inputFrame: CameraFrame, dt: number): void;
    goto(pose: Pose, smooth: boolean): void;
};

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
};

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
};

class AnimCamera implements Camera {
    animState: AnimState;
    pose = new Pose();

    constructor(animState: AnimState) {
        this.animState = animState;
        this.animState.update(0);
        this.pose.look(this.animState.position, this.animState.target);
    }

    update(frame: CameraFrame, dt: number) {
        this.animState.update(dt);

        // update camera pose
        this.pose.look(this.animState.position, this.animState.target);

        // ignore input
        frame.read();
    }

    goto(pose: Pose, smooth: boolean) {
        
    }
};

export type { CameraFrame, Camera };

export { OrbitCamera, FlyCamera, AnimCamera };
