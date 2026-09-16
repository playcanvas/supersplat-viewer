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
    loaded: boolean; // true once first frame is rendered
    performanceMode: boolean;
    progress: number; // content loading progress 0-100
    inputMode: InputMode;
    cameraMode: CameraMode;
    hasAnimation: boolean;
    animationDuration: number;
    animationTime: number;
    animationPaused: boolean;
    hasAR: boolean;
    hasVR: boolean;
    hasCollision: boolean;
    hasCollisionOverlay: boolean;
    walkAllowed: boolean;
    collisionOverlayEnabled: boolean;
    isFullscreen: boolean;
    controlsHidden: boolean;
    showAnnotations: boolean;
    gamingControls: boolean;
    // host-writable. Gates the inputs the dom cannot route by hit-testing because their
    // listeners sit on window: the keyboard (the engine's source and the viewer's shortcuts)
    // and the gamepad. Pointer input on the canvas is unaffected. A host clears it while its
    // own controls have focus or a modal is open, and decides which of several viewers on a
    // page the keyboard drives
    inputEnabled: boolean;
};

// the keys a host may set; every other key reports what the viewer found or is doing
type WritableStateKey =
    | 'cameraMode'
    | 'performanceMode'
    | 'showAnnotations'
    | 'gamingControls'
    | 'animationPaused'
    | 'animationTime'
    | 'collisionOverlayEnabled'
    | 'controlsHidden'
    | 'inputEnabled';

// the state as a host sees it: the same object, with the viewer's own keys read-only
type ViewerState = Pick<State, WritableStateKey> & Readonly<Omit<State, WritableStateKey>>;

type CaptureOptions = {
    // animation time to capture at; the animation is paused there
    time?: number;
    // output size in pixels; height defaults to width
    width?: number;
    height?: number;
    // supersampling factor, default 2
    supersample?: number;
};

// what createViewer resolves to
type ViewerHandle = {
    // the engine application, for a host that needs to reach past this api
    readonly app: AppBase;
    // observable state. Writable keys take effect at once; the rest are the viewer's to report
    readonly state: ViewerState;
    // fires `<key>:changed` with (value, previous) for every key of state
    readonly events: EventHandler;
    // render the scene, with post effects, into an offscreen supersampled target and return it
    // downsampled to the requested size. Waits for the first frame
    captureFrame(options?: CaptureOptions): Promise<CaptureResult>;
    // frame the whole scene, in orbit mode
    frameScene(): void;
    // release everything, including the subtree built in the container. Idempotent
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
