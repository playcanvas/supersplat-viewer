import {
    BoundingBox,
    FlyController,
    InputController,
    Pose,
    Mat4,
    OrbitController,
    Vec2,
    Vec3
} from 'playcanvas';
import type { InputFrame } from 'playcanvas';

import { AnimState } from './controllers/anim-state';
import { easeOut } from './core/math';
import { AppController } from './input';
import { Picker } from './picker';
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

class AnimController extends InputController {
    animState: AnimState;

    constructor(animState: AnimState) {
        super();
        this.animState = animState;
    }

    update(frame: InputFrame<{ move: number[], rotate: number[] }>, dt: number) {
        this.animState.update(dt);

        frame.read();
        this._pose.look(this.animState.position, this.animState.target);
        return this._pose;
    }
}

/**
 * Creates a rotation animation track
 *
 * @param initial - The initial pose of the camera.
 * @param keys - The number of keys in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns - The animation track object containing position and target keyframes.
 */
const createRotateTrack = (initial: Pose, keys: number = 12, duration: number = 20): AnimTrack => {
    const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
    const position: number[] = [];
    const target: number[] = [];

    const initialTarget = new Vec3();
    initial.getFocus(initialTarget);

    const mat = new Mat4();
    const vec = new Vec3();
    const dif = new Vec3(
        initial.position.x - initialTarget.x,
        initial.position.y - initialTarget.y,
        initial.position.z - initialTarget.z
    );

    for (let i = 0; i < keys; ++i) {
        mat.setFromEulerAngles(0, -i / keys * 360, 0);
        mat.transformPoint(dif, vec);

        position.push(initialTarget.x + vec.x);
        position.push(initialTarget.y + vec.y);
        position.push(initialTarget.z + vec.z);

        target.push(initialTarget.x);
        target.push(initialTarget.y);
        target.push(initialTarget.z);
    }

    return {
        name: 'rotate',
        duration,
        frameRate: 1,
        target: 'camera',
        loopMode: 'repeat',
        interpolation: 'spline',
        smoothness: 1,
        keyframes: {
            times,
            values: {
                position,
                target
            }
        }
    };
};

