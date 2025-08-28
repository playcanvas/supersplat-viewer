import '@playcanvas/web-components';
import { Asset, Color, Entity, EventHandler, MiniStats, Quat, ShaderChunks, Vec3 } from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr-controllers.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr-navigation.mjs';

import { migrateSettings } from './data-migrations.js';
import { observe } from './observe.js';
import { Viewer } from './viewer.js';

/** @import { AppElement, EntityElement } from '@playcanvas/web-components' */
/** @import { Texture } from 'playcanvas' */

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

// temporary vector
const v = new Vec3();

// get experience parameters
const params = window.sse?.params ?? {};

// IndexedDB工具函数
const dbName = 'ply_cache_db';
const storeName = 'ply_cache';
const CACHE_EXPIRY_DAYS = 7; // 缓存过期时间：7天

/**
 * 获取缓存过期时间戳
 * @returns {number} 过期时间戳
 */
const getExpiryTimestamp = () => {
    const now = Date.now();
    const expiryMs = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000; // 7天的毫秒数
    return now + expiryMs;
};

/**
 * 检查缓存是否过期
 * @param {number} timestamp - 缓存时间戳
 * @returns {boolean} 是否过期
 */
const isCacheExpired = (timestamp) => {
    return Date.now() > timestamp;
};

/**
 * 按需清理过期缓存（仅在读取缓存时发现过期才清理）
 * @param {string} key - 缓存键
 */
const cleanupExpiredCacheOnDemand = async (key) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.delete(key);
        request.onsuccess = () => {
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
};

/**
 * 定期清理过期缓存（可选，可在空闲时调用）
 * @returns {Promise<number>} 清理的缓存数量
 */
const cleanupExpiredCache = async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const index = store.index('timestamp');
        const request = index.openCursor();

        let deletedCount = 0;

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                const record = cursor.value;
                if (isCacheExpired(record.expiry)) {
                    cursor.delete();
                    deletedCount++;
                }
                cursor.continue();
            } else {
                if (deletedCount > 0) {
                    console.log(`定期清理了 ${deletedCount} 个过期缓存`);
                }
                resolve(deletedCount);
            }
        };

        request.onerror = () => reject(request.error);
    });
};

const getCachedData = async (key) => {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.get(key);
        request.onsuccess = () => {
            const result = request.result;
            if (result && !isCacheExpired(result.expiry)) {
                resolve(result.data);
            } else {
                // 缓存不存在或已过期，按需清理过期缓存
                if (result && isCacheExpired(result.expiry)) {
                    cleanupExpiredCacheOnDemand(key).catch(console.warn);
                }
                resolve(null);
            }
        };
    });
};

const cacheData = async (key, data) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const record = {
            key,
            data,
            timestamp: Date.now(),
            expiry: getExpiryTimestamp()
        };
        store.put(record);
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
};

const openDB = async () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                const store = db.createObjectStore(storeName, { keyPath: 'key' });
                store.createIndex('timestamp', 'timestamp');
                store.createIndex('expiry', 'expiry');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

/**
 * 手动清理所有缓存
 */
const clearAllCache = async () => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.clear();
        request.onsuccess = () => {
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
};

/**
 * 序列化 GSplatCompressedData 对象
 * @param {object} obj - GSplatCompressedData 对象
 * @returns {object} 可序列化的对象
 */
const serializeGSplatCompressedData = (obj) => {
    return {
        comments: obj.comments,
        chunkData: obj.chunkData,
        numSplats: obj.numSplats,
        shBands: obj.shBands,
        shData0: obj.shData0,
        shData1: obj.shData1,
        shData2: obj.shData2,
        vertexData: obj.vertexData,
        numChunks: obj.numChunks,
        isCompressed: obj.isCompressed,
        elements: obj.elements
    };
};

