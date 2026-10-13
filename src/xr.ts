import { DEVICETYPE_WEBGL2, math, Quat, Vec3, XrManager } from 'playcanvas';
import type { Color, Entity, XrInputSource } from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr/xr-controllers.mjs';
import { XrManipulation } from 'playcanvas/scripts/esm/xr/xr-manipulation.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr/xr-navigation.mjs';

import { VoxelCollision } from './collision';
import type { Collision } from './collision';
import { TeleportTarget } from './teleport-target';
import type { Global, XrMode } from './types';
import { XrGrabMove } from './xr-grab-move';
import { XrHeadMenu } from './xr-head-menu';
import { replaceTeleportArc } from './xr-teleport-arc';
import type { TeleportArcNavigation } from './xr-teleport-arc';

// Teleporting onto the scene's collision, when it has some: the navigation tests its arc against
// it segment by segment, so walls and furniture stop the arc, and a hit is a target only where
// someone could stand: the walk controller's capsule fits there (cameras/walk-controller.ts: 1.5 m
// tall, 0.2 m radius, 0.2 m above the floor), and most of the ground within STAND_RADIUS is within
// STAND_STEP of the hit's height (so a pew's rail or a fence top does not count). All of them
// scale with the user (grabbing a scene scales them, xr-grab-move.ts). Without collision the arc
// lands on the navigation's plane at the session's floor.
const STAND_RADIUS = 0.3;
const STAND_SHARE = 0.8;
const STAND_STEP = 0.15;
const CAPSULE_HEIGHT = 1.5;
const CAPSULE_RADIUS = 0.2;
const CAPSULE_HOVER = 0.2;

// Standalone headsets run XR on a mobile gpu, which draws every splat once per eye, but their
// browsers report a desktop platform. Their sessions render with fixed foveation and a 72 Hz
// target, at 0.8x resolution in performance mode, and the viewer lowers the splat budget.
const standaloneHeadset = /OculusBrowser|PicoBrowser/.test(globalThis.navigator?.userAgent ?? '');

// Apple Vision Pro's Safari reports a Mac, but one with touch points. Its pinches aim by the eyes,
// which the lookNavigation setting can teleport by (iPad's Safari reports the same, but offers no VR)
const visionPro =
    /Macintosh/.test(globalThis.navigator?.userAgent ?? '') && (globalThis.navigator?.maxTouchPoints ?? 0) > 0;

