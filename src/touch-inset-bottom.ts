// The touch-only bottom inset, normalised from what an embedder passes. Free of imports, so the
// unit tests can load the source on its own, without a build or a dom.

// the most a host's chrome can plausibly cover; beyond it the toolbar would leave a short
// viewer altogether
const TOUCH_INSET_BOTTOM_MAX = 200;

// css pixels, clamped to 0..TOUCH_INSET_BOTTOM_MAX; a value that is not a finite number is 0
const resolveTouchInsetBottom = (insetBottom: number | undefined) => {
    const value = Number(insetBottom);
    return Number.isFinite(value) ? Math.min(TOUCH_INSET_BOTTOM_MAX, Math.max(0, value)) : 0;
};

export { TOUCH_INSET_BOTTOM_MAX, resolveTouchInsetBottom };