// displays a blurry poster image which resolves to sharp during loading
const initPoster = (events) => {
    const element = document.getElementById('poster');
    const blur = progress => `blur(${Math.floor((100 - progress) * 0.4)}px)`;

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
        state.hasVR = available;
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

const loadContent = (app, cachedData) => {
    const { contentUrl, settings } = window.sse;

    const filename = new URL(contentUrl, location.href).pathname.split('/').pop();
    const cacheKey = `${contentUrl}_true`; // 使用URL作为缓存键

    const asset = new Asset(filename, 'gsplat', {
        url: contentUrl,
        filename
    });

    // 如果有缓存，直接用缓存数据
    if (cachedData) {
        asset.cachedData = cachedData;
        setTimeout(() => {
            asset.fire('progress', 50, 100);
        }, 10);
    }

    asset.on('load', () => {
        const entity = new Entity('gsplat');
        entity.setLocalEulerAngles(0, 0, 180);
        entity.addComponent('gsplat', { asset });

        app.root.addChild(entity);
    });
    asset.on('load:data', (data) => {
        if (!cachedData) {
            const serializable = serializeGSplatCompressedData(data);
            cacheData(cacheKey, serializable);
        } else {
            asset.fire('progress', 100, 100);
        }
    });

    asset.on('error', (err) => {
        console.log(err);
    });

    app.assets.add(asset);
    app.assets.load(asset);
};

const waitForGsplat = (app, state) => {
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

document.addEventListener('DOMContentLoaded', async () => {
    // 立即显示加载状态，避免白屏
    const loadingWrap = document.getElementById('loadingWrap');
    const loadingText = document.getElementById('loadingText');
    const loadingBar = document.getElementById('loadingBar');

    if (loadingWrap) {
        loadingWrap.classList.remove('hidden');
        // 立即显示0%进度
        if (loadingText) loadingText.textContent = '0%';
        if (loadingBar) loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 0%, white 0%, white 100%)';
    }

    const appElement = /** @type {AppElement} */ (document.querySelector('pc-app'));

    // 显示PlayCanvas初始化进度
    if (loadingText) loadingText.textContent = '初始化引擎...';
    if (loadingBar) loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 10%, white 10%, white 100%)';

    const app = (await appElement.ready()).app;
    const { graphicsDevice } = app;

    // enable anonymous CORS for image loading in safari
    app.loader.getHandler('texture').imgParser.crossOrigin = 'anonymous';

    // 显示图形设备初始化进度
    if (loadingText) loadingText.textContent = '初始化图形设备...';
    if (loadingBar) loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 15%, white 15%, white 100%)';

    // 可选：在页面空闲时进行定期清理（不影响加载速度）
    // 使用 requestIdleCallback 在浏览器空闲时执行
    if ('requestIdleCallback' in window) {
        requestIdleCallback(async () => {
            try {
                await cleanupExpiredCache();
            } catch (error) {
                console.warn('定期缓存清理失败:', error);
            }
        }, { timeout: 10000 }); // 10秒超时
    }

    // render skybox as plain equirect
    const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
    glsl.set('skyboxPS', glsl.get('skyboxPS').replace('mapRoughnessUv(uv, mipLevel)', 'uv'));
    glsl.set('pickPS', pickDepthGlsl);

    const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
    wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));
    wgsl.set('pickPS', pickDepthWgsl);

    const { contentUrl } = window.sse;

    const cacheKey = `${contentUrl}_true`; // 使用URL作为缓存键
    // 尝试从IndexedDB读取缓存
    let cachedData = null;
    try {
        // 显示缓存读取进度
        if (loadingText) loadingText.textContent = '读取缓存...';
        if (loadingBar) loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 20%, white 20%, white 100%)';

        cachedData = await getCachedData(cacheKey);

        // 缓存读取完成
        if (loadingText) loadingText.textContent = cachedData ? '缓存命中' : '缓存未命中';
        if (loadingBar) loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 40%, white 40%, white 100%)';
    } catch (error) {
        console.warn('Cache read error:', error);
        if (loadingText) loadingText.textContent = '缓存读取失败';
    }

    loadContent(app, cachedData);

    const cameraElement = await /** @type {EntityElement} */ (document.querySelector('pc-entity[name="camera"]')).ready();
    const camera = cameraElement.entity;
    const settings = migrateSettings(await window.sse?.settings);
    const events = new EventHandler();
    const state = observe(events, {
        readyToRender: false,       // don't render till this is set
        hqMode: true,
        progress: 0,
        inputMode: 'desktop',       // desktop, touch
        cameraMode: 'orbit',        // orbit, anim, fly
        snap: false,                // snap to camera target
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
            app.scene.envAtlas = /** @type {Texture} */ (skyAsset.resource);
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
    initXr(app, cameraElement, state, events);

    // Initialize viewer
    const viewer = new Viewer(app, camera, events, state, settings, params);

    // Wait for gsplat asset to load before initializing the viewer
    waitForGsplat(app, state).then(() => viewer.initialize());

    // Acquire Elements
    const docRoot = document.documentElement;
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
        'orbitSettings', 'flySettings',
        'fly', 'orbit', 'cameraToggleHighlight',
        'high', 'low', 'qualityToggleHighlight',
        'reset', 'frame',
        'loadingText', 'loadingBar',
        'joystickBase', 'joystick'
    ].reduce((acc, id) => {
        acc[id] = document.getElementById(id);
        return acc;
    }, /** @type {Record<string, HTMLElement>} */ ({}));

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
    events.on('cameraMode:changed', () => {
        if (state.cameraMode === 'fly') {
            dom.cameraToggleHighlight.classList.add('right');
        } else {
            dom.cameraToggleHighlight.classList.remove('right');
        }

        dom.orbitSettings.classList[state.cameraMode === 'orbit' ? 'remove' : 'add']('hidden');
        dom.flySettings.classList[state.cameraMode === 'fly' ? 'remove' : 'add']('hidden');
    });

    dom.orbitSettings.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('hidden');
    });

    dom.flySettings.addEventListener('click', () => {
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
        graphicsDevice.canvas.addEventListener(eventName, (event) => {
            events.fire('inputEvent', 'interrupt', event);
        });
    });

    graphicsDevice.canvas.addEventListener('pointermove', (event) => {
        events.fire('inputEvent', 'interact', event);
    });

    // we must detect double taps manually because ios doesn't send dblclick events
    const lastTap = { time: 0, x: 0, y: 0 };
    graphicsDevice.canvas.addEventListener('pointerdown', (event) => {
        const now = Date.now();
        const delay = Math.max(0, now - lastTap.time);
        if (delay < 300 &&
            Math.abs(event.clientX - lastTap.x) < 8 &&
            Math.abs(event.clientY - lastTap.y) < 8) {
            events.fire('inputEvent', 'dblclick', event);
            lastTap.time = 0;
        } else {
            lastTap.time = now;
            lastTap.x = event.clientX;
            lastTap.y = event.clientY;
        }
    });

    // update input mode based on pointer event
    ['pointerdown', 'pointermove'].forEach((eventName) => {
        window.addEventListener(eventName, (/** @type {PointerEvent} */ event) => {
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