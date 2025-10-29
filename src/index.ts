import '@playcanvas/web-components';
import type { AppElement, EntityElement } from '@playcanvas/web-components';
import {
    Asset,
    Entity,
    EventHandler,
    MiniStats,
    ShaderChunks,
    type TextureHandler,
    type Texture,
    type AppBase
} from 'playcanvas';

import { observe } from './core/observe';
import { importSettings } from './settings';
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

const loadContent = (app: AppBase, contentUrl: string, contents: ArrayBuffer, progressCallback: (progress: number) => void) => {
    return new Promise((resolve, reject) => {
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

const main = async (app: AppBase, camera: Entity) => {
    const { sse } = window;
    const params = sse?.params ?? {};
    const settingsJson = await sse?.settings;
    const settings = importSettings(settingsJson);
    const events = new EventHandler();

    // construct the observable state
    const state = observe(events, {
        readyToRender: false,       // don't render till this is set
        noui: params.noui || false,
        hqMode: true,
        progress: 0,                // content loading progress 0-100
        inputMode: 'desktop',       // desktop, touch
        cameraMode: 'orbit',        // orbit, anim, fly
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: params.noanim,
        hasAR: app.xr.isAvailable('immersive-ar'),
        hasVR: app.xr.isAvailable('immersive-vr'),
        isFullscreen: false,
        controlsHidden: false
    });

    // start loading content
    const loadPromise = loadContent(
        app,
        sse.contentUrl,
        sse.contents,
        (progress: number) => {
            state.progress = progress;
        }
    );

    // Initialize the load-time poster
    if (sse?.poster) {
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

    // Initialize the user interface
    initUI(events, state, app.graphicsDevice.canvas);

    // Create the viewer
    const viewer = new Viewer(app, camera, events, state, settings, params);

    // Wait for gsplat asset to load before initializing the viewer
    await loadPromise;

    viewer.initialize();
};

// wait for dom content to finish loading
document.addEventListener('DOMContentLoaded', async () => {
    const appElement: AppElement = document.querySelector('pc-app');
    const app = (await appElement.ready()).app;

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

    const cameraElement = await (document.querySelector('pc-entity[name="camera"]') as EntityElement).ready();

    await main(app, cameraElement.entity);
});
