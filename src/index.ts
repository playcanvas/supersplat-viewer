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
import type { CreateViewerOptions } from './options';
import { persistPreferences, readPreferences } from './preferences';
import { importSettings } from './settings';
import type { Config, Global, State, ViewerHandle } from './types';
import { initPoster, initUI } from './ui';
import uiHtml from './ui.html';
import { Viewer } from './viewer';
import { version as appVersion } from '../package.json';

const loadGsplat = async (
    app: AppBase,
    config: Config,
    progressCallback: (progress: number) => void,
    cancelled: () => boolean
) => {
    const { contents, contentUrl, contentFilename } = config;
    const c = contents as unknown as ArrayBuffer;
    // the filename's extension selects the gsplat parser, so a url with no usable name (a
    // data: uri) needs the config to name its content instead; falsy (an empty name) falls
    // back to the url-derived name
    const filename = contentFilename || new URL(contentUrl, location.href).pathname.split('/').pop();
    const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;

    // Reading that metadata spans a network round trip, so a destroy can land in the middle of
    // it. `app.destroy()` nulls the asset registry, so registering the asset now would throw
    // from the engine's internals; reject instead, which the viewer's load chains expect.
    if (cancelled()) {
        throw new Error('loadGsplat: the viewer was destroyed while loading');
    }

    const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename, contents: c }, data);

    return new Promise<Entity>((resolve, reject) => {
        asset.on('load', () => {
            // always name the app: the engine's default is the most recently created one,
            // which is another viewer's when two share a page
            const entity = new Entity('gsplat', app);
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
    const cameraRoot = new Entity('camera root', app);
    app.root.addChild(cameraRoot);

    const camera = new Entity('camera', app);
    cameraRoot.addChild(camera);

    const light = new Entity('light', app);
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

    return () => resizeObserver.disconnect();
};

const createImage = (url: string) => {
    const img = new Image();
    img.src = url;
    return img;
};

// the options with every default applied
const resolveConfig = (options: CreateViewerOptions): Config => ({
    contentUrl: options.contentUrl,
    contentFilename: options.contentFilename,
    posterUrl: options.posterUrl,
    skyboxUrl: options.skyboxUrl,
    collisionUrl: options.collisionUrl,
    poster: options.poster ?? (options.posterUrl ? createImage(options.posterUrl) : undefined),
    contents: options.contents ?? fetch(options.contentUrl),
    renderer: options.renderer ?? 'webgpu',
    ui: options.ui ?? true,
    noanim: options.noanim ?? false,
    nofx: options.nofx ?? false,
    hpr: options.hpr,
    ministats: options.ministats ?? false,
    colorize: options.colorize ?? false,
    fullload: options.fullload ?? false,
    aa: options.aa ?? false,
    budget: options.budget,
    heatmap: options.heatmap ?? false,
    debug: options.debug ?? false,
    lang: options.lang,
    exposeGlobals: options.exposeGlobals ?? false
});

const createViewer = async (options: CreateViewerOptions): Promise<ViewerHandle> => {
    const { container } = options;
    const config = resolveConfig(options);

    // the instance root. The canvas and the ui markup are siblings under it, which scopes
    // everything the viewer looks up or attaches in the dom; the viewer owns it outright, so
    // nothing on the host's own element is read or written, and destroy() removes it whole
    const root = document.createElement('div');
    root.className = 'sse-viewer';
    if (config.ui) {
        root.innerHTML = uiHtml;
    } else {
        root.appendChild(document.createElement('canvas'));
    }

    container.appendChild(root);
    const canvas = root.querySelector('canvas');

    // create events
    const events = new EventHandler();

    // the poster covers the hidden canvas from the first moment, before the graphics device
    // exists. It is part of the ui, so a headless instance shows the canvas from the start and
    // its host covers the wait however it likes
    if (config.poster && config.ui) {
        initPoster(root, config.poster, events);
    }

    // resolve settings after showing the poster, including a fetch started by the document
    const settingsJson =
        typeof options.settings === 'string' ? await (await fetch(options.settings)).json() : await options.settings;

    const preferences = readPreferences(platform.mobile);

    // size the canvas backbuffer before the graphics device is created, so the swap
    // chain and any backbuffer-sized resources start at the correct resolution instead
    // of being recreated on the first frame's resize. a hidden embed keeps the default
    // canvas size here; the resize observer sizes it on reveal
    resizeCanvas(canvas, measureCanvas(canvas), preferences.performanceMode);

    const { app, camera, renderer } = await createApp(canvas, config);

    // translate the markup and get this instance's string lookup, before the ui reads any
    const localize = initLocalization(config.lang, root);

    const state = observe<State>(events, {
        loaded: false,
        ...preferences,
        progress: 0,
        inputMode: platform.mobile ? 'touch' : 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        hasAR: false,
        hasVR: false,
        canStartAR: false,
        canStartVR: false,
        xrMode: null,
        hasCollision: false,
        hasCollisionOverlay: false,
        walkAllowed: false,
        collisionOverlayEnabled: false,
        isFullscreen: false,
        controlsHidden: false,
        selectedAnnotation: null,
        inputEnabled: true
    });

    const global: Global = {
        app,
        settings: importSettings(settingsJson),
        config,
        state,
        events,
        camera,
        renderer,
        root,
        localize
    };

    const disposeCanvas = initCanvas(global);

    // start the application
    app.start();

    camera.addComponent('camera');

    // a load continuation can outlive a destroy, so anything that resumes after an await checks
    // this before touching the app
    let destroyed = false;

    // Load model
    const gsplatLoad = loadGsplat(
        app,
        config,
        (progress: number) => {
            state.progress = progress;
        },
        () => destroyed
    );

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
    let disposeAudio: (() => void) | undefined;
    if (global.settings.soundUrl) {
        const sound = new Audio(global.settings.soundUrl);
        sound.crossOrigin = 'anonymous';
        const unlock = () => {
            if (sound) {
                sound.play();
            }
        };
        root.addEventListener('click', unlock, {
            capture: true,
            once: true
        });
        disposeAudio = () => {
            root.removeEventListener('click', unlock, { capture: true });
            sound.pause();
        };
    }

    // Create the viewer
    const viewer = new Viewer(global, gsplatLoad, skyboxLoad, collisionLoad);
    viewer.onDestroy(persistPreferences(events));
    const handle: ViewerHandle = {
        app,
        state,
        events,
        annotations: global.settings.annotations,
        captureFrame: (captureOptions) => viewer.captureFrame(captureOptions),
        seek: (time) => viewer.seek(time),
        frameScene: () => viewer.frameScene(),
        resetCamera: () => viewer.resetCamera(),
        toggleWalk: () => viewer.toggleWalk(),
        selectAnnotation: (index) => viewer.selectAnnotation(index),
        setMoveInput: (x, z) => viewer.setMoveInput(x, z),
        requestFullscreen: () => viewer.requestFullscreen(),
        exitFullscreen: () => viewer.exitFullscreen(),
        startXR: (mode) => viewer.startXR(mode),
        endXR: () => viewer.endXR(),
        destroy: () => viewer.destroy()
    };

    // The built-in controls use the same handle returned to an embedding host.
    const disposeUI = config.ui ? initUI(global, handle, !!viewer.cameraFrame) : null;
    viewer.onDestroy(() => {
        destroyed = true;
    });
    viewer.onDestroy(disposeCanvas);
    if (disposeUI) {
        viewer.onDestroy(disposeUI);
    }
    if (disposeAudio) {
        viewer.onDestroy(disposeAudio);
    }

    return handle;
};

console.log(`SuperSplat Viewer v${appVersion} | Engine v${engineVersion} (${engineRevision})`);

export type { CaptureResult } from './capture';
export type { CreateViewerOptions, ViewerAssets, ViewerFlags } from './options';
export type { CaptureOptions, ViewerHandle, ViewerState, XrMode } from './types';
export { createViewer };
