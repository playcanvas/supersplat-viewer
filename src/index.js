import '@playcanvas/web-components';
import { shaderChunks, Asset, BoundingBox, Color, EventHandler, Mat4, MiniStats, Vec3, Quat } from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr-controllers.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr-navigation.mjs';

import { AnimCamera } from './anim-camera.js';
import { migrateSettings } from './data-migrations.js';
import { FlyCamera } from './fly-camera.js';
import { AppController } from './input.js';
import { observe } from './observe.js';
import { OrbitCamera } from './orbit-camera.js';
import { Picker } from './picker.js';
import { PointerDevice } from './pointer-device.js';
import { Pose } from './pose.js';


const url = new URL(location.href);

// support overriding parameters by query param
const paramOverrides = {};
if (url.searchParams.has('noui')) paramOverrides.noui = true;
if (url.searchParams.has('noanim')) paramOverrides.noanim = true;
if (url.searchParams.has('poster')) paramOverrides.posterUrl = url.searchParams.get('poster');
if (url.searchParams.has('skybox')) paramOverrides.skyboxUrl = url.searchParams.get('skybox');
if (url.searchParams.has('ministats')) paramOverrides.ministats = true;

// get experience parameters
const params = {
    ...(window.sse?.params ?? {}),
    ...paramOverrides
};

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

// render skybox as plain equirect
shaderChunks.skyboxPS = shaderChunks.skyboxPS.replace('mapRoughnessUv(uv, mipLevel)', 'uv');

const v = new Vec3();
const pose = new Pose();

