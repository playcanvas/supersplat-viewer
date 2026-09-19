import type { EventHandler } from 'playcanvas';

import { version as appVersion } from '../package.json';

import { Tooltip } from './tooltip';
import type { Global, ViewerHandle } from './types';
import { initAnnotationControls } from './ui/annotation-controls';
import { Annotations } from './ui/annotations';
import { initCameraControls } from './ui/camera-controls';
import { initFullscreenControls } from './ui/fullscreen-controls';
import { initJoystick } from './ui/joystick';
import { initPlayback } from './ui/playback';
import { initXrControls } from './ui/xr-controls';

// show the poster image over the hidden canvas, blurry at first and sharpening as loading
// progresses, until the first frame renders
const initPoster = (root: HTMLElement, image: HTMLImageElement, events: EventHandler) => {
    const poster = root.querySelector<HTMLElement>('.sse-poster');

    poster.style.setProperty('--poster-url', `url(${image.src})`);
    poster.style.display = 'block';
    poster.style.filter = 'blur(40px)';
    // the canvas inherits this from the root
    root.style.setProperty('--canvas-opacity', '0');

    events.on('loaded:changed', () => {
        poster.style.display = 'none';
        root.style.setProperty('--canvas-opacity', '1');
    });

    const blur = (progress: number) => {
        poster.style.filter = `blur(${Math.floor((100 - progress) * 0.4)}px)`;
    };

    events.on('progress:changed', blur);
};

