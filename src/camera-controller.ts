import {
    type BoundingBox,
    Pose,
    Vec3
} from 'playcanvas';

import { AnimState } from './animation/anim-state';
import { createRotateTrack } from './animation/create-rotate-track';
import { AnimCamera } from './cameras/anim-camera';
import type { Camera, CameraFrame } from './cameras/camera';
import { FlyCamera } from './cameras/fly-camera';
import { OrbitCamera } from './cameras/orbit-camera';
import { easeOut } from './core/math';
import { AnimTrack } from './settings';
import { CameraMode, Global } from './types';

const vecToAngles = (result: Vec3, vec: Vec3) => {
    const radToDeg = 180 / Math.PI;
    result.x = Math.asin(vec.y) * radToDeg;
    result.y = Math.atan2(-vec.x, -vec.z) * radToDeg;
    result.z = 0;

    return result;
};

const pose = new Pose();
const avec = new Vec3();
const bvec = new Vec3();

// lerp between two poses
const lerpPose = (result: Pose, a: Pose, b: Pose, t: number) => {
    // lerp camera position
    result.position.lerp(a.position, b.position, t);

    // lerp focus point and subtract from camera position
    a.getFocus(avec);
    b.getFocus(bvec);
    avec.lerp(avec, bvec, t).sub(result.position);

    // calculate distance
    result.distance = avec.length();

    // set angles
    vecToAngles(result.angles, avec.mulScalar(1.0 / result.distance));
};

const createPose = (position: Vec3, target: Vec3): Pose => {
    return new Pose().look(position, target);
};

const createFramePose = (bbox: BoundingBox, cameraFov: number): Pose => {
    const sceneSize = bbox.halfExtents.length();
    const distance = sceneSize / Math.sin(cameraFov / 180 * Math.PI * 0.5);
    return createPose(
        new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
        bbox.center
    );
};

class CameraController {
    update: (deltaTime: number, cameraFrame: CameraFrame) => void;

    activePose: Pose = new Pose();

    constructor(global: Global, bbox: BoundingBox) {
        const { events, settings, state, camera } = global;

        const framePose = createFramePose(bbox, camera.camera.fov);

        const resetPose = createPose(
            new Vec3(settings.camera.position ?? [2, 1, 2]),
            new Vec3(settings.camera.target ?? [0, 0, 0])
        );

        const getAnimState = (initial: Pose, isObjectExperience: boolean) => {
            const { animTracks, camera } = settings;

            // extract the camera animation track from settings
            if (animTracks?.length > 0 && camera.startAnim === 'animTrack') {
                const track = animTracks.find((track: AnimTrack) => track.name === camera.animTrack);
                if (track) {
                    return AnimState.fromTrack(track);
                }
            } else if (isObjectExperience) {
                // create basic rotation animation if no anim track is specified
                return AnimState.fromTrack(createRotateTrack(initial));
            }
            return null;
        };

        // calculate the user camera start position (the pose we'll use if there is no animation)
        const useReset = settings.camera.position || settings.camera.target || bbox.halfExtents.length() > 100;
        const userStart = (useReset ? resetPose : framePose).clone();
        const animState = getAnimState(userStart, !bbox.containsPoint(userStart.position));

        const orbitCamera = new OrbitCamera();
        const flyCamera = new FlyCamera();
        const animCamera = animState ? new AnimCamera(animState) : null;

        const getCamera = (cameraMode: 'orbit' | 'anim' | 'fly'): Camera => {
            switch (cameraMode) {
                case 'orbit': return orbitCamera;
                case 'anim': return animCamera;
                case 'fly': return flyCamera;
            }
        };

        // set the global animation flag
        state.hasAnimation = !!animCamera;
        state.animationDuration = animCamera ? animCamera.animState.cursor.duration : 0;
        if (animCamera) {
            state.cameraMode = 'anim';
        }

        const prevPose = new Pose();
        const { activePose } = this;
        let currCamera = getCamera(state.cameraMode);
        let prevCameraMode: CameraMode = 'orbit';

        activePose.copy(currCamera.pose);
        orbitCamera.goto(activePose);
        flyCamera.goto(activePose);

        // handle input events
        events.on('inputEvent', (eventName, event) => {
            const doReset = (pose: Pose) => {
                switch (state.cameraMode) {
                    case 'orbit': {
                        orbitCamera.goto(pose, true);
                        break;
                    }
                    case 'fly': {
                        state.cameraMode = 'orbit';
                        orbitCamera.goto(pose, true);
                        break;
                    }
                    case 'anim': {
                        state.cameraMode = prevCameraMode;
                        break;
                    }
                }
            };

            switch (eventName) {
                case 'frame':
                    doReset(framePose);
                    break;
                case 'reset':
                    doReset(resetPose);
                    break;
                case 'playPause':
                    if (state.cameraMode === 'anim') {
                        state.animationPaused = !state.animationPaused;
                    } else {
                        state.cameraMode = 'anim';
                        state.animationPaused = false;
                    }
                    break;
                case 'cancel':
                case 'interrupt':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = prevCameraMode;
                    }
                    break;
            }
        });

        // transition time between cameras
        let transitionTimer = 1;

        // application update
        this.update = (deltaTime: number, frame: CameraFrame) => {

            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' && state.animationPaused ? 0 : deltaTime;

            // update the camera we're transitioning from
            transitionTimer = Math.min(1, transitionTimer + deltaTime * 2.0);

            currCamera.update(frame, dt);

            // update camera
            pose.copy(currCamera.pose);

            if (transitionTimer < 1) {
                // handle lerp away from previous camera
                lerpPose(activePose, prevPose, pose, easeOut(transitionTimer));
            } else {
                activePose.copy(pose);
            }

            // apply to camera
            camera.setPosition(activePose.position);
            camera.setEulerAngles(activePose.angles);

            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = animCamera.animState.cursor.value;
            }
        };

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            prevCameraMode = prev;
            prevPose.copy(activePose);

            currCamera = getCamera(value);
            switch (value) {
                case 'orbit':
                    orbitCamera.goto(activePose, false);
                    break;
                case 'fly':
                    flyCamera.goto(activePose, false);
                    break;
            }

            // reset camera transition timer
            transitionTimer = 0;
        });

        // handle user scrubbing the animation timeline
        events.on('scrubAnim', (time) => {
            if (animCamera) {
                animCamera.animState.cursor.value = time;

                // switch to animation camera if we're not already there
                if (state.cameraMode !== 'anim') {
                    state.cameraMode = 'anim';
                }
            }
        });

        // handle user picking in the scene
        events.on('pick', (position: Vec3) => {
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }
            // snap distance of focus to picked point to interpolate rotation only
            activePose.distance = activePose.position.distance(position);
            orbitCamera.goto(activePose, false);
            orbitCamera.goto(pose.look(activePose.position, position), true);
        });

        // initialize the camera entity to initial position and kick off the
        // first scene sort (which usually happens during render)
        camera.setPosition(activePose.position);
        camera.setEulerAngles(activePose.angles);
    }
}

export { CameraController };
