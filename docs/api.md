# API Reference

Embedding, runtime control and settings for `@playcanvas/supersplat-viewer`.

## Embedding the viewer

If you generate a page around the viewer, use `renderViewerHtml`. It returns a complete
document, with your asset URLs and settings supplied through a single JSON block:

```ts
import { renderViewerHtml } from '@playcanvas/supersplat-viewer';

const document = renderViewerHtml({
    bootstrap: {
        settings,                      // an object, or omit and set settingsUrl
        contentUrl: 'scene.sog',
        posterUrl: 'poster.jpg'
    },
    baseHref: '/viewer/',              // serving from a sub-path
    backgroundColor: [0, 0, 0],        // components are 0..1, not 0..255
    headExtras: '<script src="analytics.js"></script>',
    inlineCss: true                    // no sibling index.css needed
});
```

Called with no options it returns the document the package ships, unmodified. URL parameters
on the served page override the bootstrap's asset URLs, so an embed stays overridable per
instance — except an inline `settings` object, which takes precedence over `?settings=`.

Set both `inlineCss` and `inlineJs` for a single self-contained file, with the splat passed as
a `data:` URI in `contentUrl` and the settings supplied inline through the bootstrap's
`settings` object — without an inline settings object the page still fetches `./settings.json`
from a sibling file. A `data:` URI has no filename and the splat format is chosen by the
name's extension, so name its content with the bootstrap's `contentFilename` (e.g.
`scene.sog`). The flags are independent, so a server that serves the bundle from its own
route can inline only the stylesheet.

`html` is still exported as a raw string, but is **deprecated**: its formatting is not part of
this package's API and changes between releases, so pattern-matching it is unsupported. `css`
and `js` remain exported for serving (or writing) the stylesheet and bundle alongside a
rendered document that doesn't inline them.

## Creating a viewer in your own page

The `/viewer` subpath creates the viewer inside an element you supply, for an app that owns its
own page. `playcanvas` is a peer dependency of this entry, so your copy of the engine is the
one used:

```ts
import { createViewer } from '@playcanvas/supersplat-viewer/viewer';
import '@playcanvas/supersplat-viewer/viewer.css';

const viewer = await createViewer({
    container: document.getElementById('viewer'),   // you size it; the viewer fills it
    settings: './settings.json',                    // a URL, or a settings object
    contentUrl: './scene.sog',
    posterUrl: './poster.jpg'                       // optional, as are the other assets
});
```

