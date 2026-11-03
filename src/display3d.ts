import { Mat4, RenderView } from 'playcanvas';

import type { Global } from './types';

// Glasses-free 3D displays, through the DisplayXR inline-3D web SDK (`@displayxr/inline3d`).
//
// On such a display the browser weaves the canvas for the viewer's eyes: the page draws a
// side-by-side pair, the left eye's view in the left half of the canvas and the right eye's in
// the right half, and the browser interleaves them for the panel's optics. The SDK opens the
// page's inline-3D session and hands over the two eye views each frame; everything else stays
// the viewer's own. The camera manager keeps driving the camera entity exactly as in 2D, and the
// engine draws both eyes in one pass through the same `RenderView` path its WebXR support uses
// (`camera.xrViews`), so LOD, culling and the splat sort see the views' real frustum.
//
// Nothing here runs, and the SDK is never fetched, unless the mode is asked for (the `3d` url
// param, the `display3d` option, or the button that appears only where a 3D display is found).
// The SDK is imported lazily, so the normal bundle does not grow by it.
//
// Two rigs, because an object and a world want different things from the glass. Both are posed
// relative to the camera, and each eye's pose is composed under the camera node, so this frame's
// camera is the one rendered, with no frame of lag (the SDK's "attach pattern").
//
// Looking at an object (orbit, and the turntable that precedes it) uses the display rig: the
// canvas is a window onto the scene and the subject sits in it at its real proportions. The window
// is posed at the orbit pivot and sized to what the 2D camera frames there, so the pivot stays on
// the glass, the framing at the pivot matches 2D, zooming scales the subject, and moving the head
// shows true parallax.
//
// Moving through a world (fly, walk, an authored camera path) uses the camera rig: the runtime
// keeps the camera's lens and skews each eye so the focus distance lands on the glass. That
// distance is carried in from orbit and stays fixed while flying, so what is ahead never goes flat
// from being looked at. The eye separation is scaled by it, so a 10 cm object and a 100 m scene
// get the same comfortable depth.
//
// `display3dDepth` sets the depth of both. Values are passed to the runtime as given: the SDK warns
// about unusual ones and never clamps.

/** The comfort number the camera rig is built to, the SDK's default for a page-owned camera. */
const DEFAULT_DEPTH = 0.3;

// frames the rig spends going flat before the layer is released, so stopping does not cut from
// the woven pair to a squeezed one
const FLATTEN_FRAMES = 10;

// frames spent easing from one rig's eyes to the other's when the camera mode changes
const RIG_BLEND_FRAMES = 30;

// the SDK surface this file uses (see the package's index.d.ts for the full api)
type Viewport = { x: number; y: number; width: number; height: number };
type CameraRig = {
    type: 'camera';
    verticalFov: number;
    convergenceDiopters: number;
    metersToVirtual: number;
    ipdFactor: number;
    parallaxFactor: number;
};
type DisplayRig = {
    type: 'display';
    position: { x: number; y: number; z: number };
    virtualDisplayHeight: number;
    ipdFactor: number;
    parallaxFactor: number;
};
type ViewRig = CameraRig | DisplayRig;
type SceneHandle = { remove(): void; setViewRig(rig: ViewRig): boolean };
type Wall = {
    supported: true;
    liveCount: number;
    addScene(
        canvas: HTMLCanvasElement,
        onFrame: (views: readonly XRView[], layer: { getViewport(view: XRView): Viewport | null }) => void,
        opts: { viewRig: ViewRig; bufferClamped: boolean; onLayerLost: () => void }
    ): SceneHandle;
    close(): void;
};
type Sdk = {
    sharedInline3D(opts: { lazy: boolean }): Promise<Wall | { supported: false; error?: unknown }>;
};

/**
 * Whether this browser can weave a canvas for a glasses-free 3D display. Synchronous and cheap,
 * and it does not load the SDK: it reads the same two things the SDK's `inline3DAvailable()`
 * does, WebXR and the DisplayXR Browser's `XRDisplayLayer`. The session itself is the final word.
 */
const display3dAvailable = () =>
    typeof navigator !== 'undefined' &&
    !!navigator.xr &&
    typeof (window as unknown as { XRDisplayLayer?: unknown }).XRDisplayLayer === 'function';

