import '@playcanvas/web-components';
import type { AppElement, EntityElement } from '@playcanvas/web-components';
import {
    Asset,
    Entity,
    EventHandler,
    type Texture,
    type AppBase
} from 'playcanvas';

import { observe } from './core/observe';
import { importSettings } from './settings';
import { Global } from './types';
import { initPoster, initUI } from './ui';
import { Viewer } from './viewer';
import { initXr } from './xr';

const loadGsplat = async (app: AppBase, url: string, contents: Promise<Response>, progressCallback: (progress: number) => void) => {
    const c = contents as unknown as ArrayBuffer;
    const filename = new URL(url, location.href).pathname.split('/').pop();
    const data = filename.endsWith('meta.json') ? await (await contents).json() : undefined;
    const asset = new Asset(filename, 'gsplat', { url, filename, contents: c }, data);

    return new Promise<Entity>((resolve, reject) => {
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
        camera
    };
};

const main = async (global: Global) => {
    const { app, events, config, state, camera } = global;

    // Initialize the load-time poster
    if (config.poster) {
        initPoster(events);
    }

    // Initialize XR support
    initXr(global);

    // Initialize user interface
    initUI(global);

    // Load model
    const gsplatLoad = loadGsplat(
        app,
        config.contentUrl,
        config.contents,
        (progress: number) => {
            state.progress = progress;
        }
    );

    // Load skybox
    const skyboxLoad = config.skyboxUrl &&
        loadSkybox(app, config.skyboxUrl).then((asset) => {
            app.scene.envAtlas = asset.resource as Texture;
        });

    // Create the viewer
    const viewer = new Viewer(global, gsplatLoad, skyboxLoad);
};

// wait for dom content to finish loading
document.addEventListener('DOMContentLoaded', async () => {
    const appElement = await (document.querySelector('pc-app') as AppElement).ready();
    const cameraElement = await (document.querySelector('pc-entity[name="camera"]') as EntityElement).ready();
    const global = await initGlobal(appElement.app, cameraElement.entity);
    await main(global);
});