class Viewer {
    constructor(app, entity, events, state, settings) {
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

        // initialize the viewer after assets have finished loading
        events.on('loaded', () => this.initialize());
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

        // create the pointer device
        const pointerDevice = new PointerDevice(app.graphicsDevice.canvas);
        const controller = new AppController();

        // transition time between cameras
        let transitionTimer = 0;

        // the previous camera we're transitioning away from
        const prevPose = new Pose();
        let prevCamera = null;
        let prevCameraMode = 'orbit';

        // update the currently active controller
        const assignController = () => {
            switch (state.cameraMode) {
                case 'orbit':
                    pointerDevice.target = state.inputMode === 'touch' ? controller.orbit : controller.desktop;
                    break;
                case 'anim':
                    // for animated camera with lookaround, use the following:
                    // pointerDevice.target = state.inputMode === 'touch' ? controller.orbit : controller.desktop;

                    // no input to anim camera means no lookaround
                    pointerDevice.target = null;
                    break;
                case 'fly':
                    pointerDevice.target = state.inputMode === 'touch' ? controller.touch : controller.desktop;
                    break;
            }
        };

        assignController();

        // handle input mode changing (once user interacts with the app input
        // mode can switch to touch device)
        events.on('inputMode:changed', (value, prev) => {
            assignController();
        });

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

            // remap some desktop inputs based on camera mode
            if (state.cameraMode === 'orbit') {
                const { value } = controller.desktop.left.inputs[1];
                controller.left.value[0] -= value[0] * 2;
                controller.left.value[1] -= value[1] * 2;
            } else if (state.cameraMode === 'fly') {
                const { value } = controller.desktop.left.inputs[0];
                controller.left.value[1] -= value[1];
                controller.left.value[2] += value[1];
            }

            // update touch joystick UI
            const touchJoystick = controller.touch.left;
            if (touchJoystick.stick.every(v => v === 0)) {
                events.fire('touchJoystickUpdate', null);
            } else {
                events.fire('touchJoystickUpdate', touchJoystick.base, touchJoystick.stick);
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

            // reassign controller
            assignController();
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

// displays a blurry poster image which resolves to sharp during loading
const initPoster = (url, events) => {
    const blur = progress => `blur(${Math.floor((100 - progress) * 0.4)}px)`;

    const element = document.getElementById('poster');
    element.style.backgroundImage = `url(${url})`;
    element.style.display = 'block';
    element.style.filter = blur(0);

    events.on('progress:changed', (progress) => {
        element.style.filter = blur(progress);
    });

    events.on('firstFrame', () => {
        element.style.display = 'none';
    });
};

// On entering/exiting AR, we need to set the camera clear color to transparent black
const initXr = (app, cameraElement, state, events) => {

    // initialize ar/vr
    app.xr.on('available:immersive-ar', (available) => {
        state.hasAR = available;
    });
    app.xr.on('available:immersive-vr', (available) => {
        state.hasXR = available;
    });

    const parent = cameraElement.parentElement.entity;
    const camera = cameraElement.entity;
    const clearColor = new Color();

    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();
    const angles = new Vec3();

    parent.script.create(XrControllers);
    parent.script.create(XrNavigation);

    app.xr.on('start', () => {
        app.autoRender = true;

        // cache original camera rig positions and rotations
        parentPosition.copy(parent.getPosition());
        parentRotation.copy(parent.getRotation());
        cameraPosition.copy(camera.getPosition());
        cameraRotation.copy(camera.getRotation());

        cameraRotation.getEulerAngles(angles);

        // copy transform to parent to XR/VR mode starts in the right place
        parent.setPosition(cameraPosition.x, 0, cameraPosition.z);
        parent.setEulerAngles(0, angles.y, 0);

        if (app.xr.type === 'immersive-ar') {
            clearColor.copy(camera.camera.clearColor);
            camera.camera.clearColor = new Color(0, 0, 0, 0);
        }
    });

    app.xr.on('end', () => {
        app.autoRender = false;

        // restore camera to pre-XR state
        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);

        if (app.xr.type === 'immersive-ar') {
            camera.camera.clearColor = clearColor;
        }
    });

    events.on('startAR', () => {
        app.xr.start(app.root.findComponent('camera'), 'immersive-ar', 'local-floor');
    });

    events.on('startVR', () => {
        app.xr.start(app.root.findComponent('camera'), 'immersive-vr', 'local-floor');
    });

    events.on('inputEvent', (event) => {
        if (event === 'cancel' && app.xr.active) {
            app.xr.end();
        }
    });
};

const loadContent = (app) => {
    const { contentUrl } = window.sse;

    const asset = new Asset('scene.compressed.ply', 'gsplat', {
        url: contentUrl,
        filename: 'scene.compressed.ply'
    });

    asset.on('load', () => {
        const entity = asset.resource.instantiate();
        app.root.addChild(entity);
    });

    asset.on('error', (err) => {
        console.log(err);
    });

    app.assets.add(asset);
    app.assets.load(asset);
};

document.addEventListener('DOMContentLoaded', async () => {
    const appElement = document.querySelector('pc-app');
    const app = (await appElement.ready()).app;

    loadContent(app);

    const cameraElement = await document.querySelector('pc-entity[name="camera"]').ready();
    const camera = cameraElement.entity;
    const settings = migrateSettings(await window.sse?.settings);
    const events = new EventHandler();
    const state = observe(events, {
        readyToRender: false,       // don't render till this is set
        hqMode: true,
        progress: 0,
        inputMode: 'desktop',       // desktop, touch
        cameraMode: 'orbit',        // orbit, anim, fly
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: params.noanim,
        hasAR: app.xr.isAvailable('immersive-ar'),
        hasVR: app.xr.isAvailable('immersive-vr'),
        isFullscreen: false,
        uiVisible: true
    });

    // Initialize the load-time poster
    if (params.posterUrl) {
        initPoster(params.posterUrl, events);
    }

    // Initialize skybox
    if (params.skyboxUrl) {
        const skyAsset = new Asset('skybox', 'texture', {
            url: params.skyboxUrl
        }, {
            type: 'rgbp',
            mipmaps: false,
            addressu: 'repeat',
            addressv: 'clamp'
        });

        skyAsset.on('load', () => {
            app.scene.envAtlas = skyAsset.resource;
        });

        app.assets.add(skyAsset);
        app.assets.load(skyAsset);
    }

    // construct ministats
    if (params.ministats) {
        const miniStats = new MiniStats(app);
        miniStats.position = 'topright';
    }

    // Initialize XR support
    initXr(app, cameraElement, state, events);

    // eslint-disable-next-line no-unused-vars
    const viewer = new Viewer(app, camera, events, state, settings);

    // wait for gsplat asset to load before initializing the rest
    const assets = app.assets.filter(asset => asset.type === 'gsplat');
    if (assets.length > 0) {
        const asset = assets[0];

        asset.on('progress', (received, length) => {
            state.progress = (Math.min(1, received / length) * 100).toFixed(0);
        });

        if (asset.loaded) {
            events.fire('loaded', asset);
        } else {
            asset.on('load', () => {
                events.fire('loaded', asset);
            });
        }
    }

    // Get button and info panel elements
    const dom = [
        'ui',
        'controlsWrap',
        'arMode', 'vrMode',
        'enterFullscreen', 'exitFullscreen',
        'info', 'infoPanel', 'desktopTab', 'touchTab', 'desktopInfoPanel', 'touchInfoPanel',
        'timelineContainer', 'handle', 'time',
        'buttonContainer',
        'play', 'pause',
        'settings', 'settingsPanel',
        'fly', 'orbit', 'cameraToggleHighlight',
        'high', 'low', 'qualityToggleHighlight',
        'reset', 'frame',
        'loadingText', 'loadingBar',
        'joystickBase', 'joystick'
    ].reduce((acc, id) => {
        acc[id] = document.getElementById(id);
        return acc;
    }, {});

    // Handle loading progress updates
    events.on('progress:changed', (progress) => {
        dom.loadingText.textContent = `${progress}%`;
        if (progress < 100) {
            dom.loadingBar.style.backgroundImage = `linear-gradient(90deg, #F60 0%, #F60 ${progress}%, white ${progress}%, white 100%)`;
        } else {
            dom.loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 100%)';
        }
    });

    // Hide loading bar once first frame is rendered
    events.on('firstFrame', () => {
        document.getElementById('loadingWrap').classList.add('hidden');
    });

    // Fullscreen support
    const docRoot = document.documentElement;
    const hasFullscreenAPI = docRoot.requestFullscreen && document.exitFullscreen;

    const requestFullscreen = () => {
        if (hasFullscreenAPI) {
            docRoot.requestFullscreen();
        } else {
            window.parent.postMessage('requestFullscreen', '*');
            state.isFullscreen = true;
        }
    };

    const exitFullscreen = () => {
        if (hasFullscreenAPI) {
            document.exitFullscreen();
        } else {
            window.parent.postMessage('exitFullscreen', '*');
            state.isFullscreen = false;
        }
    };

    if (hasFullscreenAPI) {
        document.addEventListener('fullscreenchange', () => {
            state.isFullscreen = !!document.fullscreenElement;
        });
    }

    dom.enterFullscreen.addEventListener('click', requestFullscreen);
    dom.exitFullscreen.addEventListener('click', exitFullscreen);

    // toggle fullscreen when user switches between landscape portrait
    // orientation
    screen?.orientation?.addEventListener('change', (event) => {
        if (['landscape-primary', 'landscape-secondary'].includes(screen.orientation.type)) {
            requestFullscreen();
        } else {
            exitFullscreen();
        }
    });

    // update UI when fullscreen state changes
    events.on('isFullscreen:changed', (value) => {
        dom.enterFullscreen.classList[value ? 'add' : 'remove']('hidden');
        dom.exitFullscreen.classList[value ? 'remove' : 'add']('hidden');
    });

    // HQ mode
    dom.high.addEventListener('click', () => {
        state.hqMode = true;
    });
    dom.low.addEventListener('click', () => {
        state.hqMode = false;
    });

    const updateHQ = () => {
        dom.qualityToggleHighlight.classList[state.hqMode ? 'add' : 'remove']('right');
    };
    events.on('hqMode:changed', (value) => {
        updateHQ();
    });
    updateHQ();

    // AR/VR
    const arChanged = () => dom.arMode.classList[state.hasAR ? 'remove' : 'add']('hidden');
    const vrChanged = () => dom.vrMode.classList[state.hasVR ? 'remove' : 'add']('hidden');

    dom.arMode.addEventListener('click', () => events.fire('startAR'));
    dom.vrMode.addEventListener('click', () => events.fire('startVR'));

    events.on('hasAR:changed', arChanged);
    events.on('hasVR:changed', vrChanged);

    arChanged();
    vrChanged();

    // Info panel
    const updateInfoTab = (tab) => {
        if (tab === 'desktop') {
            dom.desktopTab.classList.add('active');
            dom.touchTab.classList.remove('active');
            dom.desktopInfoPanel.classList.remove('hidden');
            dom.touchInfoPanel.classList.add('hidden');
        } else {
            dom.desktopTab.classList.remove('active');
            dom.touchTab.classList.add('active');
            dom.desktopInfoPanel.classList.add('hidden');
            dom.touchInfoPanel.classList.remove('hidden');
        }
    };

    dom.desktopTab.addEventListener('click', () => {
        updateInfoTab('desktop');
    });

    dom.touchTab.addEventListener('click', () => {
        updateInfoTab('touch');
    });

    dom.info.addEventListener('pointerup', () => {
        updateInfoTab(state.inputMode);
        dom.infoPanel.classList.toggle('hidden');
    });

    dom.infoPanel.addEventListener('pointerdown', () => {
        dom.infoPanel.classList.add('hidden');
    });

    events.on('inputEvent', (event) => {
        if (event === 'cancel') {
            // close info panel on cancel
            dom.infoPanel.classList.add('hidden');
            dom.settingsPanel.classList.add('hidden');

            // close fullscreen on cancel
            if (state.isFullscreen) {
                exitFullscreen();
            }
        } else if (event === 'interrupt') {
            dom.settingsPanel.classList.add('hidden');
        }
    });

    // fade ui controls after 5 seconds of inactivity
    events.on('uiVisible:changed', (value) => {
        dom.controlsWrap.className = value ? 'faded-in' : 'faded-out';
    });

    // show the ui and start a timer to hide it again
    let uiTimeout = null;
    const showUI = () => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
        }
        state.uiVisible = true;
        uiTimeout = setTimeout(() => {
            uiTimeout = null;
            state.uiVisible = false;
        }, 4000);
    };
    showUI();

