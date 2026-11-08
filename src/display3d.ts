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
// Orbit, and the turntable that precedes it, uses the display rig: the canvas is a window posed at
// the orbit pivot and sized to what the 2D camera frames there, so the pivot stays on the glass and
// zooming scales the subject. Moving through a world (fly, walk, an authored camera path) uses the
// camera rig: the focus distance lands on the glass and stays fixed while flying, so what is ahead
// never goes flat from being looked at.
//
// A change of camera mode changes the rig and nothing on screen: each rig is computed as the exact
// equivalent of the other, so it is one picture in two descriptions. What sets the picture is the
// look, chosen when the stereo has faded in and kept until the mode is turned off:
//
//   panel: the eyes see at the panel's own angle of view, and the subject has its real proportions.
//          For an object seen from outside, with the camera's focus near its centre.
//   lens:  the eyes see at the 2D camera's lens. For everything else, and on the way in and out.
//
// The look only changes when the mode opens or closes, eased, never on a change of camera mode.
//
// The controls with no 2D equivalent are depth, which sets the eye separation and the response to
// the head together, and on the camera rig the convergence, which moves the glass off the focus
// distance. Values are passed to the runtime as given: the SDK warns about unusual ones and never
// clamps.

/** The comfort number the camera rig is built to, the SDK's default for a page-owned camera. */
const DEFAULT_DEPTH = 0.3;

// How the mode turns on and off without a visible cut. Stereo fades in and out on the camera rig,
// with both eyes on the 2D camera at the flat end, so what is on screen at that end is the 2D
// picture. The canvas does not change size between the modes, so a full-width frame on a canvas
// that is still being woven would be split into a pair, and the pair on one no longer woven would
// show raw. So the swap happens under a cover: a still of that same picture, in the canvas's place.
//
//   off: display rig -> camera rig -> fade to flat -> cover -> release the layer -> 2D frame -> uncover
//   on:  cover -> layer, panel to 3D -> first woven frame -> uncover -> fade in -> display rig

// how long the depth takes to fade in or out
const FADE_MS = 500;

// frames to let the cover land before releasing the layer under it
const COVER_LAND_FRAMES = 2;

// the cover stays until the layer's release has landed and the canvas is a plain 2D layer again
const COVER_CLEAR_FRAMES = 6;
const COVER_CLEAR_MS = 150;

// the longest the cover waits for the first woven frame; the SDK's answer normally comes well before
const COVER_HOLD_MAX_MS = 5000;

// frames spent easing from one look's eyes to the other's, as the mode opens and closes
const RIG_BLEND_FRAMES = 30;

// the SDK surface this file uses (see the package's index.d.ts for the full api)
type Viewport = { x: number; y: number; width: number; height: number };
type CameraRig = {
    type: 'camera';
    position?: { x: number; y: number; z: number };
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
    perspectiveFactor: number;
    ipdFactor: number;
    parallaxFactor: number;
};
type ViewRig = CameraRig | DisplayRig;
type DisplayMetrics = { canvasSizeM: [number, number] };
type SceneHandle = {
    remove(): void;
    setViewRig(rig: ViewRig): boolean;
    displayMetrics(): Promise<DisplayMetrics>;
    firstWoven: Promise<unknown>;
};
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
 * @param setFocusDistance - Moves the camera's focus along its view, leaving its pose unchanged.
 * @param authoredPath - Whether the anim camera mode plays an authored path, rather than the
 * turntable the viewer makes up for an object.
 * @param centredOnObject - Whether the scene is an object seen from outside, with the camera's
 * focus within this fraction of its size from its centre.
 */
