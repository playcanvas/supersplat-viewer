/**
 * Defaults the embedder supplies to the viewer. URL params on the served page take
 * precedence over every field here.
 */
export type ViewerBootstrap = {
    /** Experience settings as an object. When omitted the viewer fetches `settingsUrl`. */
    settings?: unknown;
    settingsUrl?: string;
    /** Splat url. May be a `data:` uri for a self-contained document. */
    contentUrl?: string;
    posterUrl?: string;
    skyboxUrl?: string;
    collisionUrl?: string;
};

export type RenderViewerHtmlOptions = {
    bootstrap?: ViewerBootstrap;
    /** Value for the document's `<base href>`, for a viewer served from a sub-path. */
    baseHref?: string;
    /** Page background, applied before the first frame renders to avoid a flash. */
    backgroundColor?: [number, number, number];
    /** Raw markup injected before `</head>` — analytics, error reporting. */
    headExtras?: string;
    /** Inline the stylesheet into a `<style>` block instead of linking `./index.css`. */
    inlineCss?: boolean;
    /**
     * Inline the module bundle instead of importing `./index.js`. Independent of
     * `inlineCss`, so a server serving the bundle from its own route can inline only the css.
     */
    inlineJs?: boolean;
};

/**
 * Render a standalone viewer document.
 *
 * This is the supported way to embed the viewer in a page you generate. Called with no
 * options it returns the document this package ships, unmodified.
 *
 * @param options - Embedding options.
 * @returns The rendered html document.
 */
export function renderViewerHtml(options?: RenderViewerHtmlOptions): string;

/**
 * The viewer's html document.
 *
 * @deprecated Use {@link renderViewerHtml} instead. Pattern-matching this string is
 * unsupported — its formatting changes between releases.
 */
export const html: string;

/**
 * The viewer's stylesheet.
 *
 * @deprecated Use {@link renderViewerHtml} instead.
 */
export const css: string;

/** The viewer's module bundle, for serving alongside a rendered document. */
export const js: string;
