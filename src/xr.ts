import { Color, DEVICETYPE_WEBGL2, Quat, Vec3, XrManager } from 'playcanvas';
import type { Entity } from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr/xr-controllers.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr/xr-navigation.mjs';

import type { Global, XrMode } from './types';

// On entering/exiting AR, we need to set the camera clear color to transparent black
const initXr = (global: Global) => {
    const { app, events, state, camera, renderer, root } = global;
    const { xr } = app;
    let destroyed = false;
    let restoreFrame: number | null = null;
    let rejectStart: ((error: Error) => void) | null = null;
    let rejectEnd: ((error: Error) => void) | null = null;
    const gone = () => new Error('the viewer has been destroyed');

    // Engine availability is backend-aware (2.20+): under WebGPU a session is only
    // reported available when it can start on the current device (browser exposes
    // XRGPUBinding, e.g. Safari on Apple Vision Pro). A session the WebGPU device
    // can't host may still run after reloading into WebGL, so keep the buttons
    // visible then — the UI offers that reload when the session can't start directly.
    let webglAR = false;
    let webglVR = false;

    const updateAvailable = () => {
        if (destroyed) return;
        state.canStartAR = xr.isAvailable('immersive-ar');
        state.canStartVR = xr.isAvailable('immersive-vr');
        state.hasAR = state.canStartAR || webglAR;
        state.hasVR = state.canStartVR || webglVR;
    };

    updateAvailable();
    const availability = xr.on('available', updateAvailable);

    if (renderer === 'webgpu') {
        Promise.all([
            XrManager.isDeviceSupported(DEVICETYPE_WEBGL2, 'immersive-ar'),
            XrManager.isDeviceSupported(DEVICETYPE_WEBGL2, 'immersive-vr')
        ]).then(([ar, vr]) => {
            if (destroyed) return;
            webglAR = ar;
            webglVR = vr;
            updateAvailable();
        });
    }

    const parent = camera.parent as Entity;
    const clearColor = new Color();

    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();
    const angles = new Vec3();

    parent.addComponent('script');
    parent.script.create(XrControllers);
    parent.script.create(XrNavigation);

    const started = xr.on('start', () => {
        if (destroyed) return;
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

        if (xr.type === 'immersive-ar') {
            clearColor.copy(camera.camera.clearColor);
            camera.camera.clearColor = new Color(0, 0, 0, 0);
        }
        state.xrMode = xr.type === 'immersive-ar' ? 'ar' : 'vr';
    });

    const ended = xr.on('end', () => {
        if (destroyed) return;
        app.autoRender = false;

        // restore camera to pre-XR state
        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);

        if (state.xrMode === 'ar') {
            camera.camera.clearColor = clearColor;
        }
        state.xrMode = null;

        // Restore the canvas to the correct position in the DOM after exiting XR. In
        // some browsers (e.g. Chrome on Android) the canvas is moved to a new root
        // during XR, and needs to be moved back on exit.
        if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
        restoreFrame = requestAnimationFrame(() => {
            restoreFrame = null;
            if (destroyed) return;
            root.prepend(app.graphicsDevice.canvas);
            app.renderNextFrame = true;
        });
    });

    const start = async (mode: XrMode) => {
        if (destroyed) throw gone();
        if (mode !== 'ar' && mode !== 'vr') throw new Error('startXR: mode must be ar or vr');
        if (rejectStart || rejectEnd || xr.active) throw new Error('startXR: a session is active or pending');
        const type = mode === 'ar' ? 'immersive-ar' : 'immersive-vr';
        if (!xr.isAvailable(type)) {
            const offered = mode === 'ar' ? state.hasAR : state.hasVR;
            throw new Error(
                offered ? 'startXR: reload with WebGL to start this session' : 'startXR: XR is not available'
            );
        }
        const { nearClip, farClip } = camera.camera;
        camera.camera.nearClip = 0.01;
        camera.camera.farClip = 1000;
        try {
            await new Promise<void>((resolve, reject) => {
                rejectStart = reject;
                xr.start(camera.camera, type, 'local-floor', {
                    callback: (error) => {
                        if (destroyed) {
                            // Browser session requests cannot be cancelled. Close a late result.
                            void xr.session?.end().catch(() => {
                                /* already ended */
                            });
                            reject(gone());
                        } else if (error) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    }
                });
            });
            if (destroyed) throw gone();
        } catch (error) {
            if (!destroyed) {
                camera.camera.nearClip = nearClip;
                camera.camera.farClip = farClip;
            }
            throw error;
        } finally {
            rejectStart = null;
        }
    };

    const end = async () => {
        if (destroyed) throw gone();
        if (rejectStart) throw new Error('endXR: a session is still starting');
        if (rejectEnd) throw new Error('endXR: a session is already ending');
        const { session } = xr;
        if (!session) return;
        let onEnd!: () => void;
        try {
            await new Promise<void>((resolve, reject) => {
                rejectEnd = reject;
                onEnd = resolve;
                xr.once('end', onEnd);
                // Use the native promise too: XrManager.end's callback does not report a
                // rejected session.end() promise. The engine handles browser-initiated ends.
                session.end().catch(reject);
            });
            if (destroyed) throw gone();
        } finally {
            xr.off('end', onEnd);
            rejectEnd = null;
        }
    };

    const cancel = events.on('inputEvent', (event) => {
        if (event === 'cancel' && xr.active) {
            void end().catch(() => {
                /* the browser may already be ending the session */
            });
        }
    });

    return {
        start,
        end,
        destroy: () => {
            destroyed = true;
            availability.off();
            started.off();
            ended.off();
            cancel.off();
            if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
            rejectStart?.(gone());
            rejectEnd?.(gone());
            state.xrMode = null;
        }
    };
};

export { initXr };
