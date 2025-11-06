import {
    BoundingBox,
    Color,
    type Entity,
    Mat4,
    MiniStats,
    ShaderChunks,
    type TextureHandler
} from 'playcanvas';

import { CameraManager } from './camera-manager';
import { Camera } from './cameras/camera';
import { nearlyEquals } from './core/math';
import { InputController } from './input-controller';
import type { Global } from './types';

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

class Viewer {
    global: Global;

    inputController: InputController;

    cameraManager: CameraManager;

    constructor(global: Global, gsplatLoad: Promise<Entity>, skyboxLoad: Promise<void>) {
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
        camera.camera.aspectRatio = graphicsDevice.width / graphicsDevice.height;

        // handle horizontal fov on canvas resize
        const updateHorizontalFov = () => {
            camera.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
            app.renderNextFrame = true;
        };
        graphicsDevice.on('resizecanvas', updateHorizontalFov);
        updateHorizontalFov();

        // handle HQ mode changes
        const updateHqMode = () => {
            graphicsDevice.maxPixelRatio = state.hqMode ? window.devicePixelRatio : 1;
            app.renderNextFrame = true;
        };
        events.on('hqMode:changed', updateHqMode);
        updateHqMode();

        // Construct debug ministats
        if (config.ministats) {
            // eslint-disable-next-line no-new
            new MiniStats(app);
        }

        const prevProj = new Mat4();
        const prevWorld = new Mat4();

        // track camera movement and trigger render only when it changes
        app.on('framerender', () => {
            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;

            if (!app.renderNextFrame) {
                if (config.ministats ||
                    !nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }
        });

        const applyCamera = (camera: Camera) => {
            global.camera.setPosition(camera.position);
            global.camera.setEulerAngles(camera.angles);
            global.camera.camera.fov = camera.fov;
        };

        // handle application update
        app.on('update', (deltaTime) => {
            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            if (this.inputController && this.cameraManager) {
                // update inputs
                this.inputController.update(deltaTime, this.cameraManager.camera.distance);

                // update cameras
                this.cameraManager.update(deltaTime, this.inputController.frame);

                // apply to the camera entity
                applyCamera(this.cameraManager.camera);
            }
        });

        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad]).then((results) => {
            const gsplat = results[0] as Entity;

            // calculate scene bounding box
            const bbox = gsplat.gsplat?.instance?.meshInstance?.aabb ?? new BoundingBox();

            this.inputController = new InputController(global);

            this.cameraManager = new CameraManager(global, bbox);
            applyCamera(this.cameraManager.camera);

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
        });
    }
}

export { Viewer };
