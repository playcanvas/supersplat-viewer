import '@playcanvas/web-components';
import { DualGestureSource, KeyboardMouseSource, MultiTouchSource } from 'camera-controls';
import { BoundingBox, Color, Mat4, Vec3 } from 'playcanvas';

import { AnimCamera } from './cameras/anim-camera.js';
import { FlyCamera } from './cameras/fly-camera.js';
import { OrbitCamera } from './cameras/orbit-camera.js';
import { Pose } from './core/pose.js';
import { Input } from './input.js';
import { Picker } from './picker.js';

const tmpV1 = new Vec3();

const gsplatFS = /* glsl */ `

#ifdef PICK_PASS
vec4 packFloat(float depth) {
    uvec4 u = (uvec4(floatBitsToUint(depth)) >> uvec4(0u, 8u, 16u, 24u)) & 0xffu;
    return vec4(u) / 255.0;
}
#endif

varying mediump vec2 gaussianUV;
varying mediump vec4 gaussianColor;

void main(void) {
    mediump float A = dot(gaussianUV, gaussianUV);
    if (A > 1.0) {
        discard;
    }

    // evaluate alpha
    mediump float alpha = exp(-A * 4.0) * gaussianColor.a;

    #ifdef PICK_PASS
        if (alpha < 0.1) {
            discard;
        }
        gl_FragColor = packFloat(gl_FragCoord.z);
    #else
        if (alpha < 1.0 / 255.0) {
            discard;
        }

        #ifndef DITHER_NONE
            opacityDither(alpha, id * 0.013);
        #endif

        gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);
    #endif
}
`;

const pose = new Pose();