    events.on('inputEvent', showUI);

    // Animation controls
    events.on('hasAnimation:changed', (value, prev) => {
        // Start and Stop animation
        dom.play.addEventListener('click', () => {
            state.cameraMode = 'anim';
            state.animationPaused = false;
        });

        dom.pause.addEventListener('click', () => {
            state.cameraMode = 'anim';
            state.animationPaused = true;
        });

        const updatePlayPause = () => {
            if (state.cameraMode !== 'anim' || state.animationPaused) {
                dom.play.classList.remove('hidden');
                dom.pause.classList.add('hidden');
            } else {
                dom.play.classList.add('hidden');
                dom.pause.classList.remove('hidden');
            }

            if (state.cameraMode === 'anim') {
                dom.timelineContainer.classList.remove('hidden');
            } else {
                dom.timelineContainer.classList.add('hidden');
            }
        };

        // Update UI on animation changes
        events.on('cameraMode:changed', updatePlayPause);
        events.on('animationPaused:changed', updatePlayPause);

        // Spacebar to play/pause
        events.on('inputEvent', (eventName) => {
            if (eventName === 'playPause') {
                state.cameraMode = 'anim';
                state.animationPaused = !state.animationPaused;
            }
        });

        const updateSlider = () => {
            dom.handle.style.left = `${state.animationTime / state.animationDuration * 100}%`;
            dom.time.style.left = `${state.animationTime / state.animationDuration * 100}%`;
            dom.time.innerText = `${state.animationTime.toFixed(1)}s`;
        };

        events.on('animationTime:changed', updateSlider);
        events.on('animationLength:changed', updateSlider);

        const handleScrub = (event) => {
            const rect = dom.timelineContainer.getBoundingClientRect();
            const t = Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left)) / rect.width;
            events.fire('setAnimationTime', state.animationDuration * t);
        };

