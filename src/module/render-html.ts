import css from '../../public/index.css';
import html from '../../public/index.html';
import js from '../../public/index.js';

/**
 * Asset urls and settings the embedder supplies to the viewer.
 *
 * Url params on the served page take precedence over every url here, so an embed stays
 * overridable per instance. Inline {@link ViewerBootstrap.settings} is the exception: it wins
 * over `?settings=`, so a published experience cannot be repointed at another settings file.
 */
type ViewerBootstrap = {
    /**
     * Experience settings as an object, avoiding a round trip. When omitted the viewer
     * fetches {@link ViewerBootstrap.settingsUrl}.
     */
    settings?: unknown;
    /** Where to fetch settings from. Defaults to `./settings.json`. */
    settingsUrl?: string;
    /** Splat url. May be a `data:` uri, for a document with no sibling files. */
    contentUrl?: string;
    /** Poster image shown, blurred, while the splat loads. */
    posterUrl?: string;
    /** Equirectangular skybox texture url. */
    skyboxUrl?: string;
    /** Collision data url, for walk mode. A `.glb` is treated as a mesh, otherwise voxels. */
    collisionUrl?: string;
};

/** Options for {@link renderViewerHtml}. */
type RenderViewerHtmlOptions = {
    /** Asset urls and settings for the viewer to boot with. */
    bootstrap?: ViewerBootstrap;
    /** Value for the document's `<base href>`, for a viewer served from a sub-path. */
    baseHref?: string;
    /**
     * Page background, applied before the first frame renders to avoid a flash. Components
     * are normalized 0..1, not 0..255, matching `background.color` in the settings format —
     * so an experience's own colour can be passed straight through.
     */
    backgroundColor?: [number, number, number];
    /** Raw markup injected before `</head>`, for analytics or error reporting. */
    headExtras?: string;
    /** Inline the stylesheet into a `<style>` block instead of linking `./index.css`. */
    inlineCss?: boolean;
    /**
     * Inline the module bundle instead of importing `./index.js`. Independent of
     * {@link RenderViewerHtmlOptions.inlineCss}: a host serving the bundle from its own route
     * wants the css inlined to avoid a round trip before first paint, but not a megabyte of
     * js in every page.
     */
    inlineJs?: boolean;
};

type Replacer = (match: string, ...groups: string[]) => string;

// The seams below are matched against this package's own `index.html`, so a miss means the
// document and this function have drifted apart within one release — a build-time invariant,
// not a bad caller. Throw rather than return a half-rendered document.
//
// Every replacement is a function, so `$&`-style sequences in settings json, urls or the
// bundle are inserted literally instead of being interpreted as replacement patterns.
// Annotation text is user-authored, so this matters.
const replaceOnce = (source: string, pattern: RegExp, replacement: Replacer) => {
    if (!pattern.test(source)) {
        throw new Error(`renderViewerHtml: no match for ${String(pattern)} in the viewer html`);
    }
    return source.replace(pattern, replacement);
};

// Serialize for embedding in a `<script type="application/json">` block. The html parser
// reads that block as raw text up to the first `</script`, so `</` must not appear; `\/` is
// a valid json escape for `/`. U+2028/U+2029 are escaped because they are legal in json
// strings but terminate a line in some js parsers.
const jsonForScriptBlock = (value: unknown) => {
    return JSON.stringify(value)
        .replace(/<\//g, '<\\/')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
};

// Escape for use inside a double-quoted html attribute. `headExtras` is documented as raw
// markup and is deliberately not escaped, but scalar options like `baseHref` are not an
// injection channel and a caller passing one through from user input should be safe.
const escapeAttribute = (value: string) => {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

const indent = (text: string, spaces: number) => {
    const whitespace = ' '.repeat(spaces);
    return text
        .split('\n')
        .map((line) => whitespace + line)
        .join('\n');
};

const BOOTSTRAP = /<script type="application\/json" id="sse-bootstrap">[\s\S]*?<\/script>/;
const BASE_HREF = /<base\b[^>]*>/;
const STYLESHEET = /<link\b[^>]*href="\.\/index\.css"[^>]*>/;
const MODULE_IMPORT = /import \{ main \} from '\.\/index\.js';/;
const HEAD_CLOSE = /^([ \t]*)<\/head>/m;

/**
 * Render a standalone viewer document.
 *
 * This is the supported way to embed the viewer in a page you generate. Called with no
 * options it returns the document this package ships, unmodified.
 *
 * @param options - Embedding options; see {@link RenderViewerHtmlOptions}.
 * @returns The rendered html document.
 */
const renderViewerHtml = (options: RenderViewerHtmlOptions = {}) => {
    const { bootstrap, baseHref, backgroundColor, headExtras, inlineCss, inlineJs } = options;

    let result = html;

    if (bootstrap) {
        const json = jsonForScriptBlock(bootstrap);
        result = replaceOnce(
            result,
            BOOTSTRAP,
            () => `<script type="application/json" id="sse-bootstrap">${json}</script>`
        );
    }

    if (baseHref !== undefined) {
        result = replaceOnce(result, BASE_HREF, () => `<base href="${escapeAttribute(baseHref)}">`);
    }

    const rgb = backgroundColor?.map((c) => Math.round(c * 255)).join(', ');
    const headAppend = [headExtras, rgb && `<style>\n    body { background-color: rgb(${rgb}); }\n</style>`].filter(
        Boolean
    ) as string[];

    // Emitted at the end of head, so the background rule wins over the stylesheet on equal
    // specificity. Done before inlining so every seam is matched against this package's own
    // document rather than against a megabyte of bundled js that might contain the same text.
    if (headAppend.length > 0) {
        result = replaceOnce(
            result,
            HEAD_CLOSE,
            (_match, ws) => `${indent(headAppend.join('\n'), ws.length + 4)}\n${ws}</head>`
        );
    }

    if (inlineCss) {
        result = replaceOnce(result, STYLESHEET, () => `<style>\n${indent(css, 12)}\n        </style>`);
    }

    if (inlineJs) {
        // An inline module script ends at the first `</script`, so a bundle containing that
        // sequence cannot be inlined. It does not today; fail loudly if that ever changes,
        // because the symptom is an exported file that renders nothing.
        if (js.includes('</script')) {
            throw new Error('renderViewerHtml: the viewer bundle contains "</script" and cannot be inlined');
        }
        result = replaceOnce(result, MODULE_IMPORT, () => js);
    }

    return result;
};

export type { RenderViewerHtmlOptions, ViewerBootstrap };
export { renderViewerHtml };
