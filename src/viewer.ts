import {
    BoundingBox,
    Color,
    FlyController,
    Pose,
    Mat4,
    OrbitController,
    Vec2,
    Vec3
} from 'playcanvas';
import type { AppBase, Entity, EventHandler, GSplatComponent, InputController } from 'playcanvas';

import { AnimController, AnimTrack } from './controllers/anim-controller';
import { easeOut } from './core/math';
import { AppController } from './input';
import { Picker } from './picker';


const pose = new Pose();

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
    app: AppBase;

    entity: Entity;

    events: EventHandler;

    state: any;

    settings: any;

    constructor(app: AppBase, entity: Entity, events: EventHandler, state: any, settings: any, params: any) {
        const { background, camera } = settings;
        const { graphicsDevice } = app;

        this.app = app;
        this.entity = entity;
        this.events = events;
        this.state = state;
        this.settings = settings;

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        // apply camera animation settings
        entity.camera.clearColor = new Color(background.color);
        entity.camera.fov = camera.fov;

        // handle horizontal fov on canvas resize
        const updateHorizontalFov = () => {
            this.entity.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
        };
        graphicsDevice.on('resizecanvas', () => {
            updateHorizontalFov();
            app.renderNextFrame = true;
        });
        updateHorizontalFov();

        // track camera changes
        const prevProj = new Mat4();
        const prevWorld = new Mat4();

        app.on('framerender', () => {
            const world = this.entity.getWorldTransform();
            const proj = this.entity.camera.projectionMatrix;
            const nearlyEquals = (a: Float32Array<ArrayBufferLike>, b: Float32Array<ArrayBufferLike>, epsilon = 1e-4) => {
                return !a.some((v, i) => Math.abs(v - b[i]) >= epsilon);
            };

            if (params.ministats) {
                app.renderNextFrame = true;
            }

            if (!app.autoRender && !app.renderNextFrame) {
                if (!nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }

            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }
        });

        events.on('hqMode:changed', (value) => {
            graphicsDevice.maxPixelRatio = value ? window.devicePixelRatio : 1;
            app.renderNextFrame = true;
        });
        graphicsDevice.maxPixelRatio = state.hqMode ? window.devicePixelRatio : 1;
    }

    // initialize the viewer once gsplat asset is finished loading (so we know its bound etc)
    initialize() {
        const { app, entity, events, state, settings } = this;

        // get the gsplat
        const gsplat = app.root.findComponent('gsplat') as GSplatComponent;

        // calculate scene bounding box
        const bbox = gsplat?.instance?.meshInstance?.aabb ?? new BoundingBox();

        // create an anim camera
        // calculate the orbit camera frame position
        const framePose = (() => {
            const sceneSize = bbox.halfExtents.length();
            const distance = sceneSize / Math.sin(entity.camera.fov / 180 * Math.PI * 0.5);
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
                    return AnimController.fromTrack(track);
                }
            } else if (isObjectExperience) {
                // create basic rotation animation if no anim track is specified
                return AnimController.fromTrack(createRotateTrack(initial));
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
        state.animationDuration = animCamera ? animCamera.cursor.duration : 0;
        if (animCamera) {
            state.cameraMode = 'anim';
        }

        // this pose stores the current camera position. it will be blended/smoothed
        // toward the current active camera
        const activePose = new Pose();

        // create controller
        // set move speed based on scene size, within reason
        const controller = new AppController(app.graphicsDevice.canvas, entity.camera);
        controller.moveSpeed = bbox.halfExtents.length() * 0.1;

        if (state.cameraMode === 'anim') {
            //  first frame of the animation
            activePose.copy(animCamera.update(controller.frame, 0));
        } else {
            // user start position
            activePose.copy(userStart);
        }

        // place all user cameras at the start position
        orbitCamera.attach(activePose, false);
        flyCamera.attach(activePose, false);

        // transition time between cameras
        let transitionTimer = 0;

        // the previous camera we're transitioning away from
        const prevPose = new Pose();
        let prevCamera: InputController | null = null;
        let prevCameraMode = 'orbit';

        // handle input events
        events.on('inputEvent', (eventName, event) => {
            const doReset = (pose: Pose) => {
                switch (state.cameraMode) {
                    case 'orbit': {
                        orbitCamera.attach(pose, true);
                        break;
                    }
                    case 'fly': {
                        if (state.cameraMode !== 'orbit') {
                            state.snap = true;
                            state.cameraMode = 'orbit';
                        }
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
            const dt = state.cameraMode === 'anim' ?
                (state.animationPaused ? 0 : deltaTime * transitionTimer) :
                deltaTime;

            // update camera
            pose.copy(getCamera(state.cameraMode).update(controller.frame, dt));

            // blend camera smoothly during transitions
            if (transitionTimer < 1) {
                transitionTimer = Math.min(1, transitionTimer + deltaTime);
                if (transitionTimer < 1 && prevCamera) {
                    pose.lerp(prevPose, pose, easeOut(transitionTimer));
                }
            }

            // apply to camera
            activePose.copy(pose);
            entity.setPosition(activePose.position);
            entity.setEulerAngles(activePose.angles);

            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = animCamera.cursor.value;
            }
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            prevCameraMode = prev;
            prevPose.copy(activePose);
            prevCamera = getCamera(prev);
            prevCamera.detach();

            switch (value) {
                case 'orbit':
                case 'fly':
                    getCamera(value).attach(activePose, false);
                    break;
            }

            // reset camera transition timer
            if (!state.snap) {
                transitionTimer = 0;
            }
            state.snap = false;
        });

        events.on('setAnimationTime', (time) => {
            if (animCamera) {
                animCamera.cursor.value = time;

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
                        picker = new Picker(app, entity);
                    }
                    const result = await picker.pick(event.offsetX, event.offsetY);
                    if (result) {
                        if (state.cameraMode !== 'orbit') {
                            state.snap = true;
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
        entity.setPosition(activePose.position);
        entity.setEulerAngles(activePose.angles);
        gsplat?.instance?.sort(entity);

        // handle gsplat sort updates
        gsplat?.instance?.sorter?.on('updated', () => {
            // request frame render when sorting changes
            app.renderNextFrame = true;

            if (!state.readyToRender) {
                // we're ready to render once the first sort has completed
                state.readyToRender = true;

                // wait for the first valid frame to complete rendering
                const frameHandle = app.on('frameend', () => {
                    frameHandle.off();

                    events.fire('firstFrame');

                    // emit first frame event on window
                    window.firstFrame?.();
                });
            }
        });
    }
}

export { Viewer };