The viewer builds its own subtree (canvas, UI and icons) inside the container, so **the
container needs a size**: an element with no height renders nothing. Every option other than
`container`, `settings` and `contentUrl` is optional; the switches are the programmatic form of
the [URL parameters](../README.md#url-parameters).

`createViewer` resolves once the graphics device exists and loading has started, not once the
scene is visible. It returns:

| Member | Purpose |
| --- | --- |
| `state` | Observable state. Writable keys (`cameraMode`, `performanceMode`, `showAnnotations`, `gamingControls`, `animationPaused`, `collisionOverlayEnabled`, `controlsHidden`, `inputEnabled`) apply at once; the rest are the viewer's to report and are `readonly` in the types |
| `events` | Fires `<key>:changed` with `(value, previous)` for every key of `state` |
| `annotations` | Annotation data in settings order, available as soon as creation resolves. Editing entries is unsupported |
| `captureFrame(options?)` | Renders offscreen, supersampled, and resolves to `{ width, height, data }` with `data` base64. Waits for the first frame |
| `seek(time)` | Selects the animation camera and seeks in seconds, preserving pause state. Requires a loaded viewer with an animation; throws for non-finite time or after destruction. Requests rendering without waiting for a frame |
| `frameScene()` | Frames the whole scene, in orbit mode; requires `state.loaded` |
| `resetCamera()` | Restores the fly/walk entry spawn, or the authored initial view in orbit mode; requires `state.loaded` |
| `toggleWalk()` | Enters walk mode or restores the previous mode. Does nothing if `walkAllowed` is false; requires `state.loaded` |
| `selectAnnotation(index)` | Selects a zero-based annotation index and transitions to its orbit camera. Pass `null` to clear selection without starting another camera movement; requires `state.loaded` |
| `requestFullscreen()` / `exitFullscreen()` | Enter or leave fullscreen for this viewer. Return promises; available before scene readiness |
| `startXR('ar' \| 'vr')` / `endXR()` | Start or end an immersive session. Return promises; starting requires `state.loaded` |
| `destroy()` | Releases the engine application, the graphics context, every listener and the subtree. Idempotent |
| `app` | The underlying PlayCanvas application, for anything this API doesn't cover |

Wait for the first frame through `state`, which is also how you'd drive a loading indicator:

```ts
viewer.events.on('progress:changed', (progress) => console.log(`${progress}%`));
viewer.events.on('loaded:changed', () => console.log('first frame rendered'));
```

Several viewers can share a page. Each owns its subtree and its own engine application, and
nothing is published to `window` unless you ask for it with `exposeGlobals`. Keyboard and
gamepad input is the exception, because those listeners cannot be routed by hit-testing: clear
`state.inputEnabled` on the instances that should ignore them, and while your own controls have
focus.

Always `destroy()` a viewer you are finished with. Browsers cap live WebGL contexts at around
16, so a component that mounts and unmounts without tearing down will stop rendering.

### Controlling playback

The host and built-in playback controls use the same API. Host changes update the buttons and timeline automatically; the same calls work with `ui: false` and custom controls. Read the current state when attaching controls, then subscribe to its change events.

```ts
const stopAt = (seconds: number) => {
    viewer.state.animationPaused = true;
    viewer.seek(seconds);
};

// Seek requires the first complete frame, unlike createViewer's creation promise.
if (viewer.state.loaded) {
    stopAt(3);
} else {
    viewer.events.once('loaded:changed', () => stopAt(3));
}

// Resume, including when another camera mode is active.
const play = () => {
    viewer.state.cameraMode = 'anim';
    viewer.state.animationPaused = false;
};
```

`animationTime`, `animationDuration` and `hasAnimation` are read-only observations. Seeking wraps repeat tracks and clamps once and ping-pong tracks to their duration. It preserves pause state; pause first to stop at the requested time. Hosts can pause from `animationTime:changed` to respond to a playback threshold, at the viewer's update cadence.

Dragging the built-in timeline pauses playback. Releasing or cancelling the drag does not restore an earlier pause flag, so it cannot undo a host command issued during scrubbing. Use Play to resume. The standalone `window.scrubTo` hook retains its pause-and-wait-for-frame behavior; `seek()` itself is synchronous.

### Controlling the camera

After loading, set `viewer.state.cameraMode` to select orbit, fly or animation mode. Check `state.walkAllowed` before selecting walk mode; it requires collision data and a scene large enough to walk in. `toggleWalk()` provides the built-in walk button's behavior, returning to the previous mode on the next call, including when the host entered walk by writing the state directly. Mode changes update the built-in buttons automatically.

`frameScene()` switches to orbit and frames the full scene. `resetCamera()` preserves fly/walk mode and restores the spawn recorded when that mode was entered; from orbit or animation it restores the authored initial view in orbit mode, falling back to scene framing when no initial view exists. Both start a camera transition and return immediately. These commands work with the built-in UI or with `ui: false`.

Camera commands throw before `state.loaded` or after destruction, matching `seek()`. In particular, `frameScene()` now reports those invalid calls instead of silently doing nothing. Desktop gaming controls still depend on the browser's pointer-lock rules; enter them from a user gesture.

### Controlling annotations

`viewer.annotations` contains each annotation's title, text, position, camera and optional extras. Indices follow settings order and stay fixed for the instance. Treat the data as read-only; runtime annotation editing is not supported.

`state.selectedAnnotation` is the selected index, or `null` when nothing is selected. Observe `selectedAnnotation:changed` to update custom controls or panels; it fires when the index changes. The built-in hotspots and previous/next buttons use the same `selectAnnotation(index)` command as the host:

```ts
viewer.events.on('selectedAnnotation:changed', (index, previous) => {
    const annotation = index === null ? null : viewer.annotations[index];
    console.log('Selected annotation', annotation, 'previous index', previous);
});

const selectFirst = () => {
    if (viewer.annotations.length) viewer.selectAnnotation(0);
};
if (viewer.state.loaded) selectFirst();
else viewer.events.once('loaded:changed', selectFirst);
```

Selection switches to orbit and transitions to the annotation's authored camera without changing the animation pause flag. Selecting the same index again navigates again. `selectAnnotation(null)` clears selection while leaving the camera and any transition alone. Commands return immediately and throw before readiness, after destruction, or for an index that is not an integer in range. Clearing an empty annotation list is valid.

With `ui: false`, the same data, selection and camera navigation are available; the host supplies presentation. `state.showAnnotations` controls built-in visibility and does not clear selection, so showing annotations again restores the selected panel. The built-in navigator retains its last title and navigation position after dismissal. Clicking elsewhere inside this viewer clears selection; clicking host controls or another viewer does not.

### Fullscreen and XR

Fullscreen and XR commands work with the built-in controls or `ui: false`. Call entry commands directly from a user gesture, such as a button click, and handle their rejected promises when the browser refuses permission. Fullscreen does not require scene readiness; XR entry requires `state.loaded`.

```ts
fullscreenButton.addEventListener('click', () => {
    viewer.requestFullscreen().catch(showError);
});
vrButton.addEventListener('click', () => {
    viewer.startXR('vr').catch(showError);
});
viewer.events.on('isFullscreen:changed', updateControls);
viewer.events.on('xrMode:changed', updateControls);
```

Native fullscreen targets this viewer's root. Read-only `state.isFullscreen` follows browser entry and exit, including Escape, and the built-in buttons follow host commands. `exitFullscreen()` is a no-op when another element owns fullscreen. Without native fullscreen support, an iframe retains the legacy `requestFullscreen` / `exitFullscreen` parent messages: the promise resolves when sent and `isFullscreen` reports the requested state, because that bridge has no acknowledgement. An unsupported top-level page rejects entry. Automatic entry/exit on orientation changes remains a built-in UI policy; replacement controls choose their own policy.

`state.canStartAR` and `state.canStartVR` report availability on the current renderer. `hasAR` and `hasVR` also include sessions that could work after a WebGL reload. Subscribe to their change events because capability checks can finish after creation. The built-in UI offers the reload prompt; `startXR()` itself never reloads the page and rejects when the current renderer cannot host the session. Browser permission and device availability can still prevent entry.

Read-only `state.xrMode` is `'ar'`, `'vr'` or `null` and follows both API and browser-initiated session exit. `startXR()` resolves when the session starts; it rejects invalid modes and attempts while a session is active, starting or ending. `endXR()` resolves on session exit, is a no-op while idle, and rejects during startup or another pending exit. All four methods reject after destruction; destruction also rejects outstanding API waits. Browser session requests themselves cannot be cancelled, so native XR teardown while a permission request is open still needs device testing.

### Restyling

The colours the UI is built from are CSS custom properties on the instance root, so you can
retheme it without replacing anything:

```css
#viewer .sse-viewer {
    --sse-accent: #09f;                 /* highlights, active toggles, the timeline */
    --sse-bkg: #204;                    /* panels; translucent surfaces derive from it */
    --sse-text-light: #fff;
}
```

The full set is `--sse-text`, `--sse-text-light`, `--sse-text-dark`, `--sse-text-darkest`,
`--sse-accent`, `--sse-grip`, `--sse-bkg`, `--sse-bkg-dark`, `--sse-bkg-darkest` and
`--sse-bkg-light`.

For more than a retheme, pass `ui: false`. The viewer creates the canvas and retains core input handling, including keyboard/gamepad input gated by `state.inputEnabled`. It omits the overlay, annotation presentation and built-in controls; render your own controls through the viewer handle. Note that the touch joystick, the fullscreen button and
the AR/VR fallback prompt are part of the UI you are replacing, so those affordances become
yours too. Everything between the two, replacing some of the UI but keeping the rest, is not
supported yet; the class names inside the viewer are not API and do change.

## Settings

The `/settings` subpath exports the schema types plus helpers for generating, validating and
migrating a `settings.json` file:

```ts
import {
    defaultSettings,
    importSettings,
    validateSettings,
    POST_EFFECT_RANGES,
    type ExperienceSettings
} from '@playcanvas/supersplat-viewer/settings';

// a complete settings object every tool agrees on; pass 'object' to frame a subject
// from outside rather than a captured space from within
const settings: ExperienceSettings = defaultSettings();

// throws on invalid input, naming the offending field
validateSettings(json);

// additionally check the authoring bounds — stricter than what the viewer will render,
// so existing files may fail. Producers writing new settings should enable it
validateSettings(json, { limits: true });

// migrates older versions forward; does not mutate its argument
const migrated = importSettings(json);

// the bounds are data, so an editor UI can drive a slider from the same numbers
const { min, max, step } = POST_EFFECT_RANGES.bloom.intensity;
```

`CAMERA_FOV_RANGE`, `POST_EFFECT_RANGES`, `ANIM_TRACK_LIMITS` and `ANNOTATION_LIMITS` are
exported as data, so an editor UI can drive sliders from the same bounds the validator uses.
They are frozen at runtime.

## Settings Schema

The `settings.json` file uses the schema below (defined in TypeScript and exported from `@playcanvas/supersplat-viewer/settings`). Legacy v1 settings produced by older SuperSplat releases are automatically migrated to v2 on load.

```typescript
type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
            fov: number[],
        }
    }
};

type CameraPose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type Camera = {
    initial: CameraPose
};

type Annotation = {
    position: [number, number, number],
    title: string,
    text: string,
    extras?: any,
    camera: Camera
};

type PostEffectSettings = {
    sharpness: { enabled: boolean, amount: number },
    bloom:     { enabled: boolean, intensity: number, blurLevel: number },
    grading:   { enabled: boolean, brightness: number, contrast: number, saturation: number, tint: [number, number, number] },
    vignette:  { enabled: boolean, intensity: number, inner: number, outer: number, curvature: number },
    fringing:  { enabled: boolean, intensity: number }
};

type ExperienceSettings = {
    version: 2,
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral',
    highPrecisionRendering: boolean,
    soundUrl?: string,
    background: {
        color: [number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,
    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],
    startMode: 'default' | 'animTrack' | 'annotation'
};
```

### Example settings.json

```json
{
    "version": 2,
    "tonemapping": "none",
    "highPrecisionRendering": false,
    "background": {
        "color": [0, 0, 0]
    },
    "postEffectSettings": {
        "sharpness": { "enabled": false, "amount": 0 },
        "bloom":     { "enabled": false, "intensity": 0.1, "blurLevel": 2 },
        "grading":   { "enabled": false, "brightness": 1, "contrast": 1, "saturation": 1, "tint": [1, 1, 1] },
        "vignette":  { "enabled": false, "intensity": 0.5, "inner": 0.3, "outer": 0.75, "curvature": 1 },
        "fringing":  { "enabled": false, "intensity": 0.5 }
    },
    "animTracks": [],
    "cameras": [
        {
            "initial": {
                "position": [0, 1, -1],
                "target": [0, 0, 0],
                "fov": 60
            }
        }
    ],
    "annotations": [],
    "startMode": "default"
}
```
