import {
    Asset,
    Color,
    createGraphicsDevice,
    Entity,
    EventHandler,
    Keyboard,
    Mouse,
    platform,
    TouchDevice,
    revision as engineRevision,
    version as engineVersion
} from 'playcanvas';
import type { Texture, TextureHandler, AppBase } from 'playcanvas';

import { App } from './app';
import { MeshCollision, loadVoxelCollision } from './collision';
import type { Collision } from './collision';
import { observe } from './core/observe';
import { initLocalization } from './localization';
import { importSettings } from './settings';
import type { Config, Global, State } from './types';
import { initPoster, initUI } from './ui';
import { Viewer } from './viewer';
import { initXr } from './xr';
import { version as appVersion } from '../package.json';

const loadGsplat = async (app: AppBase, config: Config, progressCallback: (progress: number) => void) => {
    const { contents, contentUrl, contentFilename } = config;
    const c = contents as unknown as ArrayBuffer;
    // the filename's extension selects the gsplat parser, so a url with no usable name (a
    // data: uri) needs the config to name its content instead; falsy (an empty name) falls
    // back to the url-derived name
    const filename = contentFilename || new URL(contentUrl, location.href).pathname.split('/').pop();
    const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;
    const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename, contents: c }, data);

    return new Promise<Entity>((resolve, reject) => {
        asset.on('load', () => {
            const entity = new Entity('gsplat');
            entity.setLocalEulerAngles(0, 0, 180);
            entity.addComponent('gsplat', {
                unified: true,
                asset
            });
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
        const asset = new Asset(
            'skybox',
            'texture',
            {
                url
            },
            {
                type: 'rgbp',
                mipmaps: false,
                addressu: 'repeat',
                addressv: 'clamp'
            }
        );

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

const createApp = async (canvas: HTMLCanvasElement, config: Config) => {
    const useWebGPU = config.renderer === 'webgpu';

    // Create the graphics device. The engine auto-appends WebGL2/null fallbacks
    // when WebGPU isn't supported. Request xrCompatible so the device — WebGPU
    // (via XRGPUBinding) or the WebGL fallback — is usable for AR/VR.
    const device = await createGraphicsDevice(canvas, {
        deviceTypes: useWebGPU ? ['webgpu'] : [],
        antialias: false,
        depth: true,
        stencil: false,
        xrCompatible: true,
        powerPreference: 'high-performance'
    });

    console.log(`Renderer: ${device.deviceType}`);

    // The engine may have fallen back from WebGPU to WebGL2; downstream code
    // (voxel overlay, XR, gsplat renderer selection) needs the *actual* renderer.
    const renderer: 'webgl' | 'webgpu' = device.deviceType === 'webgpu' ? 'webgpu' : 'webgl';

    // Set maxPixelRatio so the XR framebuffer scale factor is computed correctly.
    // Regular rendering bypasses maxPixelRatio via the custom initCanvas sizing.
    device.maxPixelRatio = window.devicePixelRatio;

    // Create the application
    const app = new App(canvas, {
        graphicsDevice: device,
        mouse: new Mouse(canvas),
        touch: new TouchDevice(canvas),
        keyboard: new Keyboard(window)
    });

    // enable anonymous CORS for image loading in safari (must be set before any
    // texture asset starts loading, otherwise the <img> is fetched without the
    // crossorigin attribute and WebGL rejects it with SecurityError)
    (app.loader.getHandler('texture') as TextureHandler).imgParser.crossOrigin = 'anonymous';

    // Create entity hierarchy
    const cameraRoot = new Entity('camera root');
    app.root.addChild(cameraRoot);

    const camera = new Entity('camera');
    cameraRoot.addChild(camera);

    const light = new Entity('light');
    light.setEulerAngles(35, 45, 0);
    light.addComponent('light', {
        color: new Color(1.0, 0.98, 0.957),
        intensity: 1
    });
    app.root.addChild(light);

    app.scene.ambientLight.set(0.51, 0.55, 0.65);

    return { app, camera, renderer };
};

// measure the canvas's css size. a hidden canvas (e.g. inside a display:none
// iframe) measures 0×0 — resizeCanvas skips those, keeping the current backing
// size until the resize observer reports a real layout
const measureCanvas = (canvas: HTMLCanvasElement) => ({
    width: canvas.clientWidth,
    height: canvas.clientHeight
});

// size the canvas backbuffer from a css size: scaled by the pixel ratio (capped to
// limit resolution on high-DPI devices), halved in performance mode. a zero css size
// (hidden canvas) is skipped — the canvas keeps its previous size, as a zero-sized
// swap chain is invalid in webgpu.
const resizeCanvas = (
    canvas: HTMLCanvasElement,
    cssSize: { width: number; height: number },
    performanceMode: boolean
) => {
    if (!cssSize.width || !cssSize.height) return;

    // maximum pixel dimension we will allow along the shortest screen dimension based on platform
    const maxPixelDim = platform.mobile ? 1080 : 2160;
    const pixelRatio = Math.min(maxPixelDim / Math.min(screen.width, screen.height), window.devicePixelRatio);

    const scale = pixelRatio * (performanceMode ? 0.5 : 1.0);
    const width = Math.ceil(cssSize.width * scale);
    const height = Math.ceil(cssSize.height * scale);
    if (width !== canvas.width || height !== canvas.height) {
        canvas.width = width;
        canvas.height = height;
    }
};

// initialize canvas size and resizing
const initCanvas = (global: Global) => {
    const { app, events, state } = global;
    const { canvas } = app.graphicsDevice;

    // the canvas css size, kept current by the resize observer. measured directly at
    // startup so the first frames are sized before the observer's first delivery.
    const cssSize = measureCanvas(canvas);

    const apply = () => {
        // don't resize the canvas during XR - the XR system manages its own framebuffers
        // and resetting canvas dimensions can invalidate the XRWebGLLayer
        if (app.xr?.active) return;

        resizeCanvas(canvas, cssSize, state.performanceMode);
    };

    const resizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
        const e = entries[0]?.contentBoxSize?.[0];
        // ignore hidden deliveries (0×0), keeping the last real size
        if (e && e.inlineSize && e.blockSize) {
            cssSize.width = e.inlineSize;
            cssSize.height = e.blockSize;
            app.renderNextFrame = true;
        }
    });
    resizeObserver.observe(canvas);

    events.on('performanceMode:changed', () => {
        app.renderNextFrame = true;
    });

    // Resize canvas before render() so the swap chain texture is acquired at the correct size.
    app.on('framerender', apply);

    // Disable the engine's built-in canvas resize — we handle it via ResizeObserver
    (app as unknown as { _allowResize: boolean })._allowResize = false;
    apply();
};

const main = async (canvas: HTMLCanvasElement, settingsJson: unknown, config: Config) => {
    // migrate legacy `retinaDisplay` preference (inverted) to `performanceMode`
    const legacyRetina = localStorage.getItem('retinaDisplay');
    if (legacyRetina !== null && localStorage.getItem('performanceMode') === null) {
        localStorage.setItem('performanceMode', String(legacyRetina === 'false'));
        localStorage.removeItem('retinaDisplay');
    }
    const storedPerformanceMode = localStorage.getItem('performanceMode');
    const performanceMode = storedPerformanceMode !== null ? storedPerformanceMode === 'true' : platform.mobile;

    // size the canvas backbuffer before the graphics device is created, so the swap
    // chain and any backbuffer-sized resources start at the correct resolution instead
    // of being recreated on the first frame's resize. a hidden embed keeps the default
    // canvas size here; the resize observer sizes it on reveal
    resizeCanvas(canvas, measureCanvas(canvas), performanceMode);

    const { app, camera, renderer } = await createApp(canvas, config);

    // create events
    const events = new EventHandler();

    const state = observe<State>(events, {
        loaded: false,
        performanceMode,
        progress: 0,
        inputMode: platform.mobile ? 'touch' : 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        hasAR: false,
        hasVR: false,
        hasCollision: false,
        hasCollisionOverlay: false,
        walkAllowed: false,
        collisionOverlayEnabled: false,
        isFullscreen: false,
        controlsHidden: false,
        showAnnotations: localStorage.getItem('showAnnotations') !== 'false',
        gamingControls: localStorage.getItem('gamingControls') === 'true'
    });

    const global: Global = {
        app,
        settings: importSettings(settingsJson),
        config,
        state,
        events,
        camera,
        renderer
    };

    initCanvas(global);

    // start the application
    app.start();

    // Initialize the load-time poster
    if (config.poster) {
        initPoster(events);
    }

    camera.addComponent('camera');

    // Initialize XR support (any backend; when the current device can't host a
    // session the UI can offer a reload into WebGL instead)
    initXr(global);

    // Initialize user interface
    initLocalization(config.lang);
    initUI(global);

    // Load model
    const gsplatLoad = loadGsplat(app, config, (progress: number) => {
        state.progress = progress;
    });

    // Load skybox (continue without if it fails — e.g. CORS, 404)
    const skyboxLoad =
        config.skyboxUrl &&
        loadSkybox(app, config.skyboxUrl)
            .then((asset) => {
                app.scene.envAtlas = asset.resource as Texture;
            })
            .catch((err: Error) => {
                console.warn('Failed to load skybox:', err);
            });

    // Load collision data (type determined by file extension)
    let collisionLoad: Promise<Collision> | undefined;
    if (config.collisionUrl) {
        const ext = new URL(config.collisionUrl, location.href).pathname.split('.').pop()?.toLowerCase();
        if (ext === 'glb') {
            collisionLoad = MeshCollision.fromGlb(app, config.collisionUrl).catch((err: Error): null => {
                console.warn('Failed to load mesh collision:', err);
                return null;
            });
        } else {
            collisionLoad = loadVoxelCollision(config.collisionUrl).catch((err: Error): null => {
                console.warn('Failed to load voxel data:', err);
                return null;
            });
        }
    }

    // Load and play sound
    if (global.settings.soundUrl) {
        const sound = new Audio(global.settings.soundUrl);
        sound.crossOrigin = 'anonymous';
        document.body.addEventListener(
            'click',
            () => {
                if (sound) {
                    sound.play();
                }
            },
            {
                capture: true,
                once: true
            }
        );
    }

    // Create the viewer
    return new Viewer(global, gsplatLoad, skyboxLoad, collisionLoad);
};

console.log(`SuperSplat Viewer v${appVersion} | Engine v${engineVersion} (${engineRevision})`);

export { main };
