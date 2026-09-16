// Internal types, plus the public types that reference the engine: `ViewerState`,
// `CaptureOptions` and `ViewerHandle`. The public types that do not reference it live in
// `options.ts`, which stays import-free for the reason given there — moving these in beside
// them would put an engine import into the node-side declarations.

import type { Entity, EventHandler, AppBase } from 'playcanvas';

import type { CaptureResult } from './capture';
import type { Localize } from './localization';
import type { ViewerAssets, ViewerFlags } from './options';
import type { ExperienceSettings } from './settings';

type CameraMode = 'orbit' | 'anim' | 'fly' | 'walk';

type InputMode = 'desktop' | 'touch';

// the createViewer options with every default applied: what the viewer reads at runtime, and
// immutable once it starts. The flags are documented on ViewerFlags
type Config = ViewerAssets &
    Required<Omit<ViewerFlags, 'hpr' | 'budget' | 'lang'>> &
    Pick<ViewerFlags, 'hpr' | 'budget' | 'lang'> & {
        poster?: HTMLImageElement;
        contents: Promise<Response>;
    };

// observable state that can change at runtime
type State = {
    /** True once the first complete frame has rendered. */
    loaded: boolean;
    /** Halves the render resolution. Persisted in local storage; defaults on for mobile. */
    performanceMode: boolean;
    /** Content loading progress, 0 to 100. */
    progress: number;
    /** What the user last interacted with, which decides the ui's affordances. */
    inputMode: InputMode;
    /** The active camera controller. `anim` is the authored camera animation. */
    cameraMode: CameraMode;
    /** Whether the experience has an authored camera animation. */
    hasAnimation: boolean;
    /** Length of that animation in seconds, or 0. */
    animationDuration: number;
    /** Playhead position in seconds. Read-only: the animation cursor owns it. */
    animationTime: number;
    /** Whether the animation is paused. */
    animationPaused: boolean;
    /** Whether an AR session can start, or could after reloading into WebGL. */
    hasAR: boolean;
    /** Whether a VR session can start, or could after reloading into WebGL. */
    hasVR: boolean;
    /** Whether the experience ships collision data, which walk mode needs. */
    hasCollision: boolean;
    /** Whether that collision data can be drawn as a debug overlay. */
    hasCollisionOverlay: boolean;
    /** Whether walk mode is offered: collision data, and a scene big enough to walk in. */
    walkAllowed: boolean;
    /** Draws the collision debug overlay. */
    collisionOverlayEnabled: boolean;
    /** Whether this instance is the fullscreen element. Read-only: the viewer observes it. */
    isFullscreen: boolean;
    /** Fades the controls out. The viewer also sets this on an idle timer. */
    controlsHidden: boolean;
    /** Shows the annotation hotspots. Persisted in local storage. */
    showAnnotations: boolean;
    /** Mouse-look and joystick movement rather than click-to-navigate. Persisted. */
    gamingControls: boolean;
    /**
     * Gates the inputs the dom cannot route by hit-testing, because their listeners sit on
     * `window`: the keyboard (both the engine's source and the viewer's own shortcuts) and the
     * gamepad. Pointer input on the canvas is unaffected. Clear it while your own controls have
     * focus or a modal is open, and to choose which of several viewers the keyboard drives.
     */
    inputEnabled: boolean;
};

// The keys a host may set; every other key reports what the viewer found or is doing.
// `animationTime` is not among them: the camera manager writes it from the animation cursor
// every update, so a host's value would be ignored and then overwritten. Seeking goes through
// the cursor, and exposing it is a separate addition.
type WritableStateKey =
    | 'cameraMode'
    | 'performanceMode'
    | 'showAnnotations'
    | 'gamingControls'
    | 'animationPaused'
    | 'collisionOverlayEnabled'
    | 'controlsHidden'
    | 'inputEnabled';

/**
 * The viewer's state as a host sees it: one observable object, with the keys the viewer owns
 * marked read-only. Writing a read-only key is ignored, and the viewer overwrites it.
 */
type ViewerState = Pick<State, WritableStateKey> & Readonly<Omit<State, WritableStateKey>>;

/** Options for {@link ViewerHandle.captureFrame}. */
type CaptureOptions = {
    /** Animation time to capture at, in seconds. The animation is paused there. */
    time?: number;
    /** Output width in pixels. Defaults to 480. */
    width?: number;
    /** Output height in pixels. Defaults to the width. */
    height?: number;
    /** Supersampling factor, capped at 8. Defaults to 2. */
    supersample?: number;
};

/** What `createViewer` resolves to: one viewer instance. */
type ViewerHandle = {
    /** The engine application, for a host that needs to reach past this api. */
    readonly app: AppBase;
    /** Observable state. Writes to its writable keys take effect at once. */
    readonly state: ViewerState;
    /** Fires `<key>:changed` with `(value, previous)` for every key of {@link ViewerState}. */
    readonly events: EventHandler;
    /**
     * Render the scene, with post effects, into an offscreen supersampled target and return it
     * downsampled to the requested size, as base64. Waits for the first frame, and rejects if
     * the viewer is destroyed before the capture completes. Concurrent calls are serialised,
     * since they share the one camera.
     */
    captureFrame(options?: CaptureOptions): Promise<CaptureResult>;
    /** Frame the whole scene, switching to orbit mode. */
    frameScene(): void;
    /**
     * Release everything: the engine application, the graphics context, every listener, and the
     * subtree built inside the container. Idempotent, and safe before loading finishes.
     */
    destroy(): void;
};

type Global = {
    app: AppBase;
    settings: ExperienceSettings;
    config: Config;
    state: State;
    events: EventHandler;
    camera: Entity;
    renderer: 'webgl' | 'webgpu'; // actual renderer in use (reflects engine fallback from WebGPU to WebGL2)
    // the element containing the canvas and the ui subtree; every dom lookup, attribute and
    // listener the viewer owns is scoped to it rather than to the document, so two instances
    // can share a page (the standalone document's root is <body>)
    root: HTMLElement;
    // ui string lookup in this instance's locale
    localize: Localize;
};

export { CameraMode, InputMode, Config, State, Global, ViewerState, CaptureOptions, ViewerHandle };
