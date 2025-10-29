import {
    BoundingBox,
    Color,
    Entity,
    Mat4,
    MiniStats,
    Pose,
    ShaderChunks,
    type TextureHandler,
    Vec3
} from 'playcanvas';

import { AnimState } from './anim-state';
import { type Camera, OrbitCamera, FlyCamera, AnimCamera } from './camera';
import { easeOut } from './core/math';
import { InputController } from './input-controller';
import { Picker } from './picker';
import { AnimTrack } from './settings';
import { CameraMode, Global } from './types';

// override global pick to pack depth instead of meshInstance id
const pickDepthGlsl = /* glsl */ `
vec4 packFloat(float depth) {
    uvec4 u = (uvec4(floatBitsToUint(depth)) >> uvec4(0u, 8u, 16u, 24u)) & 0xffu;
    return vec4(u) / 255.0;
}
vec4 getPickOutput() {
    return packFloat(gl_FragCoord.z);
}
`;

const pickDepthWgsl = /* wgsl */ `
    fn packFloat(depth: f32) -> vec4f {
        let u: vec4<u32> = (vec4<u32>(bitcast<u32>(depth)) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(0xffu);
        return vec4f(u) / 255.0;
    }

    fn getPickOutput() -> vec4f {
        return packFloat(pcPosition.z);
    }
`;

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

class Viewer {
    global: Global;

    constructor(global: Global) {
        this.global = global;

        const { app, settings, config, events, state, camera } = global;
        const { background } = settings;
        const { graphicsDevice } = app;

        // enable anonymous CORS for image loading in safari
        (app.loader.getHandler('texture') as TextureHandler).imgParser.crossOrigin = 'anonymous';

        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', glsl.get('skyboxPS').replace('mapRoughnessUv(uv, mipLevel)', 'uv'));
        glsl.set('pickPS', pickDepthGlsl);

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));
        wgsl.set('pickPS', pickDepthWgsl);

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        // apply camera animation settings
        camera.camera.clearColor = new Color(background.color);
        camera.camera.fov = settings.camera.fov;

        // handle horizontal fov on canvas resize
        const updateHorizontalFov = () => {
            camera.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
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
            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;
            const nearlyEquals = (a: Float32Array<ArrayBufferLike>, b: Float32Array<ArrayBufferLike>, epsilon = 1e-4) => {
                return !a.some((v, i) => Math.abs(v - b[i]) >= epsilon);
            };

            if (config.ministats) {
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

        // Construct ministats
        if (config.ministats) {
            // eslint-disable-next-line no-new
            new MiniStats(app);
        }
    }

    onModelLoaded(gsplat: Entity) {
        const { app, events, settings, state, camera } = this.global;

        // calculate scene bounding box
        const bbox = gsplat.gsplat?.instance?.meshInstance?.aabb ?? new BoundingBox();

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

        // create the input device controller
        const inputController = new InputController(app.graphicsDevice.canvas, camera.camera);

        const prevPose = new Pose();
        const activePose = new Pose();
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
        app.on('update', (deltaTime) => {

            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            // update input controller
            inputController.update(deltaTime, state, activePose.distance);

            // update touch joystick UI
            if (state.cameraMode === 'fly') {
                events.fire('touchJoystickUpdate', inputController.joystick.base, inputController.joystick.stick);
            }

            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' && state.animationPaused ? 0 : deltaTime;

            // update the camera we're transitioning from
            transitionTimer = Math.min(1, transitionTimer + deltaTime * 2.0);

            currCamera.update(inputController.frame, dt);

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
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            prevCameraMode = prev;
            prevPose.copy(activePose);
            // getCamera(prev).detach();

            currCamera = getCamera(value);
            switch (value) {
                case 'orbit':
                case 'fly':
                    currCamera.goto(activePose, false);
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
                        orbitCamera.goto(activePose, false);
                        orbitCamera.goto(pose.look(activePose.position, result), true);
                    }
                    break;
                }
            }
        });

        // initialize the camera entity to initial position and kick off the
        // first scene sort (which usually happens during render)
        camera.setPosition(activePose.position);
        camera.setEulerAngles(activePose.angles);

        // kick off gsplat sorting immediately now that camera is in position
        gsplat.gsplat?.instance?.sort(camera);

        // listen for sorting updates to trigger first frame events
        gsplat.gsplat?.instance?.sorter?.on('updated', () => {
            // request frame render when sorting changes
            app.renderNextFrame = true;

            if (!state.readyToRender) {
                // we're ready to render once the first sort has completed
                state.readyToRender = true;

                // wait for the first valid frame to complete rendering
                app.once('frameend', () => {
                    events.fire('firstFrame');

                    // emit first frame event on window
                    window.firstFrame?.();
                });
            }
        });
    }
}

export { Viewer };