const initDisplay3d = (
    global: Global,
    focusDistance: () => number | null,
    setFocusDistance: (distance: number) => void,
    authoredPath: boolean,
    centredOnObject: (margin: number) => boolean
) => {
    const { app, events, state, camera } = global;
    const { canvas } = app.graphicsDevice;
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
        vp: { x: 0, y: 0, width: 1, height: 1 },
        distance: 1,
        plane: 1
    }));
    // the rigs last sent, oldest first: the eye views of a frame are made from the rig sent two
    // frames before it
    const sent = [
        { distance: 1, plane: 1 },
        { distance: 1, plane: 1 }
    ];
    // the eye between the two, in the camera's parent's space, and its projection: see pickView
    const betweenEyes = { position: [0, 0, 0], z: 0, projection: new Float32Array(16) };
    let haveViews = false;

    const views = [new RenderView(), new RenderView()];
    const poseMat = new Mat4();
    const eyeMat = new Mat4();
    const projScratch = new Float32Array(16);
    const poseScratch = new Float32Array(16);
    const flatProj = new Float32Array(16);
    let frustumKey = '';

    // the eyes being eased away from, after a change of look
    const blendFrom = [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16) }));
    let blend = 0;
    // the look (see the top of this file), and whether it has been chosen since the mode opened
    let panelLook = false;
    let lastPanelLook = false;
    let lookChosen = false;
    // the canvas's height on the panel and the nominal viewer distance, in metres
    let physical: { height: number; viewer: number } | null = null;
    // tan(fov / 2) of the eyes on the first frame: see `rig`
    let measuredTan: number | null = null;

    let sdk: Promise<Sdk> | null = null;
    let wall: Wall | null = null;
    let handle: SceneHandle | null = null;
    // bumped by every start and stop, so a start that resolves after a stop does nothing
    let generation = 0;
    // off -> opening (cover up, loading) -> live (the layer is bound) -> closing (under the cover)
    let phase: 'off' | 'opening' | 'live' | 'closing' = 'off';
    // the mode has been turned off, and is on its way out
    let stopping = false;
    // the stereo fade: 0 is both eyes on the 2D camera, 1 is the full rig
    let k = 1;
    let fade: { from: number; to: number; t0: number } | null = null;
    // waiting for the first woven frame, under the cover
    let holding = false;
    let closeDue = false;
    let cover: HTMLCanvasElement | null = null;
    let pausedAnimation = false;
    let drawnOnce = false;
    let destroyed = false;
    // captures in progress: they render the camera's own 2D view, not the eyes
    let suspended = 0;

    // the camera's vertical field of view in radians: the viewer's fov is horizontal on a
    // landscape canvas
    const verticalFov = () => {
        const { fov, horizontalFov } = lens();
        const aspect = canvas.width / Math.max(canvas.height, 1);
        return horizontalFov ? 2 * Math.atan(Math.tan((fov * DEG) / 2) / aspect) : fov * DEG;
    };

    // orbiting, or the turntable the viewer makes up for an object
    const orbiting = () => state.cameraMode === 'orbit' || (state.cameraMode === 'anim' && !authoredPath);
    // the stereo has faded all the way in, and is not on the way out
    const settled = () => phase === 'live' && !stopping && !holding && k === 1;

    const updateLook = () => {
        if (stopping) {
            panelLook = false;
            lookChosen = false;
        } else if (!lookChosen && physical && settled()) {
            lookChosen = true;
            panelLook = orbiting() && centredOnObject(0.25);
        }
    };

    // The rig for this frame's camera, the same picture in either description. With the window at
    // the focus distance d and H_v tall, panel height H and nominal viewer distance N, the display
    // rig's eye scale is s = perspective * H_v / H, its eyes sit s * N in front of the window, and
    // they see at tan(fov / 2) = H / (2 * N * perspective). The camera rig matches each of those.
    const rig = (): ViewRig => {
        const distance = Math.max(focusDistance() ?? 1, 1e-6);
        const tanLens = Math.tan(verticalFov() / 2);
        const height = 2 * distance * tanLens;
        // The equivalence needs the viewer distance the runtime uses, which not every browser
        // reports. So the mode opens on a display rig with no eye separation and no head tracking,
        // under the cover, and the eyes of that first frame are at the nominal viewer: their angle
        // of view, with the canvas's height, is that distance
        if (measuredTan === null) {
            return {
                type: 'display',
                position: { x: 0, y: 0, z: -distance },
                virtualDisplayHeight: height,
                perspectiveFactor: 1,
                ipdFactor: 0,
                parallaxFactor: 0
            };
        }
        const displayRig = settled() && orbiting();
        const depth = state.display3dDepth;
        const convergence = state.display3dConvergence;
        const plane = distance * convergence;
        if (physical) {
            const tanPanel = physical.height / (2 * physical.viewer);
            if (panelLook) {
                const factor = k * (depth / DEFAULT_DEPTH);
                if (displayRig) {
                    return {
                        type: 'display',
                        position: { x: 0, y: 0, z: -plane },
                        virtualDisplayHeight: height * convergence,
                        perspectiveFactor: 1,
                        ipdFactor: factor / convergence,
                        parallaxFactor: factor / convergence
                    };
                }
                const scale = height / physical.height;
                const eyeDistance = scale * convergence * physical.viewer;
                return {
                    type: 'camera',
                    position: { x: 0, y: 0, z: eyeDistance - plane },
                    verticalFov: 2 * Math.atan(tanPanel),
                    convergenceDiopters: 1 / eyeDistance,
                    metersToVirtual: scale,
                    ipdFactor: factor,
                    parallaxFactor: factor
                };
            }
            if (displayRig) {
                // the camera rig below, with its eyes where the camera is: the perspective factor
                // is what turns the camera's lens into the window's
                const factor = (k * depth * physical.viewer) / (0.5 * convergence);
                return {
                    type: 'display',
                    position: { x: 0, y: 0, z: -plane },
                    virtualDisplayHeight: height * convergence,
                    perspectiveFactor: tanPanel / tanLens,
                    ipdFactor: factor,
                    parallaxFactor: factor
                };
            }
        }
        return {
            type: 'camera',
            verticalFov: verticalFov(),
            convergenceDiopters: 1 / plane,
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
            e.distance = sent[0].distance;
            e.plane = sent[0].plane;
            if (measuredTan === null && i === 1) measuredTan = 1 / e.proj[5];
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
        // the fade also eases each eye to the 2D camera, so its flat end is the 2D picture exactly
        const toFlat = 1 - k;
        if (toFlat > 0) perspective(flatProj, verticalFov(), w / Math.max(h, 1), nearClip, farClip);
        const fromT = blend > 0 ? easeInOut(blend / RIG_BLEND_FRAMES) : 0;
        const distance = Math.max(focusDistance() ?? 1, 1e-6);
        for (let i = 0; i < 2; i++) {
            if (haveViews) {
                projScratch.set(eyes[i].proj);
                poseScratch.set(eyes[i].pose);
                // A rig reaches the eye views two frames late, and the camera has already moved. Both
                // rigs scale with the focus distance about the plane at that distance, so moving the
                // eyes the same way gives this frame's rig, with the frustum as it is. A zoom is then
                // the camera's own move, with the plane on the pivot all the way
                const scale = distance / eyes[i].distance;
                poseScratch[12] *= scale;
                poseScratch[13] *= scale;
                poseScratch[14] = (poseScratch[14] + eyes[i].plane) * scale - distance * state.display3dConvergence;
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
                betweenEyes.z = (i === 0 ? 0 : betweenEyes.z) + poseScratch[14] / 2;
                for (let j = 0; j < 3; j++) {
                    betweenEyes.position[j] = (i === 0 ? 0 : betweenEyes.position[j]) + eyeMat.data[12 + j] / 2;
                }
                for (let j = 0; j < 16; j++) {
                    betweenEyes.projection[j] = (i === 0 ? 0 : betweenEyes.projection[j]) + projScratch[j] / 2;
                }
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

    // a still of this part of the canvas, in the canvas's place. Called just after a frame is drawn,
    // while the canvas's pixels can be read
    const raiseCover = (x: number, y: number, width: number, height: number) => {
        const gl = (app.graphicsDevice as unknown as { gl: WebGL2RenderingContext }).gl;
        const bound = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        const pixels = new Uint8ClampedArray(width * height * 4);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bound);
        // the rows arrive bottom-up
        const flipped = new Uint8ClampedArray(pixels.length);
        const stride = width * 4;
        for (let row = 0; row < height; row++) {
            flipped.set(pixels.subarray(row * stride, (row + 1) * stride), (height - 1 - row) * stride);
        }
        const next = document.createElement('canvas');
        next.width = width;
        next.height = height;
        next.getContext('2d').putImageData(new ImageData(flipped, width, height), 0, 0);
        const { style } = next;
        const computed = getComputedStyle(canvas);
        style.position = computed.position === 'fixed' ? 'fixed' : 'absolute';
        style.left = `${canvas.offsetLeft}px`;
        style.top = `${canvas.offsetTop}px`;
        style.width = `${canvas.offsetWidth}px`;
        style.height = `${canvas.offsetHeight}px`;
        style.zIndex = computed.zIndex;
        style.pointerEvents = 'none';
        // right after the canvas, so whatever the viewer draws over the canvas stays over the cover
        canvas.after(next);
        cover?.remove();
        cover = next;
    };

    const dropCover = () => {
        cover?.remove();
        cover = null;
    };

    // the camera would carry on behind a still, and jump when it lifts
    const pauseAnimation = () => {
        if (state.cameraMode === 'anim' && !state.animationPaused) {
            pausedAnimation = true;
            state.animationPaused = true;
        }
    };
    const resumeAnimation = () => {
        if (pausedAnimation) state.animationPaused = false;
        pausedAnimation = false;
    };

    const afterFrames = (frames: number, minMs: number, done: () => void) => {
        const t0 = performance.now();
        let count = 0;
        const step = () => {
            if (destroyed) return;
            if (++count >= frames && performance.now() - t0 >= minMs) done();
            else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    };

    const startFade = (to: number) => {
        fade = { from: k, to, t0: performance.now() };
    };

    const tickFade = () => {
        if (!fade) return;
        const u = Math.min((performance.now() - fade.t0) / FADE_MS, 1);
        k = fade.from + (fade.to - fade.from) * easeInOut(u);
        if (u === 1) {
            k = fade.to;
            fade = null;
        }
    };

    // let the layer and the session go, and the camera have its own view back
    const release = () => {
        panelLook = false;
        lastPanelLook = false;
        lookChosen = false;
        physical = null;
        measuredTan = null;
        handle?.remove();
        handle = null;
        if (wall && wall.liveCount === 0) wall.close();
        wall = null;
        cam().xrViews = null;
        frustumKey = '';
        haveViews = false;
        blend = 0;
        holding = false;
        closeDue = false;
        fade = null;
        k = 1;
        app.renderNextFrame = true;
        events.fire('display3d:released');
    };

    // at once, with nothing to wait for: the session has gone, or something else needs the camera
    const releaseNow = () => {
        generation++;
        release();
        dropCover();
        resumeAnimation();
        stopping = false;
        phase = 'off';
    };

    const closeUnderCover = () => {
        const run = ++generation;
        phase = 'closing';
        // both eyes are the 2D picture now, so one of them is the still
        const { x, y, z, w } = views[0].viewport;
        raiseCover(x, y, z, w);
        afterFrames(COVER_LAND_FRAMES, 0, () => {
            if (run !== generation) return;
            release();
            afterFrames(COVER_CLEAR_FRAMES, COVER_CLEAR_MS, () => {
                if (run !== generation) return;
                dropCover();
                resumeAnimation();
                stopping = false;
                phase = 'off';
                // turned back on while closing
                if (state.display3d) void start();
            });
        });
    };

    const readPhysical = () => {
        void handle?.displayMetrics().then((m) => {
            if (!handle || measuredTan === null) return;
            const height = m.canvasSizeM[1];
            // measured once: the viewer stays where the runtime puts it when the canvas resizes
            physical = { height, viewer: physical?.viewer ?? height / (2 * measuredTan) };
        });
    };

    const handles = [
        // the woven canvas is read every frame, so it is drawn every frame while it is woven
        app.on('framerender', () => {
            if (handle) app.renderNextFrame = true;
        }),
        app.on('prerender', () => {
            if (!handle) return;
            tickFade();
            updateLook();
            const next = rig();
            if (haveViews && panelLook !== lastPanelLook) {
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
            lastPanelLook = panelLook;
            const sentDistance = Math.max(focusDistance() ?? 1, 1e-6);
            sent.push({ distance: sentDistance, plane: sentDistance * state.display3dConvergence });
            sent.shift();
            state.display3dCameraRig = next.type === 'camera';
            handle.setViewRig(next);
            if (stopping && phase === 'live' && !holding) {
                if (k === 0 && !fade) {
                    closeDue = true;
                } else if (next.type === 'camera' && blend === 0 && (!fade || fade.to !== 0)) {
                    // on the lens look now: fade out
                    startFade(0);
                }
            }
            if (!suspended) updateViews();
        }),
        app.on('frameend', () => {
            if (closeDue) {
                closeDue = false;
                closeUnderCover();
            }
        })
    ];

    const firstFrame = events.once('firstFrame', () => {
        drawnOnce = true;
    });

    // the 2D picture just drawn, as the cover the layer joins under
    const coverCurrentFrame = () =>
        new Promise<void>((resolve) => {
            app.once('frameend', () => {
                if (!destroyed) raiseCover(0, 0, canvas.width, canvas.height);
                resolve();
            });
            app.renderNextFrame = true;
        });

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
        phase = 'opening';
        stopping = false;
        const giveUp = () => {
            dropCover();
            resumeAnimation();
            phase = 'off';
            // turned off and on again while this was still opening
            if (!destroyed && run !== generation && state.display3d) void start();
        };
        try {
            // before the first frame the viewer's own loading screen is up, and there is nothing to hold
            if (drawnOnce) {
                pauseAnimation();
                await coverCurrentFrame();
                if (destroyed || run !== generation) {
                    giveUp();
                    return;
                }
            }
            sdk ??= import('@displayxr/inline3d') as unknown as Promise<Sdk>;
            const result = await (await sdk).sharedInline3D({ lazy: false });
            if (destroyed || run !== generation) {
                giveUp();
                return;
            }
            if (result.supported === false) {
                console.info('display3d: no glasses-free 3D display here, staying 2D', result.error ?? '');
                giveUp();
                state.display3d = false;
                return;
            }
            wall = result;
            k = 0;
            fade = null;
            holding = true;
            phase = 'live';
            handle = wall.addScene(canvas, onFrame, {
                viewRig: rig(),
                // the viewer sizes its own canvas within the device limits
                bufferClamped: true,
                // the session ended or the layer could not be made: back to 2D
                onLayerLost: () => {
                    if (!handle) return;
                    releaseNow();
                    state.display3d = false;
                }
            });
            updateViews();
            cam().xrViews = views.slice();
            app.renderNextFrame = true;
            const timeout = new Promise((resolve) => {
                setTimeout(resolve, COVER_HOLD_MAX_MS);
            });
            void Promise.race([handle.firstWoven, timeout]).then(() => {
                readPhysical();
                if (destroyed || !holding) return;
                holding = false;
                dropCover();
                resumeAnimation();
                if (!stopping) startFade(1);
            });
        } catch (err) {
            console.warn('display3d: could not start', err);
            if (run === generation) state.display3d = false;
            giveUp();
        }
    };

    // the canvas's size on the panel changes with it, and the rigs' equivalence depends on it
    const resized = app.graphicsDevice.on('resizecanvas', readPhysical);

    const changed = events.on('display3d:changed', (value: boolean) => {
        if (destroyed) return;
        if (value) {
            if (phase === 'off') {
                void start();
            } else if (phase === 'live') {
                // turned back on on the way out: fade back up, unless still waiting to go up at all
                stopping = false;
                if (!holding) startFade(1);
            }
            // while closing, the close starts it again when it is done
        } else if (phase === 'opening') {
            // not started yet: its next step finds the generation moved on, and gives up
            generation++;
        } else if (phase === 'live') {
            stopping = true;
            // while still waiting for the first woven frame there is no depth to fade
            if (holding) {
                holding = false;
                k = 0;
                fade = null;
            }
        }
    });

    // Back to orbiting, the orbit's centre becomes whatever sits on the glass: the focus moves out
    // to the plane and convergence returns to 1, so the plane, and every eye, stay where they are.
    // This runs before the camera manager's own handler, which enters the orbit from that focus.
    // The rigs still on their way to the eye views were made for the same plane, so they are
    // relabelled to the focus they now stand for, or the zoom compensation would see a zoom
    const modeChanged = events.on('cameraMode:changed', (value: string, prev: string) => {
        const c = state.display3dConvergence;
        if (!handle || value !== 'orbit' || prev === 'orbit' || c === 1) return;
        const distance = focusDistance();
        if (distance === null) return;
        setFocusDistance(distance * c);
        for (const rig of sent) rig.distance = rig.plane;
        for (const e of eyes) e.distance = e.plane;
        state.display3dConvergence = 1;
    });

    // an immersive session takes the camera's views over, so it ends the mode
    const xrModeChanged = events.on('xrMode:changed', (mode: string | null) => {
        if (!mode) return;
        if (handle) releaseNow();
        state.display3d = false;
    });

    state.hasDisplay3d = display3dAvailable();
    if (state.display3d) void start();

    return {
        // the eye views are in place, or still easing out after the mode was turned off
        active: () => state.display3d || handle !== null,
        // What a click on the canvas looks through: the tracked eye between the two. A point on the
        // glass is seen along the line from there, which is not the line from the 2D camera
        pickView: () => {
            if (!handle || !haveViews || suspended > 0) return null;
            const { nearClip, farClip } = lens();
            // the clip range follows the eye, as it does for the eyes themselves
            const near = Math.max(nearClip + betweenEyes.z, nearClip * 0.1);
            const far = farClip + Math.max(betweenEyes.z, 0);
            const projection = betweenEyes.projection.slice();
            setDepthRange(projection, near, far);
            return { position: betweenEyes.position.slice() as [number, number, number], projection, near, far };
        },
        // hand the camera back its own view for a capture; the returned function undoes it
        suspend: () => {
            suspended++;
            cam().xrViews = null;
            return () => {
                if (--suspended === 0 && handle) cam().xrViews = views.slice();
                app.renderNextFrame = true;
            };
        },
        destroy: () => {
            destroyed = true;
            generation++;
            changed.off();
            firstFrame.off();
            xrModeChanged.off();
            modeChanged.off();
            resized.off();
            for (const h of handles) h.off();
            release();
            dropCover();
        }
    };
};

export { display3dAvailable, initDisplay3d };