class Viewer {
    constructor(global: Global) {
        const { app, events, settings, state, camera, gsplat } = global;

        // calculate scene bounding box
        const bbox = gsplat.gsplat?.instance?.meshInstance?.aabb ?? new BoundingBox();

        // create an anim camera
        // calculate the orbit camera frame position
        const framePose = (() => {
            const sceneSize = bbox.halfExtents.length();
            const distance = sceneSize / Math.sin(camera.camera.fov / 180 * Math.PI * 0.5);
            return new Pose().look(
                new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
                bbox.center
            );
        })();

        // calculate the orbit camera reset position
        const resetPose = (() => {
            const { position, target } = settings.camera;
            return new Pose().look(
                new Vec3(position ?? [2, 1, 2]),
                new Vec3(target ?? [0, 0, 0])
            );
        })();

        // calculate the user camera start position (the pose we'll use if there is no animation)
        const useReset = settings.camera.position || settings.camera.target || bbox.halfExtents.length() > 100;
        const userStart = (useReset ? resetPose : framePose).clone();

        // if camera doesn't intersect the scene, assume it's an object we're
        // viewing
        const isObjectExperience = !bbox.containsPoint(userStart.position);

        // create the cameras
        const animCamera = ((initial, isObjectExperience) => {
            const { animTracks, camera } = settings;

            // extract the camera animation track from settings
            if (animTracks?.length > 0 && camera.startAnim === 'animTrack') {
                const track = animTracks.find((track: AnimTrack) => track.name === camera.animTrack);
                if (track) {
                    return new AnimController(AnimState.fromTrack(track));
                }
            } else if (isObjectExperience) {
                // create basic rotation animation if no anim track is specified
                return new AnimController(AnimState.fromTrack(createRotateTrack(initial)));
            }
            return null;
        })(userStart, isObjectExperience);

        const orbitCamera = (() => {
            const orbitCamera = new OrbitController();

            orbitCamera.zoomRange = new Vec2(0.01, Infinity);
            orbitCamera.pitchRange = new Vec2(-90, 90);
            orbitCamera.rotateDamping = 0.97;
            orbitCamera.moveDamping = 0.97;
            orbitCamera.zoomDamping = 0.97;

            return orbitCamera;
        })();

        const flyCamera = (() => {
            const flyCamera = new FlyController();

            flyCamera.pitchRange = new Vec2(-90, 90);
            flyCamera.rotateDamping = 0.97;
            flyCamera.moveDamping = 0.97;

            return flyCamera;
        })();

        const getCamera = (cameraMode: 'orbit' | 'anim' | 'fly'): InputController => {
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

        // create controller
        // set move speed based on scene size, within reason
        const controller = new AppController(app.graphicsDevice.canvas, camera.camera);

        // fixed move speed
        controller.moveSpeed = 4;

        // this pose stores the current camera position. it will be blended/smoothed
        // toward the current active camera
        const activePose = new Pose();

        if (state.cameraMode === 'anim') {
            // first frame of the animation
            activePose.copy(animCamera.update(controller.frame, 0));
        } else {
            // user start position
            activePose.copy(userStart);
        }

        // place all user cameras at the start position
        orbitCamera.attach(activePose, false);
        flyCamera.attach(activePose, false);

        // the previous camera we're transitioning away from
        let prevCameraMode: CameraMode = 'orbit';

        // handle input events
        events.on('inputEvent', (eventName, event) => {
            const doReset = (pose: Pose) => {
                switch (state.cameraMode) {
                    case 'orbit': {
                        orbitCamera.attach(pose, true);
                        break;
                    }
                    case 'fly': {
                        state.cameraMode = 'orbit';
                        orbitCamera.attach(pose, true);
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
                case 'cancel':
                case 'interrupt':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = prevCameraMode;
                    }
                    break;
            }
        });

        let currCamera = getCamera(state.cameraMode);
        const prevPose = new Pose();

        // transition time between cameras
        let transitionTimer = 1;

        // application update
        app.on('update', (deltaTime) => {

            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            // update input controller
            controller.update(deltaTime, state, activePose.distance);

            // update touch joystick UI
            if (state.cameraMode === 'fly') {
                events.fire('touchJoystickUpdate', controller.joystick.base, controller.joystick.stick);
            }

            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' && state.animationPaused ? 0 : deltaTime;

            // update the camera we're transitioning from
            transitionTimer = Math.min(1, transitionTimer + deltaTime * 2.0);

            // update camera
            pose.copy(currCamera.update(controller.frame, dt));

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
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            prevCameraMode = prev;
            prevPose.copy(activePose);
            getCamera(prev).detach();

            currCamera = getCamera(value);
            switch (value) {
                case 'orbit':
                case 'fly':
                    currCamera.attach(activePose, false);
                    break;
            }

            // reset camera transition timer
            transitionTimer = 0;
        });

        events.on('setAnimationTime', (time) => {
            if (animCamera) {
                animCamera.animState.cursor.value = time;

                // switch to animation camera if we're not already there
                if (state.cameraMode !== 'anim') {
                    state.cameraMode = 'anim';
                }
            }
        });

        // pick orbit camera focus point on double click
        let picker: Picker | null = null;
        events.on('inputEvent', async (eventName, event) => {
            switch (eventName) {
                case 'dblclick': {
                    if (!picker) {
                        picker = new Picker(app, camera);
                    }
                    const result = await picker.pick(event.offsetX, event.offsetY);
                    if (result) {
                        if (state.cameraMode !== 'orbit') {
                            state.cameraMode = 'orbit';
                        }

                        // snap distance of focus to picked point to interpolate rotation only
                        activePose.distance = activePose.position.distance(result);
                        orbitCamera.attach(activePose, false);
                        orbitCamera.attach(pose.look(activePose.position, result), true);
                    }
                    break;
                }
            }
        });

        // initialize the camera entity to initial position and kick off the
        // first scene sort (which usually happens during render)
        camera.setPosition(activePose.position);
        camera.setEulerAngles(activePose.angles);
    }
}

export { Viewer };