class Viewer {
    constructor(app, entity, events, state, settings, params) {
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
            const nearlyEquals = (a, b, epsilon = 1e-4) => {
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
        const gsplat = app.root.findComponent('gsplat');

        // calculate scene bounding box
        const bbox = gsplat?.instance?.meshInstance?.aabb ?? new BoundingBox();

        // override gsplat shader for picking
        const { instance } = gsplat;
        instance.createMaterial({
            fragment: gsplatFS
        });

        // create an anim camera
        const createAnimCamera = (initial, isObjectExperience) => {
            const { animTracks, camera } = settings;

            // extract the camera animation track from settings
            if (animTracks?.length > 0 && camera.startAnim === 'animTrack') {
                const track = animTracks.find(track => track.name === camera.animTrack);
                if (track) {
                    return AnimCamera.fromTrack(track);
                }
            } else if (isObjectExperience) {
                // create a slowly rotating animation around it
                const keys = 12;
                const duration = 20;
                const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
                const position = [];
                const target = [];

                const initialTarget = new Vec3();
                initial.calcTarget(initialTarget);

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

                // construct a simple rotation animation around an object
                return AnimCamera.fromTrack({
                    name: 'rotate',
                    duration,
                    frameRate: 1,
                    target: 'camera',
                    loopMode: 'repeat',
                    interpolation: 'spline',
                    keyframes: {
                        times,
                        values: {
                            position,
                            target
                        }
                    }
                });
            }

            return null;
        };

        // calculate the orbit camera frame position
        const framePose = (() => {
            const sceneSize = bbox.halfExtents.length();
            const distance = sceneSize / Math.sin(entity.camera.fov / 180 * Math.PI * 0.5);
            return new Pose().fromLookAt(
                new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
                bbox.center
            );
        })();

        // calculate the orbit camera reset position
        const resetPose = (() => {
            const { position, target } = this.settings.camera;
            return new Pose().fromLookAt(
                new Vec3(position ?? [2, 1, 2]),
                new Vec3(target ?? [0, 0, 0])
            );
        })();

        // calculate the user camera start position (the pose we'll use if there is no animation)
        const useReset = settings.camera.position || settings.camera.target || bbox.halfExtents.length() > 100;
        const userStart = new Pose(useReset ? resetPose : framePose);

        // if camera doesn't intersect the scene, assume it's an object we're
        // viewing
        const isObjectExperience = !bbox.containsPoint(userStart.position);

        // create the cameras
        const animCamera = createAnimCamera(userStart, isObjectExperience);
        const orbitCamera = new OrbitCamera();
        const flyCamera = new FlyCamera();

        const getCamera = (cameraMode) => {
            switch (cameraMode) {
                case 'orbit': return orbitCamera;
                case 'anim': return animCamera;
                case 'fly': return flyCamera;
            }
        };

        // set fly speed based on scene size, within reason
        flyCamera.moveSpeed = Math.max(0.05, Math.min(1, bbox.halfExtents.length() * 0.0001));

        // set the global animation flag
        state.hasAnimation = !!animCamera;
        state.animationDuration = animCamera ? animCamera.cursor.duration : 0;
        state.cameraMode = animCamera ? 'anim' : 'orbit';

        // this pose stores the current camera position. it will be blended/smoothed
        // toward the current active camera
        const activePose = new Pose();

        // calculate the initial camera position, either userStart or animated
        // camera start position
        if (state.cameraMode === 'anim') {
            animCamera.getPose(activePose);
        } else {
            activePose.copy(userStart);
        }

        // place all user cameras at the start position
        orbitCamera.reset(activePose);
        flyCamera.reset(activePose);

        // create input sources
        const desktopInput = new KeyboardMouseSource();
        const orbitInput = new MultiTouchSource();
        const flyInput = new DualGestureSource();

        desktopInput.attach(app.graphicsDevice.canvas);
        orbitInput.attach(app.graphicsDevice.canvas);
        flyInput.attach(app.graphicsDevice.canvas);

        // create controller
        const controller = {
            _axis: new Vec3(),
            _touches: 0,

            left: new Input(),
            right: new Input(),

            update: (dt) => {
                const { key, mouse, wheel } = desktopInput.frame();
                const { touch, pinch, count } = orbitInput.frame();
                const { left, right } = flyInput.frame();

                // multipliers
                const fdt = 60 * dt;
                const moveMult = 5 * fdt;
                const wheelMult = 0.05 * fdt;
                const pinchMult = 0.5 * fdt;
                const lookMult = 1 * fdt;

                // update state
                const [keyW, keyS, keyA, keyD, keyQ, keyE] = key;
                controller._axis.add(tmpV1.set(keyD - keyA, keyE - keyQ, keyS - keyW));
                controller._touches += count[0];

                // update mobile input
                switch (state.cameraMode) {
                    case 'orbit': {
                        // desktop
                        tmpV1.copy(controller._axis).normalize();
                        controller.left.add(
                            -tmpV1.x * moveMult,
                            tmpV1.y * moveMult,
                            tmpV1.z * moveMult + wheel[0] * wheelMult
                        );
                        controller.right.add(
                            mouse[0] * lookMult,
                            mouse[1] * lookMult,
                            0
                        );

                        // mobile
                        if (controller._touches > 1) {
                            controller.left.add(
                                touch[0] * moveMult * 0.5,
                                touch[1] * moveMult * 0.5,
                                pinch[0] * pinchMult
                            );
                        } else {
                            controller.right.add(
                                touch[0] * lookMult,
                                touch[1] * lookMult,
                                pinch[0] * pinchMult
                            );
                        }
                        break;
                    }
                    case 'fly': {
                        // desktop
                        tmpV1.copy(controller._axis).normalize();
                        controller.left.add(
                            tmpV1.x * moveMult,
                            tmpV1.z * moveMult,
                            -tmpV1.y * moveMult
                        );
                        controller.right.add(
                            mouse[0] * lookMult,
                            mouse[1] * lookMult,
                            0
                        );

                        // mobile
                        controller.left.add(
                            left[0] * moveMult,
                            left[1] * moveMult,
                            0
                        );
                        controller.right.add(
                            right[0] * lookMult,
                            right[1] * lookMult,
                            0
                        );
                        break;
                    }
                }
            },

            clear: () => {
                controller.left.clear();
                controller.right.clear();
            }
        };

        // setup joystick events
        const joystick = {
            base: null,
            stick: null
        };
        flyInput.leftJoystick.on('position:base', (x, y) => {
            joystick.base = [x, y];
        });
        flyInput.leftJoystick.on('position:stick', (x, y) => {
            const dx = x - joystick.base[0];
            const dy = y - joystick.base[1];
            joystick.stick = [dx, dy];
        });
        flyInput.leftJoystick.on('reset', () => {
            joystick.base = null;
            joystick.stick = null;
        });

        // transition time between cameras
        let transitionTimer = 0;

        // the previous camera we're transitioning away from
        const prevPose = new Pose();
        let prevCamera = null;
        let prevCameraMode = 'orbit';

        // handle input events
        events.on('inputEvent', (eventName, event) => {
            const doReset = (pose) => {
                if (state.cameraMode === 'anim') {
                    state.cameraMode = prevCameraMode;
                }

                if (state.cameraMode === 'orbit') {
                    orbitCamera.reset(pose, false);
                } else if (state.cameraMode === 'fly') {
                    flyCamera.reset(pose, false);
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
            controller.update(deltaTime);

            // update touch joystick UI
            if (state.cameraMode === 'fly') {
                events.fire('touchJoystickUpdate', joystick.base, joystick.stick);
            }

            // update the active camera
            const input = {
                move: controller.left,
                rotate: controller.right
            };

            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' ?
                (state.animationPaused ? 0 : deltaTime * transitionTimer) :
                deltaTime;

            const activeCamera = getCamera(state.cameraMode);
            activeCamera.update(dt, state.cameraMode !== 'anim' && input);
            activeCamera.getPose(pose);

            // controls have been consumed
            controller.clear();

            if (state.cameraMode === 'anim') {
                state.animationTime = animCamera.cursor.value;
            }

            // blend camera smoothly during transitions
            if (transitionTimer < 1) {
                transitionTimer = Math.min(1, transitionTimer + deltaTime);

                if (transitionTimer < 1 && prevCamera) {
                    const x = transitionTimer;
                    // ease out exponential
                    const norm = 1 - (2 ** -10);
                    const weight = (1 - (2 ** (-10 * x))) / norm;
                    pose.lerp(prevPose, pose, weight);
                }
            }

            // snap camera
            activePose.copy(pose);

            // apply to camera
            entity.setPosition(activePose.position);
            entity.setRotation(activePose.rotation);
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            prevCameraMode = prev;
            prevCamera = getCamera(prev);
            prevCamera.getPose(prevPose);

            switch (value) {
                case 'orbit':
                case 'fly':
                    getCamera(value).reset(pose);
                    break;
            }

            // reset camera transition timer
            transitionTimer = 0;
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
        let picker = null;
        events.on('inputEvent', async (eventName, event) => {
            if (state.cameraMode === 'orbit' && eventName === 'dblclick') {
                if (!picker) {
                    picker = new Picker(app, entity);
                }
                const result = await picker.pick(event.clientX, event.clientY);
                if (result) {
                    // get the current pose
                    orbitCamera.getPose(pose);
                    pose.fromLookAt(pose.position, result);
                    orbitCamera.reset(pose, false);
                }
            }
        });

        // initialize the camera entity to initial position and kick off the
        // first scene sort (which usually happens during render)
        entity.setPosition(activePose.position);
        entity.setRotation(activePose.rotation);
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
