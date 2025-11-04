import type { AnimState } from '../animation/anim-state';
import type { Camera, CameraFrame } from './camera';
import { Pose } from 'playcanvas';

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
}

export { AnimCamera };
