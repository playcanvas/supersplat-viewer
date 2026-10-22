// The public option types.
//
// Keep this file free of imports. `module/render-html.ts` takes `ViewerAssets` from here, so
// anything this file references ends up in `dist/index.d.ts` — the node-side export, whose
// consumers use `renderViewerHtml` alone and are not required to install the engine, since it
// is an optional peer dependency. An engine import here would break type-checking for them,
// and nothing in this repo would notice. The public types that do reference the engine
// (`ViewerHandle`, `ViewerState`, `CaptureOptions`) therefore live in `types.ts` instead, and
// reach consumers through `dist/viewer.d.ts`, which imports the engine already.

/**
 * Asset urls an embedder supplies. Shared by the two ways of instantiating the viewer — as
 * fields of {@link CreateViewerOptions} in a page, and serialised into a generated document by
 * `renderViewerHtml` — so the two surfaces cannot drift.
 */
type ViewerAssets = {
    /** Splat url. May be a `data:` uri, for a document with no sibling files. */
    contentUrl: string;
    /**
     * Filename describing {@link ViewerAssets.contentUrl}, e.g. `scene.sog`. The splat format
     * is chosen by the name's extension, so this is required when the url itself has no usable
     * name — a `data:` uri.
     */
    contentFilename?: string;
    /** Poster image shown, blurred, while the splat loads. */
    posterUrl?: string;
    /** Equirectangular skybox texture url. */
    skyboxUrl?: string;
    /** Collision data url, for walk mode. A `.glb` is treated as a mesh, otherwise voxels. */
    collisionUrl?: string;
    /**
     * The gsaf decoder's wasm, fetched only when the content is a `.gsaf` file. Defaults to the
     * `gsaf-decoder.wasm` shipped beside the viewer's bundle. A document with no sibling files
     * (an inlined bundle) sets it to the `data:` url the `@playcanvas/supersplat-viewer/gsaf-decoder`
     * export provides.
     */
    gsafDecoderUrl?: string;
};

/** Per-instance switches. Every one is optional and off unless stated. */
type ViewerFlags = {
    /**
     * Requested renderer; the engine falls back to WebGL when WebGPU is unavailable. Default
     * `webgpu`.
     */
    renderer?: 'webgl' | 'webgpu';
    /**
     * Build the viewer's ui: the controls, panels, poster, loading bar, annotation hotspots
     * and their navigator. Defaults to `true`. `false` is the headless level: the canvas and
     * the api, with no overlay markup. Core camera input, browser integration and preference
     * persistence remain active. The host renders controls against the public handle;
     * `setMoveInput` supports a replacement joystick. Note that the touch joystick and the AR/VR
     * fallback prompt live in that ui, so a headless host owns those affordances too.
     */
    ui?: boolean;
    /**
     * Css pixels by which the toolbar, and everything else anchored to the viewer's bottom edge,
     * is lifted, so chrome a host app draws over the bottom of the viewer does not cover it. On
     * touch devices (a coarse primary pointer) only; elsewhere the toolbar stays at the edge.
     * Clamped to 0–200. Defaults to `0`. Experimental: it may be renamed or removed in a minor
     * release.
     */
    experimentalTouchInsetBottom?: number;
    /** Show the centre reticle in desktop fly/walk mode with gaming controls. Defaults to `false`. */
    reticle?: boolean;
    /** Start with the camera animation paused. */
    noanim?: boolean;
    /** Disable post effects. */
    nofx?: boolean;
    /** Override the settings' `highPrecisionRendering`. */
    hpr?: boolean;
    /** Show the engine's MiniStats panel. */
    ministats?: boolean;
    /** Render with LOD colorisation. */
    colorize?: boolean;
    /** Load all streaming LOD data before the first frame. */
    fullload?: boolean;
    /**
     * Offer VR at once: where VR can start, a prompt shows over the viewer while it loads, and a
     * tap on it starts a VR session as soon as the scene is placed, the rest of the scene streaming
     * in during the session; a tap elsewhere dismisses it. A session needs a tap: browsers start
     * none without one. The camera animation starts paused, as with `noanim`. Needs the ui.
     * Defaults to `false`.
     */
    vr?: boolean;
    /** Render with antialiasing. */
    aa?: boolean;
    /**
     * Developer override of the Performance Mode setting: `true` forces the stochastic splat
     * renderer (unsorted, depth-tested splats whose depth buffer also serves picking) in its
     * per-pixel mode, `'mobile'` in its interleaved-pixel-sets mode, and `'off'` keeps the
     * engine's sorted renderer; each hides the setting. Without it the user's Performance Mode
     * toggle decides, and the device class picks the mode. WebGPU only; ignored on WebGL. The
     * renderer draws WebGPU XR sessions too, one view per eye (Safari on Apple Vision Pro); where
     * only WebGL could host a session, the viewer offers a reload into WebGL.
     */
    stochastic?: boolean | 'mobile' | 'off';
    /**
     * Developer knob for the stochastic renderer: the data path that feeds it. Default
     * `direct`, the resident files read in place; `workbuffer` reads the engine's work buffer.
     */
    splatSource?: 'workbuffer' | 'direct';
    /**
     * Developer knob for the stochastic renderer: comma-separated `key:value` experiment
     * switches applied over the chosen mode's, e.g. `coverage:interleaved,jitter:2`.
     */
    variant?: string;
    /** Splat budget in millions, overriding the Quality slider's ladder (every position then gives it). */
    budget?: number;
    /**
     * Developer knob: while the viewer renders on demand, the most rendered frames the gpu may
     * have unfinished before the next continuous render (the camera moving, the stochastic
     * renderer accumulating) waits for one to finish; `0` lets them queue. Defaults to `2`.
     */
    framesInFlight?: number;
    /** Render the collision heatmap debug overlay (WebGPU only). */
    heatmap?: boolean;
    /** Open the developer debug panel on load; Ctrl+Shift+D toggles it either way. */
    debug?: boolean;
    /** Ui language. Default: detected from the browser. */
    lang?: string;
    /**
     * Publish `window.app`, `scrubTo`, `captureFrame`, `animationDuration` and the debug panel's
     * camera-state hooks. The standalone document turns this on for the thumbnail pipeline; an
     * embedded instance leaves it off, since two viewers would overwrite each other's.
     */
    exposeGlobals?: boolean;
};

/** Options for `createViewer`. */
type CreateViewerOptions = ViewerAssets &
    ViewerFlags & {
        /** The element the viewer builds its subtree in. The host sizes it; the viewer fills it. */
        container: HTMLElement;
        /**
         * Experience settings: an object in any version the viewer reads, a promise of that
         * object, or a url to fetch them from, resolved against the document. The poster is
         * shown while settings are pending.
         */
        settings: object | Promise<object> | string;
        /**
         * An already-created poster image, instead of {@link ViewerAssets.posterUrl}. Lets a
         * page start loading it before this bundle arrives.
         */
        poster?: HTMLImageElement;
        /** A fetch of {@link ViewerAssets.contentUrl} already in flight, for the same reason. */
        contents?: Promise<Response>;
    };

export type { CreateViewerOptions, ViewerAssets, ViewerFlags };
