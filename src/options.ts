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
     * the api, with no markup but the canvas and nothing listening outside it, for a host that
     * renders its own controls against `state`. Note that the touch joystick and the AR/VR
     * fallback prompt live in that ui, so a headless host owns those affordances too.
     */
    ui?: boolean;
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
    /** Render with antialiasing. */
    aa?: boolean;
    /** Splat budget in millions, overriding the platform and performance-mode table. */
    budget?: number;
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
         * Experience settings: an object in any version the viewer reads, or a url to fetch them
         * from, resolved against the document.
         */
        settings: object | string;
        /**
         * An already-created poster image, instead of {@link ViewerAssets.posterUrl}. Lets a
         * page start loading it before this bundle arrives.
         */
        poster?: HTMLImageElement;
        /** A fetch of {@link ViewerAssets.contentUrl} already in flight, for the same reason. */
        contents?: Promise<Response>;
    };

export type { CreateViewerOptions, ViewerAssets, ViewerFlags };
