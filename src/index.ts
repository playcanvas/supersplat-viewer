import '@playcanvas/web-components';
import type { AppElement, EntityElement } from '@playcanvas/web-components';
import {
    Asset,
    Color,
    Entity,
    EventHandler,
    Mat4,
    MiniStats,
    ShaderChunks,
    type TextureHandler,
    type Texture,
    type AppBase
} from 'playcanvas';

import { observe } from './core/observe';
import { importSettings } from './settings';
import { Global } from './types';
import { initUI } from './ui';
import { Viewer } from './viewer';
import { initXr } from './xr';

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

const initApp = (global: Global) => {
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
};

// display a poster image which starts blurry and then resolves to sharp during loading
const initPoster = (events: EventHandler) => {
    const element = document.getElementById('poster');
    const blur = (progress: number) => `blur(${Math.floor((100 - progress) * 0.4)}px)`;

    events.on('progress:changed', (progress: number) => {
        element.style.filter = blur(progress);
    });

    events.on('firstFrame', () => {
        element.style.display = 'none';
    });
};

const loadGsplat = (app: AppBase, url: string, contents: Promise<Response>, progressCallback: (progress: number) => void) => {
    const c = contents as unknown as ArrayBuffer;

    return new Promise<Entity>((resolve, reject) => {
        const filename = new URL(url, location.href).pathname.split('/').pop();
        const asset = new Asset(filename, 'gsplat', { url, filename, contents: c });

        asset.on('load', () => {
            const entity = new Entity('gsplat');
            entity.setLocalEulerAngles(0, 0, 180);
            entity.addComponent('gsplat', { asset });
            app.root.addChild(entity);
            resolve(entity);
        });

        let watermark = 0;
        asset.on('progress', (received, length) => {
            const progress = Math.min(1, received / length) * 100;
            if (progress > watermark) {
                watermark = progress;
                progressCallback(Math.trunc(watermark));
            }
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

const loadSkybox = (app: AppBase, url: string) => {
    return new Promise<Asset>((resolve, reject) => {
        const asset = new Asset('skybox', 'texture', {
            url
        }, {
            type: 'rgbp',
            mipmaps: false,
            addressu: 'repeat',
            addressv: 'clamp'
        });

        asset.on('load', () => {
            resolve(asset);
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

// initialize global config and state
const initGlobal = async (app: AppBase, camera: Entity): Promise<Global> => {
    const sse: any = window.sse ?? {};
    const params = sse.params ?? {};
    const settings = importSettings(await sse.settings);
    const events = new EventHandler();

    const config = {
        noui: !!(params.noui || false),
        ministats: !!(params.ministats || false),
        skyboxUrl: params.skyboxUrl,
        poster: sse.poster,
        contentUrl: sse.contentUrl,
        contents: sse.contents
    };

    // construct the observable state
    const state = observe(events, {
        readyToRender: false,
        hqMode: true,
        progress: 0,
        inputMode: 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: params.noanim,
        hasAR: app.xr.isAvailable('immersive-ar'),
        hasVR: app.xr.isAvailable('immersive-vr'),
        isFullscreen: false,
        controlsHidden: false
    });

    return {
        app,
        settings,
        config,
        state,
        events,
        camera,
        gsplat: null
    };
};

const main = async (global: Global) => {
    const { app, events, config, state, camera } = global;

    initApp(global);

    // Initialize the load-time poster
    if (config.poster) {
        initPoster(events);
    }

    const promises = [];

    // start loading content
    promises.push(loadGsplat(
        app,
        config.contentUrl,
        config.contents,
        (progress: number) => {
            state.progress = progress;
        }
    ));

    // Initialize skybox
    if (config.skyboxUrl) {
        promises.push(loadSkybox(app, config.skyboxUrl).then((asset) => {
            app.scene.envAtlas = asset.resource as Texture;
        }));
    }

    // Initialize XR support
    initXr(app, camera, state, events);

    // Initialize the user interface
    initUI(events, state, config, app.graphicsDevice.canvas);

    // Wait for loads to complete
    const loadResults = await Promise.all(promises);

    global.gsplat = loadResults[0] as Entity;

    // Create the viewer
    const viewer = new Viewer(global);

    // kick off gsplat sorting immediately now that camera is in position
    global.gsplat.gsplat?.instance?.sort(camera);

    // listen for sorting updates to trigger first frame events
    global.gsplat.gsplat?.instance?.sorter?.on('updated', () => {
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
};

// wait for dom content to finish loading
document.addEventListener('DOMContentLoaded', async () => {
    const appElement = await (document.querySelector('pc-app') as AppElement).ready();
    const cameraElement = await (document.querySelector('pc-entity[name="camera"]') as EntityElement).ready();
    const global = await initGlobal(appElement.app, cameraElement.entity);
    await main(global);
});
