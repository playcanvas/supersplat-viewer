import type { Camera, CameraFrame } from './camera';
import { CameraController } from './camera';
import { AnimState } from '../animation/anim-state';
import { AnimTrack } from '../settings';

class AnimController implements CameraController {
    animState: AnimState;

    constructor(animTrack: AnimTrack) {
        this.animState = AnimState.fromTrack(animTrack);
        this.animState.update(0);
    }

    onEnter(camera: Camera): void {
        // snap camera to start position
        camera.look(this.animState.position, this.animState.target);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        this.animState.update(deltaTime);

        // update camera pose
        camera.look(this.animState.position, this.animState.target);

        // ignore input
        inputFrame.read();
    }

    onExit(camera: Camera): void {

    }
}

export { AnimController };