const DEG = Math.PI / 180;

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const easeInOut = (t: number) => t * t * (3 - 2 * t);

// `out` moved t of the way towards `to`
const lerpInto = (out: Float32Array, to: Float32Array, t: number) => {
    for (let i = 0; i < 16; i++) out[i] += (to[i] - out[i]) * t;
};

// the depth range of a GL projection (col-major), rewritten in place; fov, skew and principal
// point are untouched
const setDepthRange = (p: Float32Array, near: number, far: number) => {
    p[10] = -(far + near) / (far - near);
    p[14] = (-2 * far * near) / (far - near);
};

// a symmetric GL perspective (col-major), for the frames before the first eye views arrive
const perspective = (out: Float32Array, vfov: number, aspect: number, near: number, far: number) => {
    const f = 1 / Math.tan(vfov / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[11] = -1;
    setDepthRange(out, near, far);
};

// The engine reads the camera's fov and aspect for LOD and culling while xrViews is set from the
// XR properties, as its XrManager does for a headset. From the first eye's projection
const frustumOf = (p: Float32Array, near: number, far: number) => ({
    fov: (2 * Math.atan(1 / p[5])) / DEG,
    aspectRatio: p[5] / p[0],
    nearClip: near,
    farClip: far,
    horizontalFov: false
});

/**
 * @param global - The viewer's globals.
 * @param focusDistance - The camera's focus distance in scene units, or null before the camera
 * manager exists.
 * @param authoredPath - Whether the anim camera mode plays an authored path, rather than the
 * turntable the viewer makes up for an object.
 */
const initDisplay3d = (global: Global, focusDistance: () => number | null, authoredPath: boolean) => {
    const { app, config, events, state, camera } = global;
    const { canvas } = app.graphicsDevice;
    const depth = config.display3dDepth ?? DEFAULT_DEPTH;
    // the engine camera behind the camera component, which holds the eye views
    const cam = () => camera.camera.camera;

    // The lens the viewer set on the camera (applyCamera in viewer.ts). While xrViews is set the
    // engine's public fov / near / far getters answer the XR properties set below instead, so
    // read the camera's own fields
    const lens = () => {
        const c = cam() as unknown as { _fov: number; _horizontalFov: boolean; _nearClip: number; _farClip: number };
        return { fov: c._fov, horizontalFov: c._horizontalFov, nearClip: c._nearClip, farClip: c._farClip };
    };

    // the last good eye views, copied field by field: an XRView and its viewport are only valid
    // inside the callback that delivered them, and their fields are prototype getters, so
    // Object.assign or a spread would copy nothing
    const eyes = [0, 1].map(() => ({
        proj: new Float32Array(16),
        pose: new Float32Array(16),
        vp: { x: 0, y: 0, width: 1, height: 1 }
    }));
    let haveViews = false;

    const views = [new RenderView(), new RenderView()];
    const poseMat = new Mat4();
    const eyeMat = new Mat4();
    const projScratch = new Float32Array(16);
    const poseScratch = new Float32Array(16);
    const flatProj = new Float32Array(16);
    let frustumKey = '';

    // the eyes being eased away from, after a rig change
    const blendFrom = [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16) }));
    let blend = 0;
    let lastRigType: ViewRig['type'] | null = null;

    let sdk: Promise<Sdk> | null = null;
    let wall: Wall | null = null;
    let handle: SceneHandle | null = null;
    // bumped by every start and stop, so a start that resolves after a stop does nothing
    let generation = 0;
    let flatten = 0;
    let destroyed = false;

    // the camera's vertical field of view in radians: the viewer's fov is horizontal on a
    // landscape canvas
    const verticalFov = () => {
        const { fov, horizontalFov } = lens();
        const aspect = canvas.width / Math.max(canvas.height, 1);
        return horizontalFov ? 2 * Math.atan(Math.tan((fov * DEG) / 2) / aspect) : fov * DEG;
    };

    // an object is orbited, or spun by the turntable; everything else is moving through a world
    const objectRig = () => state.cameraMode === 'orbit' || (state.cameraMode === 'anim' && !authoredPath);

    // The rig for this frame's camera. `distance` is the camera's focus distance in scene units
    const rig = (): ViewRig => {
        const distance = Math.max(focusDistance() ?? 1, 1e-6);
        const k = flatten > 0 ? flatten / FLATTEN_FRAMES : 1;
        if (objectRig()) {
            // the window sits at the pivot (the camera looks down -z) and shows what the 2D
            // camera frames at that distance. The default depth is the subject's real proportions.
            // Only the eye separation follows it: scaling the head's parallax as well would also
            // scale the viewer's offset from the window, and shear the picture with nobody moving
            return {
                type: 'display',
                position: { x: 0, y: 0, z: -distance },
                virtualDisplayHeight: 2 * distance * Math.tan(verticalFov() / 2),
                ipdFactor: k * (depth / DEFAULT_DEPTH),
                parallaxFactor: k
            };
        }
        return {
            type: 'camera',
            verticalFov: verticalFov(),
            convergenceDiopters: 1 / distance,
            metersToVirtual: (depth * distance) / 0.5,
            ipdFactor: k,
            parallaxFactor: k
        };
    };

    const onFrame = (xrViews: readonly XRView[], layer: { getViewport(view: XRView): Viewport | null }) => {
        // a short view list or a missing viewport is a frame to replay, never one to skip or
        // half-draw: the last good views stay in place
        if (xrViews.length < 2) return;
        const vps = [layer.getViewport(xrViews[0]), layer.getViewport(xrViews[1])];
        if (!vps[0] || !vps[1]) return;
        for (let i = 0; i < 2; i++) {
            const e = eyes[i];
            e.proj.set(xrViews[i].projectionMatrix);
            e.pose.set(xrViews[i].transform.matrix);
            e.vp = { x: vps[i].x, y: vps[i].y, width: vps[i].width, height: vps[i].height };
        }
        haveViews = true;
    };

    // Each render, after the camera manager has placed the camera: the two eyes, composed under
    // the camera node (the engine composes a RenderView's pose with the camera's PARENT, so the
    // pose given is the camera's local transform times the eye's pose in rig space)
    const updateViews = () => {
        const { nearClip, farClip } = lens();
        const local = camera.getLocalTransform();
        const w = app.graphicsDevice.width;
        const h = app.graphicsDevice.height;
        // while stopping, each eye also eases to the 2D camera, so releasing the layer does not cut
        const toFlat = flatten > 0 ? 1 - flatten / FLATTEN_FRAMES : 0;
        if (toFlat > 0) perspective(flatProj, verticalFov(), w / Math.max(h, 1), nearClip, farClip);
        const fromT = blend > 0 ? easeInOut(blend / RIG_BLEND_FRAMES) : 0;
        for (let i = 0; i < 2; i++) {
            if (haveViews) {
                projScratch.set(eyes[i].proj);
                poseScratch.set(eyes[i].pose);
                if (fromT > 0) {
                    lerpInto(projScratch, blendFrom[i].proj, fromT);
                    lerpInto(poseScratch, blendFrom[i].pose, fromT);
                }
                if (toFlat > 0) {
                    lerpInto(projScratch, flatProj, toFlat);
                    lerpInto(poseScratch, IDENTITY, toFlat);
                }
                // the viewer sets near and far from the camera. The eye can be far behind it (the
                // display rig's eye is wherever the window's geometry puts it), so the clip range
                // moves with the eye and still bounds the same part of the scene
                const eyeZ = poseScratch[14];
                setDepthRange(projScratch, Math.max(nearClip + eyeZ, nearClip * 0.1), farClip + Math.max(eyeZ, 0));
                poseMat.data.set(poseScratch);
                eyeMat.mul2(local, poseMat);
                views[i].setView(projScratch, eyeMat.data);
                const { x, y, width, height } = eyes[i].vp;
                views[i].setViewport(x, y, width, height);
            } else {
                // no eyes yet: the camera's own frustum in both halves, never an empty one
                perspective(projScratch, verticalFov(), w / Math.max(h, 1), nearClip, farClip);
                views[i].setView(projScratch, local.data);
                views[i].setViewport((i * w) / 2, 0, w / 2, h);
            }
        }
        if (blend > 0) blend--;
        const f = frustumOf(projScratch, nearClip, farClip);
        const key = `${f.fov.toFixed(4)}|${f.aspectRatio.toFixed(4)}|${nearClip}|${farClip}`;
        if (key !== frustumKey) {
            frustumKey = key;
            cam().setXrProperties(f);
        }
    };

    const release = () => {
        handle?.remove();
        handle = null;
        cam().xrViews = null;
        frustumKey = '';
        haveViews = false;
        flatten = 0;
        blend = 0;
        lastRigType = null;
        app.renderNextFrame = true;
        events.fire('display3d:released');
    };

    const handles = [
        // the woven canvas is read every frame, so it is drawn every frame while it is woven
        app.on('framerender', () => {
            if (handle) app.renderNextFrame = true;
        }),
        app.on('prerender', () => {
            if (!handle) return;
            const next = rig();
            if (haveViews && lastRigType !== null && next.type !== lastRigType) {
                // start from the eyes on screen now, including any blend still running
                const t = blend > 0 ? easeInOut(blend / RIG_BLEND_FRAMES) : 0;
                for (let i = 0; i < 2; i++) {
                    const from = blendFrom[i];
                    for (let j = 0; j < 16; j++) {
                        from.proj[j] = eyes[i].proj[j] + (from.proj[j] - eyes[i].proj[j]) * t;
                        from.pose[j] = eyes[i].pose[j] + (from.pose[j] - eyes[i].pose[j]) * t;
                    }
                }
                blend = RIG_BLEND_FRAMES;
            }
            lastRigType = next.type;
            handle.setViewRig(next);
            if (flatten > 0 && --flatten === 0) {
                release();
                return;
            }
            updateViews();
        })
    ];

    const start = async () => {
        const run = ++generation;
        if (state.xrMode !== null) {
            // an immersive session owns the camera's views
            state.display3d = false;
            return;
        }
        if (global.renderer !== 'webgl') {
            console.warn(
                'display3d: glasses-free 3D displays need the WebGL renderer; reload with the `3d` url param (or `renderer: "webgl"`)'
            );
            state.display3d = false;
            return;
        }
        try {
            sdk ??= import('@displayxr/inline3d') as unknown as Promise<Sdk>;
            const result = await (await sdk).sharedInline3D({ lazy: false });
            if (destroyed || run !== generation) return;
            if (result.supported === false) {
                console.info('display3d: no glasses-free 3D display here, staying 2D', result.error ?? '');
                state.display3d = false;
                return;
            }
            wall = result;
            handle = wall.addScene(canvas, onFrame, {
                viewRig: rig(),
                // the viewer sizes its own canvas within the device limits
                bufferClamped: true,
                // the session ended or the layer could not be made: back to 2D
                onLayerLost: () => {
                    if (!handle) return;
                    release();
                    state.display3d = false;
                }
            });
            updateViews();
            cam().xrViews = views.slice();
            app.renderNextFrame = true;
        } catch (err) {
            console.warn('display3d: could not start', err);
            if (run === generation) state.display3d = false;
        }
    };

    const stop = () => {
        generation++;
        // ease the eye separation to zero, then let the layer go
        if (handle && flatten === 0) flatten = FLATTEN_FRAMES;
    };

    const changed = events.on('display3d:changed', (value: boolean) => {
        if (destroyed) return;
        if (value) {
            // a stop still flattening is undone rather than restarted
            if (handle) {
                flatten = 0;
                return;
            }
            void start();
        } else {
            stop();
        }
    });

    // an immersive session takes the camera's views over, so it ends the mode
    const xrModeChanged = events.on('xrMode:changed', (mode: string | null) => {
        if (mode) state.display3d = false;
    });

    state.hasDisplay3d = display3dAvailable();
    if (state.display3d) void start();

    return {
        // the eye views are in place, or still easing out after the mode was turned off
        active: () => state.display3d || handle !== null,
        destroy: () => {
            destroyed = true;
            generation++;
            changed.off();
            xrModeChanged.off();
            for (const h of handles) h.off();
            if (handle) release();
            if (wall && wall.liveCount === 0) wall.close();
            wall = null;
        }
    };
};

export { display3dAvailable, initDisplay3d };
