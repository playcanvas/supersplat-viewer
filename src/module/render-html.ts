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
    /**
     * Filename describing {@link ViewerBootstrap.contentUrl}, e.g. `scene.sog`. The splat
     * format is chosen by the name's extension, so this is required when the url itself has
     * no usable name — a `data:` uri. Ignored when a `?content=` url param overrides the url
     * it describes.
     */
    contentFilename?: string;
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
    backgroundColor?: readonly [number, number, number];
    /** Raw markup injected before `</head>`, for analytics or error reporting. */
    headExtras?: string;
    /**
     * Raw markup injected immediately after `<body>`, for content that must precede the
     * canvas — a marker element a screenshot pipeline waits on, for example.
     */
    bodyStartExtras?: string;
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

// Serialize for embedding in a `<script type="application/json">` block. Every `<` is
// escaped with its json unicode escape (so the payload round-trips byte-exact), which
// neutralises all of the parser's script-content hazards at once: `</script` ending
// the block early, and `<!--` followed by `<script` switching the tokenizer into the
// double-escaped state, where the block's own close tag is consumed as text and the rest of
// the document is swallowed. U+2028/U+2029 are escaped because they are legal in json
// strings but terminate a line in some js parsers.
const jsonForScriptBlock = (value: unknown) => {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
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
const BODY_OPEN = /<body\b[^>]*>/;

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
    const { bootstrap, baseHref, backgroundColor, headExtras, bodyStartExtras, inlineCss, inlineJs } = options;

    let result = html;

    // Order matters. Each seam is matched with a non-global regex, so the *first* occurrence
    // in the document wins — and caller-controlled content (the bootstrap json, `headExtras`)
    // can contain text that looks like a seam. Settings carry user-authored annotation text,
    // so treat that as hostile. Every seam is therefore replaced before any caller content is
    // inserted, and the two insertions go last, in document order.

    if (baseHref !== undefined) {
        result = replaceOnce(result, BASE_HREF, () => `<base href="${escapeAttribute(baseHref)}">`);
    }

    if (inlineCss) {
        // A `<style>` element is rawtext: it ends at the first `</style` regardless of css
        // syntax, so a stylesheet containing that sequence cannot be inlined. The built css
        // contains no `<` at all today; fail loudly if that ever changes.
        if (/<\/style/i.test(css)) {
            throw new Error('renderViewerHtml: the viewer stylesheet contains "</style" and cannot be inlined');
        }
        result = replaceOnce(result, STYLESHEET, () => `<style>\n${indent(css, 12)}\n        </style>`);
    }

    if (inlineJs) {
        // The bundle's trailing sourceMappingURL comment points at a sibling index.js.map
        // that an inlined document does not sit next to, so devtools would 404 on it (or
        // bind whatever stranger's map the host serves at that path).
        const inlineJsSource = js.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');

        // An inline module script ends at the first `</script`, and `<!--` followed by
        // `<script` switches the tokenizer into a state where that close tag is consumed as
        // text instead — either way the symptom is an exported file that renders nothing.
        // The bundle contains none of these today; fail loudly if that ever changes.
        // Case-insensitive, because the html parser is.
        if (/<\/script|<!--|<script/i.test(inlineJsSource)) {
            throw new Error(
                'renderViewerHtml: the viewer bundle contains markup the html parser acts on and cannot be inlined'
            );
        }
        result = replaceOnce(result, MODULE_IMPORT, () => inlineJsSource);
    }

    if (bodyStartExtras !== undefined) {
        result = replaceOnce(result, BODY_OPEN, (bodyTag) => `${bodyTag}\n        ${bodyStartExtras}`);
    }

    const headAppend: string[] = [];
    if (headExtras !== undefined) {
        headAppend.push(headExtras);
    }
    if (backgroundColor) {
        const rgb = backgroundColor.map((c) => Math.round(c * 255)).join(', ');
        headAppend.push(`<style>body { background-color: rgb(${rgb}); }</style>`);
    }

    // Emitted at the end of head, so the background rule wins over the stylesheet on equal
    // specificity. Only the first line gains indentation: `headExtras` is raw markup, and
    // reindenting its interior lines would rewrite whitespace-sensitive content (a template
    // literal in an inline script, for instance).
    if (headAppend.length > 0) {
        result = replaceOnce(result, HEAD_CLOSE, (_match, ws) => `${ws}    ${headAppend.join('\n')}\n${ws}</head>`);
    }

    // Last: the bootstrap block sits earlier in the document than `</head>`, so its own seam
    // still matches ahead of anything `headExtras` added.
    if (bootstrap) {
        const json = jsonForScriptBlock(bootstrap);
        result = replaceOnce(
            result,
            BOOTSTRAP,
            () => `<script type="application/json" id="sse-bootstrap">${json}</script>`
        );
    }

    return result;
};

export type { RenderViewerHtmlOptions, ViewerBootstrap };
export { renderViewerHtml };
