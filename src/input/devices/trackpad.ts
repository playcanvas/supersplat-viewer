import type { InputDevice } from '../shared';

/**
 * Trackpad reader (layer 1): pure, mode-agnostic. Does NOT register its own DOM
 * listeners — the central `DomEventSource` calls the public `on*` handlers. It
 * classifies the wheel gesture (synthetic-Ctrl pinch / physical-Ctrl rotate /
 * Shift pan); on a match it `preventDefault`s, accumulates the raw deltas, sets
 * `claimed`, and **returns `true` to claim the event** (the source then skips
 * the keyboard-mouse reader's wheel handler — explicit, ordered, no
 * `stopImmediatePropagation`). Fires no intents and reads no camera state.
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

    onKeyDown = (e: Event): void => {
        if ((e as KeyboardEvent).key === 'Control') {
            this._ctrlDown = true;
        }
    };

    onKeyUp = (e: Event): void => {
        if ((e as KeyboardEvent).key === 'Control') {
            this._ctrlDown = false;
        }
    };

    // Window blur (alt-tab, focus another app) drops keyup events, so
    // clear Ctrl state defensively to avoid getting stuck.
    onBlur = (): void => {
        this._ctrlDown = false;
    };

    onWheel = (e: Event): boolean | void => {
        const event = e as WheelEvent;

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
            // Bare wheel (mouse or trackpad swipe): not claimed — falls through
            // to the keyboard-mouse reader for standard forward/back motion.
            return;
        }

        event.preventDefault();
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

        // claim the event — the source skips the keyboard-mouse wheel handler
        return true;
    };

    attach(_canvas: HTMLCanvasElement): void {
        // No self-registration — the DomEventSource owns the listeners.
    }

    detach(): void {
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
