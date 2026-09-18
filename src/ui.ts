import type { EventHandler } from 'playcanvas';

import { version as appVersion } from '../package.json';

import { Tooltip } from './tooltip';
import type { Global, ViewerHandle } from './types';
import { initAnnotationControls } from './ui/annotation-controls';
import { Annotations } from './ui/annotations';
import { initCameraControls } from './ui/camera-controls';
import { initPlayback } from './ui/playback';

// Initialize the touch joystick for fly mode camera control
const initJoystick = (
    dom: Record<string, HTMLElement>,
    events: EventHandler,
    state: { cameraMode: string; inputMode: string; gamingControls: boolean }
) => {
    // Joystick dimensions (matches SCSS: base height=100, stick size=40)
    const joystickHeight = 100;
    const stickSize = 40;
    const stickCenterY = (joystickHeight - stickSize) / 2; // 30px - top position when centered
    const stickCenterX = (joystickHeight - stickSize) / 2; // 30px - left position when centered (for 2D mode)
    const maxStickTravel = stickCenterY; // can travel 30px up or down from center

    // Joystick touch state
    let joystickPointerId: number | null = null;
    let joystickValueX = 0; // -1 to 1, negative = left, positive = right
    let joystickValueY = 0; // -1 to 1, negative = forward, positive = backward

    // Joystick mode: '1d' for vertical only, '2d' for full directional
    let joystickMode: '1d' | '2d' = '2d';

    // Double-tap detection for mode toggle
    let lastTapTime = 0;

    // Update joystick visibility based on camera mode and input mode
    const updateJoystickVisibility = () => {
        if (
            (state.cameraMode === 'fly' || state.cameraMode === 'walk') &&
            state.inputMode === 'touch' &&
            state.gamingControls
        ) {
            dom.joystickBase.classList.remove('sse-hidden');
            dom.joystickBase.classList.toggle('sse-mode-2d', joystickMode === '2d');
            // Center the stick
            dom.joystick.style.top = `${stickCenterY}px`;
            if (joystickMode === '2d') {
                dom.joystick.style.left = `${stickCenterX}px`;
            } else {
                dom.joystick.style.left = '8px'; // Reset to 1D centered position
            }
        } else {
            dom.joystickBase.classList.add('sse-hidden');
        }
    };

    events.on('cameraMode:changed', updateJoystickVisibility);
    events.on('inputMode:changed', updateJoystickVisibility);
    events.on('gamingControls:changed', updateJoystickVisibility);

    // Handle joystick touch input directly on the joystick element
    const updateJoystickStick = (clientX: number, clientY: number) => {
        // the stylesheet places the base within the instance, so measure its centre rather
        // than assuming where the viewport put it
        const base = dom.joystickBase.getBoundingClientRect();
        const baseY = base.top + base.height / 2;
        // Calculate Y offset from joystick center (positive = down/backward)
        const offsetY = clientY - baseY;
        // Clamp to max travel and normalize to -1 to 1
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickValueY = clampedOffsetY / maxStickTravel;

        // Update stick visual Y position
        dom.joystick.style.top = `${stickCenterY + clampedOffsetY}px`;

        // Handle X axis in 2D mode
        if (joystickMode === '2d') {
            const baseX = base.left + base.width / 2;
            const offsetX = clientX - baseX;
            const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
            joystickValueX = clampedOffsetX / maxStickTravel;

            // Update stick visual X position
            dom.joystick.style.left = `${stickCenterX + clampedOffsetX}px`;
        } else {
            joystickValueX = 0;
        }

        // Fire input event for the input controller
        events.fire('joystickInput', { x: joystickValueX, y: joystickValueY });
    };

    dom.joystickBase.addEventListener('pointerdown', (event: PointerEvent) => {
        // Double-tap detection for mode toggle
        const now = Date.now();
        if (now - lastTapTime < 300) {
            joystickMode = joystickMode === '1d' ? '2d' : '1d';
            updateJoystickVisibility();
            lastTapTime = 0;
        } else {
            lastTapTime = now;
        }

        if (joystickPointerId !== null) return; // Already tracking a touch

        joystickPointerId = event.pointerId;
        dom.joystickBase.setPointerCapture(event.pointerId);

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
    });

    dom.joystickBase.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
    });

    const endJoystickTouch = (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        joystickPointerId = null;
        joystickValueX = 0;
        joystickValueY = 0;

        // Reset stick to center
        dom.joystick.style.top = `${stickCenterY}px`;
        if (joystickMode === '2d') {
            dom.joystick.style.left = `${stickCenterX}px`;
        }

        // Fire input event with zero values
        events.fire('joystickInput', { x: 0, y: 0 });

        dom.joystickBase.releasePointerCapture(event.pointerId);
    };

    dom.joystickBase.addEventListener('pointerup', endJoystickTouch);
    dom.joystickBase.addEventListener('pointercancel', endJoystickTouch);
};

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
    const { events, state, root, localize } = global;
    const disposers: (() => void)[] = [];

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
        'joystickBase',
        'joystick',
        'showCollision',
        'desktopShowCollisionHelp',
        'tooltip',
        'viewerBranding',
        'viewerTitle',
        'appVersionLabel',
        'xrModal',
        'xrModalOk',
        'xrModalCancel'
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
    events.on('progress:changed', updateLoadingProgress);
    updateLoadingProgress(state.progress);

    // Hide loading bar once loaded
    events.on('loaded:changed', () => {
        dom.loadingWrap.classList.add('sse-hidden');
    });

    // Fullscreen support. The root goes fullscreen rather than the document, so an embedded
    // instance fills the screen on its own; the standalone document's root is <body>.
    const hasFullscreenAPI = root.requestFullscreen && document.exitFullscreen;

    const requestFullscreen = () => {
        if (hasFullscreenAPI) {
            root.requestFullscreen();
        } else {
            window.parent.postMessage('requestFullscreen', '*');
            state.isFullscreen = true;
        }
    };

    const exitFullscreen = () => {
        if (hasFullscreenAPI) {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {
                    // intentionally ignored
                });
            }
        } else {
            window.parent.postMessage('exitFullscreen', '*');
            state.isFullscreen = false;
        }
    };

    if (hasFullscreenAPI) {
        const onFullscreenChange = () => {
            // ours, not another instance's on the same page
            state.isFullscreen = document.fullscreenElement === root;
        };
        document.addEventListener('fullscreenchange', onFullscreenChange);
        disposers.push(() => document.removeEventListener('fullscreenchange', onFullscreenChange));
    }

    dom.enterFullscreen.addEventListener('click', requestFullscreen);
    dom.exitFullscreen.addEventListener('click', exitFullscreen);

    // toggle fullscreen when user switches between landscape portrait
    // orientation
    const onOrientationChange = () => {
        if (['landscape-primary', 'landscape-secondary'].includes(screen.orientation.type)) {
            requestFullscreen();
        } else {
            exitFullscreen();
        }
    };
    screen?.orientation?.addEventListener('change', onOrientationChange);
    disposers.push(() => screen?.orientation?.removeEventListener('change', onOrientationChange));

    // update UI when fullscreen state changes
    events.on('isFullscreen:changed', (value) => {
        dom.enterFullscreen.classList[value ? 'add' : 'remove']('sse-hidden');
        dom.exitFullscreen.classList[value ? 'remove' : 'add']('sse-hidden');
    });

    // Performance mode toggle
    dom.performanceModeRow.addEventListener('click', () => {
        state.performanceMode = !state.performanceMode;
    });

    const updatePerformanceMode = () => {
        dom.performanceModeCheck.classList.toggle('sse-active', state.performanceMode);
    };
    events.on('performanceMode:changed', updatePerformanceMode);
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
    events.on('inputMode:changed', updateGamingSettingsVisibility);
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

    events.on('gamingControls:changed', updateGamingControls);
    events.on('inputMode:changed', updateGamingControls);
    updateGamingControls();

    // persist user preferences on change (never at startup, so defaults are not written into storage)
    events.on('performanceMode:changed', (value: boolean) => localStorage.setItem('performanceMode', String(value)));
    events.on('gamingControls:changed', (value: boolean) => localStorage.setItem('gamingControls', String(value)));
    events.on('showAnnotations:changed', (value: boolean) => localStorage.setItem('showAnnotations', String(value)));

    // AR/VR
    const arChanged = () => dom.arMode.classList[state.hasAR ? 'remove' : 'add']('sse-hidden');
    const vrChanged = () => dom.vrMode.classList[state.hasVR ? 'remove' : 'add']('sse-hidden');

    // When a session can't start on the current (WebGPU) device but would work on
    // WebGL, prompt the user to reload the viewer with the WebGL renderer before
    // starting AR/VR. Use replace() so the renderer-switch reload doesn't add a
    // back-button entry — important because the viewer often runs inside an
    // iframe (e.g. superspl.at /scene).
    const reloadWithWebgl = () => {
        const reloadUrl = new URL(location.href);
        reloadUrl.searchParams.set('webgl', '');
        location.replace(reloadUrl.toString());
    };

    const showXrModal = () => dom.xrModal.classList.remove('sse-hidden');
    const hideXrModal = () => dom.xrModal.classList.add('sse-hidden');

    dom.xrModalOk.addEventListener('click', reloadWithWebgl);
    dom.xrModalCancel.addEventListener('click', hideXrModal);
    dom.xrModal.addEventListener('pointerdown', hideXrModal);

    const handleXrClick = (type: 'AR' | 'VR') => {
        // Availability is backend-aware: when the session can start on the current
        // device (WebGPU included), start it directly. Otherwise the button is only
        // visible because the session would work on WebGL, so offer the reload.
        if (global.app.xr.isAvailable(type === 'AR' ? 'immersive-ar' : 'immersive-vr')) {
            events.fire(type === 'AR' ? 'startAR' : 'startVR');
        } else {
            showXrModal();
        }
    };

    dom.arMode.addEventListener('click', () => handleXrClick('AR'));
    dom.vrMode.addEventListener('click', () => handleXrClick('VR'));

    events.on('hasAR:changed', arChanged);
    events.on('hasVR:changed', vrChanged);

    arChanged();
    vrChanged();

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

    events.on('inputEvent', (event) => {
        if (event === 'toggleHelp') {
            toggleHelp();
        } else if (event === 'cancel') {
            // close info panel on cancel
            dom.infoPanel.classList.add('sse-hidden');
            dom.settingsPanel.classList.add('sse-hidden');

            // close fullscreen on cancel
            if (state.isFullscreen) {
                exitFullscreen();
            }
        } else if (event === 'interrupt') {
            dom.settingsPanel.classList.add('sse-hidden');
        }
    });

    // fade ui controls after 5 seconds of inactivity
    events.on('controlsHidden:changed', (value) => {
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
    events.on('loaded:changed', () => {
        dom.controlsWrap.classList.remove('sse-hidden');
        showUI();
    });

    events.on('inputEvent', showUI);

    const updateCapturedUI = () => {
        if (isPointerCapturedMode()) {
            hideUI();
        } else {
            showUI();
        }
    };

    events.on('cameraMode:changed', updateCapturedUI);
    events.on('inputMode:changed', updateCapturedUI);
    events.on('gamingControls:changed', updateCapturedUI);

    // Keep controls visible while the selected annotation's panel is shown.
    const selectionChanged = events.on('selectedAnnotation:changed', showUI);
    disposers.push(() => selectionChanged.off());

    disposers.push(initPlayback(viewer, root, showUI));
    disposers.push(initCameraControls(viewer, root));

    // Walk mode hint banner (shown once per session on first FPS entry)
    let walkHintShown = false;

    const getWalkHintText = () => {
        if (state.inputMode === 'desktop') {
            return localize('walk-hint.desktop');
        }
        return localize(state.gamingControls ? 'walk-hint.touch-gaming' : 'walk-hint.touch-tap');
    };

    events.on('cameraMode:changed', (value: string) => {
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
    events.on('inputEvent', (type: string) => {
        if (type === 'interrupt') dismissWalkHint();
    });

    // Collision overlay toggle + matching help-panel row (only visible when overlay is available)
    events.on('hasCollisionOverlay:changed', (value: boolean) => {
        dom.showCollision.classList.toggle('sse-hidden', !value);
        dom.desktopShowCollisionHelp.classList.toggle('sse-hidden', !value);
    });

    dom.showCollision.addEventListener('click', () => {
        state.collisionOverlayEnabled = !state.collisionOverlayEnabled;
    });

    events.on('collisionOverlayEnabled:changed', (value: boolean) => {
        dom.showCollision.classList.toggle('sse-active', value);
    });

    dom.settings.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('sse-hidden');
    });

    // Initialize touch joystick for fly mode
    initJoystick(dom, events, state);

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
