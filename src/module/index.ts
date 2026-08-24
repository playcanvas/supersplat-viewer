import cssSource from '../../public/index.css';
import htmlSource from '../../public/index.html';
import jsSource from '../../public/index.js';

/**
 * The viewer's html document.
 *
 * @deprecated Use {@link renderViewerHtml} instead. Pattern-matching this string is
 * unsupported — its formatting is not part of this package's api and changes between
 * releases.
 */
const html: string = htmlSource;

/**
 * The viewer's stylesheet.
 *
 * @deprecated Use {@link renderViewerHtml} instead, which can inline it for you.
 */
const css: string = cssSource;

/** The viewer's module bundle, for serving alongside a rendered document. */
const js: string = jsSource;

export type { RenderViewerHtmlOptions, ViewerBootstrap } from './render-html';
export { renderViewerHtml } from './render-html';

export { html, css, js };
