/**
 * Distinguishes a physical mouse wheel from a trackpad two-finger scroll.
 *
 * A single wheel event is unreliable (Magic Mouse, hi-res mice, and macOS
 * Shift-remapping all confuse per-event heuristics), so classify on the
 * first event of a burst and let the rest of the burst inherit that label.
 * A burst is a run of wheel events separated by less than BURST_GAP_MS;
 * trackpads stream at ~60Hz (~16ms), wheels emit one event per notch
 * (typically >>50ms apart).
 */
const BURST_GAP_MS = 80;

const isMouseWheelEvent = (event: WheelEvent): boolean => {
    // Firefox: physical wheels report line/page mode; trackpads report
    // pixel mode. Firefox doesn't expose wheelDelta* so this is the only
    // reliable signal there.
    if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
        return true;
    }
    // Chrome / Safari: the non-standard wheelDelta{X,Y} properties preserve
    // the raw wheel-tick value (always multiples of ±120 per notch)
    // regardless of macOS scroll smoothing. Trackpads and Magic Mouse emit
    // arbitrary values that are essentially never aligned to 120.
    const e = event as WheelEvent & { wheelDeltaX?: number, wheelDeltaY?: number };
    if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0) {
        return e.wheelDeltaY % 120 === 0;
    }
    if (typeof e.wheelDeltaX === 'number' && e.wheelDeltaX !== 0) {
        return e.wheelDeltaX % 120 === 0;
    }
    // Last-resort fallback for browsers without wheelDelta*.
    const { deltaX, deltaY } = event;
    if (deltaX !== 0 && deltaY !== 0) {
        return false;
    }
    return Number.isInteger(deltaX) && Number.isInteger(deltaY);
};

class WheelClassifier {
    private _lastTime: number = -Infinity;

    private _burstIsMouseWheel: boolean = false;

    /**
     * Classify the given event. The first event of a burst sets the label
     * for the burst; subsequent events within BURST_GAP_MS inherit it.
     *
     * @param event - The wheel event to classify.
     * @returns True if the event came from a physical mouse wheel.
     */
    classify(event: WheelEvent): boolean {
        const now = performance.now();
        if (now - this._lastTime > BURST_GAP_MS) {
            this._burstIsMouseWheel = isMouseWheelEvent(event);
        }
        this._lastTime = now;
        return this._burstIsMouseWheel;
    }
}

export { WheelClassifier };