// Returns a function that removes the listeners added outside the ui subtree (window,
// document, screen) and cancels pending timers. Listeners on the subtree's own elements are
// released with the elements.
const initUI = (global: Global, viewer: ViewerHandle, hasCameraFrame: boolean) => {
    const { root, localize } = global;
    const { events, state } = viewer;
    const disposers: (() => void)[] = [];
    const on = (name: string, callback: Parameters<EventHandler['on']>[1]) => {
        const subscription = events.on(name, callback);
        disposers.push(() => subscription.off());
    };

    // Acquire Elements
    const dom = [
        'ui',
        'controlsWrap',
        'arMode',
        'vrMode',
        'enterFullscreen',
        'exitFullscreen',
        'info',
        'infoPanel',
        'desktopTab',
        'touchTab',
        'desktopInfoPanel',
        'touchInfoPanel',
        'buttonContainer',
        'play',
        'pause',
        'settings',
        'settingsPanel',
        'orbitCamera',
        'flyCamera',
        'fpsCamera',
        'performanceModeRow',
        'performanceModeCheck',
        'performanceModeOption',
        'gamingControlsDivider',
        'gamingControlsRow',
        'gamingControlsCheck',
        'gamingControlsOption',
        'desktopFlyClickToFly',
        'desktopFlyGamingControls',
        'desktopClickToWalk',
        'desktopGamingControls',
        'touchFlyClickToWalk',
        'touchFlyGamingControls',
        'touchClickToWalk',
        'touchGamingControls',
        'walkHint',
        'reset',
        'frame',
        'loadingWrap',
        'loadingText',
        'loadingBar',
        'showCollision',
        'desktopShowCollisionHelp',
        'tooltip',
        'viewerBranding',
        'viewerTitle',
        'appVersionLabel'
    ].reduce((acc: Record<string, HTMLElement>, name) => {
        acc[name] = root.querySelector<HTMLElement>(`.sse-${name}`);
        return acc;
    }, {});

    // populate the info-panel title with the app version
    dom.appVersionLabel.textContent = appVersion;

    // Remove focus from buttons after click so keyboard input isn't captured by the UI
    dom.ui.addEventListener('click', () => {
        (document.activeElement as HTMLElement)?.blur();
    });

    // Forward wheel events from UI overlays to the canvas so the camera zooms
    // instead of the page scrolling (e.g. annotation nav, tooltips, hotspots).
    // The non-standard wheelDelta{X,Y} properties aren't part of WheelEventInit,
    // so they get dropped by `new WheelEvent(type, init)`. We re-attach them so
    // the trackpad-vs-mouse classifier in input-controller.ts behaves the same
    // whether the event originated on the canvas or was forwarded from the UI.
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    dom.ui.addEventListener(
        'wheel',
        (event: WheelEvent) => {
            event.preventDefault();
            const forwarded = new WheelEvent(event.type, event);
            const src = event as WheelEvent & {
                wheelDelta?: number;
                wheelDeltaX?: number;
                wheelDeltaY?: number;
            };
            for (const key of ['wheelDelta', 'wheelDeltaX', 'wheelDeltaY'] as const) {
                if (typeof src[key] === 'number') {
                    Object.defineProperty(forwarded, key, { value: src[key], configurable: true });
                }
            }
            canvas.dispatchEvent(forwarded);
        },
        { passive: false }
    );

    // Handle loading progress updates
    const updateLoadingProgress = (progress: number) => {
        dom.loadingText.textContent = `${progress}%`;
        if (progress < 100) {
            dom.loadingBar.style.backgroundImage = `linear-gradient(90deg, #F60 0%, #F60 ${progress}%, white ${progress}%, white 100%)`;
        } else {
            dom.loadingBar.style.backgroundImage = 'linear-gradient(90deg, #F60 0%, #F60 100%)';
        }
    };
    on('progress:changed', updateLoadingProgress);
    updateLoadingProgress(state.progress);

    // Hide loading bar once loaded
    on('loaded:changed', () => {
        dom.loadingWrap.classList.add('sse-hidden');
    });

    // Performance mode toggle
    dom.performanceModeRow.addEventListener('click', () => {
        state.performanceMode = !state.performanceMode;
    });

    const updatePerformanceMode = () => {
        dom.performanceModeCheck.classList.toggle('sse-active', state.performanceMode);
    };
    on('performanceMode:changed', updatePerformanceMode);
    updatePerformanceMode();

    // Gaming mode toggle (settings row visible on mobile only)
    dom.gamingControlsRow.addEventListener('click', () => {
        state.gamingControls = !state.gamingControls;
    });

    const updateGamingSettingsVisibility = () => {
        const isDesktop = state.inputMode === 'desktop';
        dom.gamingControlsDivider.classList.toggle('sse-hidden', isDesktop);
        dom.gamingControlsRow.classList.toggle('sse-hidden', isDesktop);
    };
    on('inputMode:changed', updateGamingSettingsVisibility);
    updateGamingSettingsVisibility();

    const updateGamingControls = () => {
        dom.gamingControlsCheck.classList.toggle('sse-active', state.gamingControls);
        dom.desktopFlyClickToFly.classList.toggle('sse-hidden', state.gamingControls);
        dom.desktopFlyGamingControls.classList.toggle('sse-hidden', !state.gamingControls);
        dom.desktopClickToWalk.classList.toggle('sse-hidden', state.gamingControls);
        dom.desktopGamingControls.classList.toggle('sse-hidden', !state.gamingControls);
        dom.touchFlyClickToWalk.classList.toggle('sse-hidden', state.gamingControls);
        dom.touchFlyGamingControls.classList.toggle('sse-hidden', !state.gamingControls);
        dom.touchClickToWalk.classList.toggle('sse-hidden', state.gamingControls);
        dom.touchGamingControls.classList.toggle('sse-hidden', !state.gamingControls);
    };

    on('gamingControls:changed', updateGamingControls);
    on('inputMode:changed', updateGamingControls);
    updateGamingControls();

    // Info panel
    const updateInfoTab = (tab: 'desktop' | 'touch') => {
        if (tab === 'desktop') {
            dom.desktopTab.classList.add('sse-active');
            dom.touchTab.classList.remove('sse-active');
            dom.desktopInfoPanel.classList.remove('sse-hidden');
            dom.touchInfoPanel.classList.add('sse-hidden');
        } else {
            dom.desktopTab.classList.remove('sse-active');
            dom.touchTab.classList.add('sse-active');
            dom.desktopInfoPanel.classList.add('sse-hidden');
            dom.touchInfoPanel.classList.remove('sse-hidden');
        }
    };

    dom.desktopTab.addEventListener('click', () => {
        updateInfoTab('desktop');
    });

    dom.touchTab.addEventListener('click', () => {
        updateInfoTab('touch');
    });

    const toggleHelp = () => {
        updateInfoTab(state.inputMode);
        dom.infoPanel.classList.toggle('sse-hidden');
    };

    dom.info.addEventListener('click', toggleHelp);

    dom.infoPanel.addEventListener('pointerdown', () => {
        dom.infoPanel.classList.add('sse-hidden');
    });

    on('inputEvent', (event) => {
        if (event === 'toggleHelp') {
            toggleHelp();
        } else if (event === 'cancel') {
            // close info panel on cancel
            dom.infoPanel.classList.add('sse-hidden');
            dom.settingsPanel.classList.add('sse-hidden');
        } else if (event === 'interrupt') {
            dom.settingsPanel.classList.add('sse-hidden');
        }
    });

    // fade ui controls after 5 seconds of inactivity
    on('controlsHidden:changed', (value) => {
        dom.controlsWrap.classList.toggle('sse-faded-out', value);
        dom.controlsWrap.classList.toggle('sse-faded-in', !value);
    });

    // show the ui and start a timer to hide it again
    let uiTimeout: ReturnType<typeof setTimeout> | null = null;

    disposers.push(() => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
            uiTimeout = null;
        }
    });

    const isPointerCapturedMode = () =>
        state.inputMode === 'desktop' &&
        state.gamingControls &&
        (state.cameraMode === 'walk' || state.cameraMode === 'fly');

    const hideUI = () => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
            uiTimeout = null;
        }
        dom.infoPanel.classList.add('sse-hidden');
        dom.settingsPanel.classList.add('sse-hidden');
        dom.walkHint.classList.add('sse-hidden');
        state.controlsHidden = true;
    };

    const showUI = () => {
        if (isPointerCapturedMode()) {
            hideUI();
            return;
        }
        if (uiTimeout) {
            clearTimeout(uiTimeout);
        }
        state.controlsHidden = false;
        uiTimeout = setTimeout(() => {
            uiTimeout = null;
            if (state.selectedAnnotation === null || !state.showAnnotations) {
                state.controlsHidden = true;
            }
        }, 4000);
    };

    // Show controls once loaded
    on('loaded:changed', () => {
        dom.controlsWrap.classList.remove('sse-hidden');
        showUI();
    });

    on('inputEvent', showUI);

    const updateCapturedUI = () => {
        if (isPointerCapturedMode()) {
            hideUI();
        } else {
            showUI();
        }
    };

    on('cameraMode:changed', updateCapturedUI);
    on('inputMode:changed', updateCapturedUI);
    on('gamingControls:changed', updateCapturedUI);

    // Keep controls visible while the selected annotation's panel is shown.
    on('selectedAnnotation:changed', showUI);

    disposers.push(initPlayback(viewer, root, showUI));
    disposers.push(initCameraControls(viewer, root));
    disposers.push(initFullscreenControls(viewer, root));
    disposers.push(initXrControls(viewer, root));

    // Walk mode hint banner (shown once per session on first FPS entry)
    let walkHintShown = false;

    const getWalkHintText = () => {
        if (state.inputMode === 'desktop') {
            return localize('walk-hint.desktop');
        }
        return localize(state.gamingControls ? 'walk-hint.touch-gaming' : 'walk-hint.touch-tap');
    };

    on('cameraMode:changed', (value: string) => {
        if (value === 'walk' && !walkHintShown && !isPointerCapturedMode()) {
            walkHintShown = true;
            dom.walkHint.textContent = getWalkHintText();
            dom.walkHint.classList.remove('sse-hidden');
        } else if (value !== 'walk') {
            dom.walkHint.classList.add('sse-hidden');
        }
    });

    const dismissWalkHint = () => dom.walkHint.classList.add('sse-hidden');

    dom.walkHint.addEventListener('click', dismissWalkHint);
    on('inputEvent', (type: string) => {
        if (type === 'interrupt') dismissWalkHint();
    });

    // Collision overlay toggle + matching help-panel row (only visible when overlay is available)
    on('hasCollisionOverlay:changed', (value: boolean) => {
        dom.showCollision.classList.toggle('sse-hidden', !value);
        dom.desktopShowCollisionHelp.classList.toggle('sse-hidden', !value);
    });

    dom.showCollision.addEventListener('click', () => {
        state.collisionOverlayEnabled = !state.collisionOverlayEnabled;
    });

    on('collisionOverlayEnabled:changed', (value: boolean) => {
        dom.showCollision.classList.toggle('sse-active', value);
    });

    dom.settings.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('sse-hidden');
    });

    // Initialize touch joystick for fly mode
    disposers.push(initJoystick(viewer, root));

    disposers.push(initAnnotationControls(viewer, root));
    if (viewer.annotations.length > 0) {
        const annotations = new Annotations(viewer, root, global.camera, hasCameraFrame);
        disposers.push(() => annotations.destroy());
    }

    // tooltips
    const tooltip = new Tooltip(dom.tooltip);
    disposers.push(tooltip.destroy);

    tooltip.register(dom.play, localize('tooltip.play'), 'top');
    tooltip.register(dom.pause, localize('tooltip.pause'), 'top');
    tooltip.register(dom.orbitCamera, localize('tooltip.orbit-camera'), 'top');
    tooltip.register(dom.flyCamera, localize('tooltip.fly-camera'), 'top');
    tooltip.register(dom.fpsCamera, localize('tooltip.walk-mode'), 'top');
    tooltip.register(dom.reset, localize('tooltip.reset-camera'), 'bottom');
    tooltip.register(dom.frame, localize('tooltip.frame-scene'), 'bottom');
    tooltip.register(dom.showCollision, localize('tooltip.show-collision'), 'top');
    tooltip.register(dom.settings, localize('tooltip.settings'), 'top');
    tooltip.register(dom.info, localize('tooltip.help'), 'top');
    tooltip.register(dom.arMode, localize('tooltip.enter-ar'), 'top');
    tooltip.register(dom.vrMode, localize('tooltip.enter-vr'), 'top');
    tooltip.register(dom.enterFullscreen, localize('tooltip.fullscreen'), 'top');
    tooltip.register(dom.exitFullscreen, localize('tooltip.fullscreen'), 'top');

    const isThirdPartyEmbedded = () => {
        try {
            return window.location.hostname !== window.parent.location.hostname;
        } catch (_e) {
            // cross-origin iframe — parent location is inaccessible
            return true;
        }
    };

    if (window.parent !== window && isThirdPartyEmbedded()) {
        const viewUrl = new URL(window.location.href);
        if (viewUrl.pathname === '/s') {
            viewUrl.pathname = '/view';
        }

        (dom.viewerBranding as HTMLAnchorElement).href = viewUrl.toString();
        dom.viewerBranding.classList.remove('sse-hidden');
        (dom.viewerTitle as HTMLAnchorElement).href = viewUrl.toString();
    }

    return () => {
        for (const dispose of disposers) {
            dispose();
        }
    };
};

export { initPoster, initUI };
