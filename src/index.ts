import '@playcanvas/web-components';
import type { AppElement, EntityElement } from '@playcanvas/web-components';
import {
    Asset,
    Color,
    Entity,
    EventHandler,
    MiniStats,
    Quat,
    ShaderChunks,
    Vec3,
    type TextureHandler,
    type Texture,
    type AppBase,
    type CameraComponent
} from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr-controllers.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr-navigation.mjs';

import { importSettings } from './settings';
import { observe } from './core/observe';
import { Viewer } from './viewer';
import { initUI } from './ui';

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

// displays a blurry poster image which resolves to sharp during loading
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

// On entering/exiting AR, we need to set the camera clear color to transparent black
const initXr = (app: AppBase, camera: Entity, state: any, events: EventHandler) => {

    // initialize ar/vr
    app.xr.on('available:immersive-ar', (available) => {
        state.hasAR = available;
    });
    app.xr.on('available:immersive-vr', (available) => {
        state.hasVR = available;
    });

    const parent = camera.parent as Entity;
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
        app.xr.start(app.root.findComponent('camera') as CameraComponent, 'immersive-ar', 'local-floor');
    });

    events.on('startVR', () => {
        app.xr.start(app.root.findComponent('camera') as CameraComponent, 'immersive-vr', 'local-floor');
    });

    events.on('inputEvent', (event) => {
        if (event === 'cancel' && app.xr.active) {
            app.xr.end();
        }
    });
};

const loadContent = (app: AppBase) => {
    const { contentUrl, contents } = window.sse;

    const filename = new URL(contentUrl, location.href).pathname.split('/').pop();

    const asset = new Asset(filename, 'gsplat', {
        url: contentUrl,
        filename,
        contents
    });

    asset.on('load', () => {
        const entity = new Entity('gsplat');
        entity.setLocalEulerAngles(0, 0, 180);
        entity.addComponent('gsplat', { asset });
        app.root.addChild(entity);
    });

    asset.on('error', (err) => {
        console.log(err);
    });

    app.assets.add(asset);
    app.assets.load(asset);
};

const waitForGsplat = (app: AppBase, state: any) => {
    return new Promise((resolve) => {
        const assets = app.assets.filter(asset => asset.type === 'gsplat');
        if (assets.length > 0) {
            const asset = assets[0];

            let watermark = 0;

            asset.on('progress', (received, length) => {
                const progress = Math.min(1, received / length) * 100;
                if (progress > watermark) {
                    watermark = progress;
                    state.progress = watermark.toFixed(0);
                }
            });

            if (asset.loaded) {
                resolve(asset);
            } else {
                asset.on('load', () => {
                    resolve(asset);
                });
            }
        }
    });
};

const main = async (app: AppBase, camera: Entity) => {
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

    loadContent(app);

    const params = window.sse?.params ?? {};
    const settings = importSettings(await window.sse?.settings);
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
    if (window.sse?.poster) {
        initPoster(events);
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
            app.scene.envAtlas = skyAsset.resource as Texture;
        });

        app.assets.add(skyAsset);
        app.assets.load(skyAsset);
    }

    // Construct ministats
    if (params.ministats) {
        // eslint-disable-next-line no-new
        new MiniStats(app);
    }

    // Initialize XR support
    initXr(app, camera, state, events);

    // Create the viewer
    const viewer = new Viewer(app, camera, events, state, settings, params);

    // Wait for gsplat asset to load before initializing the viewer
    waitForGsplat(app, state).then(() => viewer.initialize());

    // Initialize the user interface
    initUI(events, state, graphicsDevice.canvas);
};

// wait for dom content to finish loading
document.addEventListener('DOMContentLoaded', async () => {
    const appElement: AppElement = document.querySelector('pc-app');
    const app = (await appElement.ready()).app;
    const cameraElement = await (document.querySelector('pc-entity[name="camera"]') as EntityElement).ready();
    await main(app, cameraElement.entity);
});
