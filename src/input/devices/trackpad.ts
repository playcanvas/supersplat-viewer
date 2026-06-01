import type { InputDevice } from '../shared';

/**
 * Trackpad reader (layer 1): pure, mode-agnostic. Owns its own wheel/modifier
 * listeners, classifies the gesture (synthetic-Ctrl pinch / physical-Ctrl rotate
 * / Shift pan), and on a match claims the event (preventDefault +
 * stopImmediatePropagation) and accumulates the raw deltas. Exposes the gesture
 * + a `claimed` flag; fires no intents and reads no camera state — the
 * coordinator turns `claimed` into `interrupt`, and the schemes act on the
 * gesture.
 */
class TrackpadDevice implements InputDevice {
    /** This-frame ctrl-rotate gesture [dx, dy]. */
    orbit: [number, number] = [0, 0];

    /** This-frame shift-pan gesture [dx, dy]. */
    pan: [number, number] = [0, 0];

    /** This-frame synthetic-Ctrl pinch-zoom gesture. */
    zoom = 0;

    /** True if a trackpad gesture was claimed this frame. */
    claimed = false;

    private _orbit: [number, number] = [0, 0];

    private _pan: [number, number] = [0, 0];

    private _zoom: number = 0;

    private _claimed = false;

    // Tracks physical Ctrl key state so we can distinguish macOS-synthesized
    // pinch events (wheel + ctrlKey, no physical Ctrl) from a user holding
    // Ctrl while spinning a mouse wheel. The synthetic-Ctrl signal is the
    // one reliable trackpad indicator the platform gives us — every other
    // per-event heuristic has been tried (wheelDelta % 120, deltaMode,
    // fractional/diagonal deltas) and misfires on hi-res mice or in
    // momentum tails. Modifier-key state we can trust 100%.
    private _ctrlDown = false;

    private _canvas: HTMLCanvasElement | null = null;

    private _onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Control') {
            this._ctrlDown = true;
        }
    };

    private _onKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Control') {
            this._ctrlDown = false;
        }
    };

    // Window blur (alt-tab, focus another app) drops keyup events, so
    // clear Ctrl state defensively to avoid getting stuck.
    private _onBlur = () => {
        this._ctrlDown = false;
    };

    private _onWheel = (event: WheelEvent) => {
        // Synthetic Ctrl (macOS pinch-to-zoom, Magic Mouse pinch): ctrlKey
        // is true on the event but the user isn't physically holding Ctrl.
        // Routes to trackpad-tuned zoom.
        const isPinch = event.ctrlKey && !this._ctrlDown;
        // Physical Ctrl + wheel/swipe: rotate. Corner case: user physically
        // holds Ctrl AND pinches — both flags true, lands here as rotate.
        // Intentional: physical Ctrl is the explicit signal.
        const isCtrlRotate = event.ctrlKey && this._ctrlDown;
        // Shift + wheel/swipe: pan. The schemes translate the screen-space pan
        // appropriately per mode (orbit pans the target; fly/walk strafe).
        const isShiftPan = event.shiftKey;

        if (!isPinch && !isCtrlRotate && !isShiftPan) {
            // Bare wheel (mouse or trackpad swipe) falls through to the
            // keyboard-mouse reader for standard forward/back motion.
            return;
        }

        event.preventDefault();
        // stopImmediatePropagation() blocks the keyboard-mouse reader's wheel
        // handler (also on this canvas) so the delta doesn't double-up, and the
        // canvas-level interrupt listener — the coordinator re-fires interrupt
        // from the `claimed` flag instead.
        event.stopImmediatePropagation();
        this._claimed = true;

        const { deltaX, deltaY } = event;

        if (isPinch) {
            this._zoom += deltaY;
        } else if (isCtrlRotate) {
            this._orbit[0] += deltaX;
            this._orbit[1] += deltaY;
        } else {
            this._pan[0] += deltaX;
            this._pan[1] += deltaY;
        }
    };

    /**
     * Trackpad must attach BEFORE the keyboard-mouse reader so its
     * `stopImmediatePropagation()` blocks that reader's wheel handler for
     * trackpad bursts. The coordinator enforces this by attaching trackpad
     * first. Keyboard listeners attach on `window` so Ctrl state is tracked
     * even when focus is on a UI overlay.
     *
     * @param canvas - The canvas element to listen to.
     */
    attach(canvas: HTMLCanvasElement): void {
        this._canvas = canvas;
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('blur', this._onBlur);
    }

    detach(): void {
        if (this._canvas) {
            this._canvas.removeEventListener('wheel', this._onWheel);
            this._canvas = null;
        }
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('blur', this._onBlur);
        this._ctrlDown = false;
        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
        this._claimed = false;
    }

    update(): void {
        // snapshot the accumulated gesture for the schemes, then clear
        this.orbit[0] = this._orbit[0];
        this.orbit[1] = this._orbit[1];
        this.pan[0] = this._pan[0];
        this.pan[1] = this._pan[1];
        this.zoom = this._zoom;
        this.claimed = this._claimed;

        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
        this._claimed = false;
    }
}

export { TrackpadDevice };