// The viewer reconfigures the camera (clear color, post effects) when state.xrMode changes
const initXr = (global: Global) => {
    const { app, events, state, camera, renderer, root, localize } = global;
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

    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();

    parent.addComponent('script');
    // its models by input source (the script's own typing is Script)
    const controllers = parent.script.create(XrControllers) as unknown as {
        controllers: Map<XrInputSource, { entity: Entity }>;
    };
    // the members of the navigation the viewer uses (the script's own typing is Script)
    const navigation = parent.script.create(XrNavigation) as unknown as TeleportArcNavigation & {
        validTeleportColor: Color;
        movementSpeed: number;
        arcWidth: number;
        teleportIndicatorRadius: number;
        snapVerticalHeight: number;
        snapVerticalBoostHeight: number;
        _rotateRigAroundCamera(degrees: number): void;
        _isSystemSelect(inputSource: XrInputSource): boolean;
    };
    replaceTeleportArc(navigation, () => state.lookNavigation);

    // The user's scale, which grabbing a scene changes, and the navigation's distances and sizes
    // with it: its arc's speed by the square root, so the arc's reach and height scale
    let userScale = 1;
    const unscaled = {
        maxTeleportDistance: navigation.maxTeleportDistance,
        movementSpeed: navigation.movementSpeed,
        arcWidth: navigation.arcWidth,
        teleportIndicatorRadius: navigation.teleportIndicatorRadius,
        snapVerticalHeight: navigation.snapVerticalHeight,
        snapVerticalBoostHeight: navigation.snapVerticalBoostHeight
    };
    const unscaledArcSpeed = navigation.teleportArcSpeed;
    // The hand and controller models sit in the world, posed joint by joint in it, so they scale
    // with the user too: otherwise a grown user's fingers spread out at real thickness
    const scaleModel = (entity: Entity) => entity.setLocalScale(userScale, userScale, userScale);
    const modelAdded = app.on('xr:controller:add', (_source: XrInputSource, entity: Entity) => scaleModel(entity));
    const setUserScale = (scale: number) => {
        userScale = scale;
        for (const key of Object.keys(unscaled) as (keyof typeof unscaled)[]) {
            navigation[key] = unscaled[key] * scale;
        }
        navigation.teleportArcSpeed = unscaledArcSpeed * Math.sqrt(scale);
        for (const { entity } of controllers.controllers.values()) scaleModel(entity);
    };
    // The navigation turns the rig about the camera's local position, which is not where the
    // camera is in a scaled rig: turn it about the camera's world position
    const turnPivot = new Vec3();
    navigation._rotateRigAroundCamera = (degrees: number) => {
        turnPivot.copy(camera.getPosition());
        parent.rotateLocal(0, degrees, 0);
        parent.translate(turnPivot.sub(camera.getPosition()));
    };

    // the scene's collision once it has loaded, for teleporting onto it (see STAND_SLOPE)
    let collision: Collision | null = null;
    const rayDir = new Vec3();
    const rayHit = new Vec3();
    const pushOut = { x: 0, y: 0, z: 0 };
    // whether the arc's last hit is somewhere to stand, which the navigation checks right after
    let hitStandable = false;
    const canStand = (c: Collision, x: number, y: number, z: number) => {
        const s = userScale;
        const center = y + (CAPSULE_HOVER + CAPSULE_HEIGHT * 0.5) * s;
        if (c.queryCapsule(x, center, z, (CAPSULE_HEIGHT * 0.5 - CAPSULE_RADIUS) * s, CAPSULE_RADIUS * s, pushOut)) {
            return false;
        }
        // down-rays a voxel apart across the disc, or further apart for a grown user, so at most
        // 13 across
        const radius = STAND_RADIUS * s;
        const standStep = STAND_STEP * s;
        const step = Math.max(c.voxelResolution, radius / 6);
        const cells = Math.floor(radius / step);
        let rays = 0;
        let ground = 0;
        for (let i = -cells; i <= cells; i++) {
            for (let j = -cells; j <= cells; j++) {
                if (i * i + j * j > cells * cells) continue;
                rays++;
                if (c.queryRay(x + i * step, y + standStep, z + j * step, 0, -1, 0, 2 * standStep)) ground++;
            }
        }
        return ground >= rays * STAND_SHARE;
    };
    const castRay = (from: Vec3, to: Vec3) => {
        if (!collision) return null;
        rayDir.sub2(to, from);
        const length = rayDir.length();
        if (length < 1e-6) return null;
        rayDir.mulScalar(1 / length);
        const hit = collision.queryRay(from.x, from.y, from.z, rayDir.x, rayDir.y, rayDir.z, length);
        if (!hit) return null;
        hitStandable = canStand(collision, hit.x, hit.y, hit.z);
        return rayHit.set(hit.x, hit.y, hit.z);
    };
    const validDistance = navigation.isValidTeleportDistance.bind(navigation);
    // The floor around where the arc lands, while it is aimed somewhere to stand (teleport-target.ts;
    // elsewhere the floor joined to the hit is a fragment, if any). The navigation tests every
    // landing it draws here, after its update and before the app's
    const aimPoint = new Vec3();
    let aimed = false;
    let aimValid = false;
    let target: TeleportTarget | null = null;
    navigation.isValidTeleportDistance = (point: Vec3) => {
        const valid = validDistance(point) && (!collision || hitStandable);
        aimPoint.copy(point);
        aimed = true;
        aimValid = valid;
        return valid;
    };
    const updating = app.on('update', (dt: number) => {
        if (target) {
            if (aimed && aimValid && xr.active) {
                target.show(aimPoint, navigation.validTeleportColor, dt, userScale);
            } else {
                target.hide();
            }
        }
        aimed = false;
    });
    // the floor under a point, from collision, or null without
    const floorBelow = (point: Vec3) => {
        const hit = collision?.queryRay(point.x, point.y, point.z, 0, -1, 0, 1000);
        return hit ? hit.y : null;
    };

    // Grabbing with both hands drags, turns and scales what was loaded, chosen once the splat
    // entity has loaded, which is before XR can start: an object moves, scaling about the hands
    // (the engine's XrManipulation, put back when the session ends, as the viewer's camera,
    // collision and annotations assume the authored placement); in a scene the user moves instead
    // (XrGrabMove), so the scene stays on its collision, and the user's feet on its floor.
    let manipulation: XrManipulation | null = null;
    let grabMove: XrGrabMove | null = null;

    // Where the session started, which the headset's recenter (holding the Meta button on Quest,
    // the Digital Crown on Vision Pro) puts the user back to, at real size and with a grabbed
    // object back in place: the browser moves the session's origin to where they stand, facing
    // where they look, and fires reset on its reference space. Trackers that lose and regain the
    // origin may fire it too.
    const startPosition = new Vec3();
    let startYaw = 0;
    let startFloorY = 0;
    let referenceSpace: EventTarget | null = null;
    const placeAtStart = () => {
        grabMove?.reset();
        manipulation?.reset();
        parent.setPosition(startPosition);
        parent.setEulerAngles(0, startYaw, 0);
        // the navigation keeps the rig's height above the floor it stands on when it teleports,
        // and has no setter for that floor
        (navigation as unknown as { _currentGroundY: number })._currentGroundY = startFloorY;
    };
    const recentered = () => {
        if (!destroyed && xr.active) placeAtStart();
    };
    const forgetReferenceSpace = () => {
        referenceSpace?.removeEventListener('reset', recentered);
        referenceSpace = null;
    };

    const started = xr.on('start', () => {
        if (destroyed) return;
        app.autoRender = true;

        // cache original camera rig positions and rotations
        parentPosition.copy(parent.getPosition());
        parentRotation.copy(parent.getRotation());
        cameraPosition.copy(camera.getPosition());
        cameraRotation.copy(camera.getRotation());

        // Start the session where the camera is, facing its heading with pitch and roll reset:
        // where it looks across the ground, or where the top of its view points when it looks
        // straight up or down. The yaw of getEulerAngles() only covers -90 to 90 degrees, so a
        // camera facing further round would start the session facing the wrong way.
        const { forward } = camera;
        let x = forward.x;
        let z = forward.z;
        if (x * x + z * z < 1e-6) {
            const { up } = camera;
            const sign = forward.y < 0 ? 1 : -1;
            x = up.x * sign;
            z = up.z * sign;
        }
        // standing on the floor under the camera where collision has one, else at the plane
        startFloorY = floorBelow(cameraPosition) ?? navigation.groundHeight;
        startPosition.set(cameraPosition.x, startFloorY, cameraPosition.z);
        startYaw = Math.atan2(-x, -z) * math.RAD_TO_DEG;
        placeAtStart();
        referenceSpace = (xr as unknown as { _referenceSpace: EventTarget | null })._referenceSpace;
        referenceSpace?.addEventListener('reset', recentered);

        if (standaloneHeadset) {
            xr.fixedFoveation = 1;
            if (xr.supportedFrameRates?.includes(72)) xr.updateTargetFrameRate(72);
        }

        state.xrMode = xr.type === 'immersive-ar' ? 'ar' : 'vr';
    });

    const ended = xr.on('end', () => {
        if (destroyed) return;
        app.autoRender = false;
        forgetReferenceSpace();

        // restore camera to pre-XR state, the rig to real size first, as the camera's position is
        // set in the world
        grabMove?.reset();
        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);
        manipulation?.reset();

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
        // while the browser's request is pending, for the hint about Safari's stalls (ui/xr-hint.ts)
        events.fire('xrRequest:pending', true);
        try {
            await new Promise<void>((resolve, reject) => {
                rejectStart = reject;
                xr.start(camera.camera, type, 'local-floor', {
                    framebufferScaleFactor: standaloneHeadset && state.performanceMode ? 0.8 : 1,
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
            if (!destroyed) events.fire('xrRequest:pending', false);
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

    // The head-locked menu, which takes the selects that start on it (or anywhere while it is open)
    // before the navigation aims with them
    const menu = new XrHeadMenu(app, camera, [
        { label: () => localize('tooltip.reset-camera'), action: placeAtStart },
        {
            label: () => localize('settings.look-navigation'),
            checked: () => state.lookNavigation,
            visible: () => visionPro,
            action: () => {
                state.lookNavigation = !state.lookNavigation;
            }
        },
        {
            label: () => localize(xr.type === 'immersive-ar' ? 'xr-menu.exit-ar' : 'xr-menu.exit-vr'),
            action: () => {
                void end().catch(() => {
                    /* the browser may already be ending the session */
                });
            }
        }
    ]);
    const isSystemSelect = navigation._isSystemSelect.bind(navigation);
    navigation._isSystemSelect = (source: XrInputSource) => isSystemSelect(source) || menu.select(source);

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
        setCollision: (value: Collision) => {
            collision = value;
            navigation.castRay = castRay;
            target?.destroy();
            target = value instanceof VoxelCollision ? new TeleportTarget(app, value) : null;
        },
        setGrabTarget: (entity: Entity, scene: boolean) => {
            if (scene) {
                grabMove = new XrGrabMove(app, parent, setUserScale);
            } else {
                manipulation = parent.script.create(XrManipulation, {
                    properties: { target: entity, scalePivot: 'hands', minScale: 0.25, maxScale: 4 }
                }) as unknown as XrManipulation;
            }
        },
        destroy: () => {
            destroyed = true;
            availability.off();
            started.off();
            ended.off();
            cancel.off();
            updating.off();
            modelAdded.off();
            forgetReferenceSpace();
            menu.destroy();
            grabMove?.destroy();
            grabMove = null;
            target?.destroy();
            target = null;
            if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
            rejectStart?.(gone());
            rejectEnd?.(gone());
            state.xrMode = null;
        }
    };
};

export { initXr, standaloneHeadset, visionPro };