        let paused = false;
        let captured = false;

        dom.timelineContainer.addEventListener('pointerdown', (event) => {
            if (!captured) {
                handleScrub(event);
                dom.timelineContainer.setPointerCapture(event.pointerId);
                dom.time.classList.remove('hidden');
                paused = state.animationPaused;
                state.animationPaused = true;
                captured = true;
            }
        });

        dom.timelineContainer.addEventListener('pointermove', (event) => {
            if (captured) {
                handleScrub(event);
            }
        });

        dom.timelineContainer.addEventListener('pointerup', (event) => {
            if (captured) {
                dom.timelineContainer.releasePointerCapture(event.pointerId);
                dom.time.classList.add('hidden');
                state.animationPaused = paused;
                captured = false;
            }
        });
    });

    // Camera mode UI
    const updateCameraMode = () => {
        if (state.cameraMode === 'fly') {
            dom.cameraToggleHighlight.classList.add('right');
        } else {
            dom.cameraToggleHighlight.classList.remove('right');
        }
    };
    events.on('cameraMode:changed', updateCameraMode);

    dom.settings.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('hidden');
    });

    dom.fly.addEventListener('click', () => {
        state.cameraMode = 'fly';
    });

    dom.orbit.addEventListener('click', () => {
        state.cameraMode = 'orbit';
    });

    dom.reset.addEventListener('click', (event) => {
        events.fire('inputEvent', 'reset', event);
    });

    dom.frame.addEventListener('click', (event) => {
        events.fire('inputEvent', 'frame', event);
    });

    // update UI based on touch joystick updates
    events.on('touchJoystickUpdate', (base, stick) => {
        if (base === null) {
            dom.joystickBase.classList.add('hidden');
        } else {
            v.set(stick[0], stick[1], 0).mulScalar(1 / 48);
            if (v.length() > 1) {
                v.normalize();
            }
            v.mulScalar(48);

            dom.joystickBase.classList.remove('hidden');
            dom.joystickBase.style.left = `${base[0]}px`;
            dom.joystickBase.style.top = `${base[1]}px`;
            dom.joystick.style.left = `${48 + v.x}px`;
            dom.joystick.style.top = `${48 + v.y}px`;
        }
    });

    // Hide UI
    if (params.noui) {
        dom.ui.classList.add('hidden');
    }

    // Generate input events

    ['wheel', 'pointerdown', 'contextmenu', 'keydown'].forEach((eventName) => {
        app.graphicsDevice.canvas.addEventListener(eventName, (event) => {
            events.fire('inputEvent', 'interrupt', event);
        });
    });

    app.graphicsDevice.canvas.addEventListener('pointermove', (event) => {
        events.fire('inputEvent', 'interact', event);
    });

    // we must detect double taps manually because ios doesn't send dblclick events
    const lastTap = { time: 0, x: 0, y: 0 };
    app.graphicsDevice.canvas.addEventListener('pointerdown', (event) => {
        const curTap = new Date().getTime();
        const delay = Math.max(0, curTap - lastTap.time);
        if (delay < 300 &&
            Math.abs(event.clientX - lastTap.x) < 8 &&
            Math.abs(event.clientY - lastTap.y) < 8) {
            events.fire('inputEvent', 'dblclick', event);
            lastTap.time = 0;
        } else {
            lastTap.time = curTap;
            lastTap.x = event.clientX;
            lastTap.y = event.clientY;
        }
    });

    // update input mode based on pointer event
    ['pointerdown', 'pointermove'].forEach((eventName) => {
        window.addEventListener(eventName, (event) => {
            state.inputMode = event.pointerType === 'touch' ? 'touch' : 'desktop';
        });
    });

    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            events.fire('inputEvent', 'cancel', event);
        } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
            switch (event.key) {
                case 'f':
                    events.fire('inputEvent', 'frame', event);
                    break;
                case 'r':
                    events.fire('inputEvent', 'reset', event);
                    break;
                case ' ':
                    events.fire('inputEvent', 'playPause', event);
                    break;
            }
        }
    });
});
