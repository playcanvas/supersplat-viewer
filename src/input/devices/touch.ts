import type { DomEventSource } from '../dom-event-source';
import { InputFrame } from '../input-frame';
import { movementState } from '../movement-state';
import { TAP_EPSILON } from '../shared';
import type { InputDevice } from '../shared';

type MultiTouchDeltas = {
    touch: number[];
    count: number[];
    pinch: number[];
};

/**
 * Touch reader (layer 1): pure, mode-agnostic. The central `DomEventSource`
 * owns the real DOM listeners; `register(source)` subscribes the public `on*`
 * handlers to the source's typed events. The handlers accumulate raw deltas
 * into a private buffer; `update()` tracks the running touch count and runs
 * mode-agnostic tap detection, exposing `tapped`/`dragExceeded` as facts (the
 * schemes decide what a tap means).
 *
 * The virtual-joystick value is pushed in by the coordinator (`setJoystick`).
 */
class TouchDevice implements InputDevice {
    /** This-frame touch delta [dx, dy] (single-finger move or two-finger pan). */
    touch: [number, number] = [0, 0];

    /** This-frame pinch distance delta. */
    pinch = 0;

    /** UI joystick value [x, y], -1..1 (set by the coordinator). */
    joystick: [number, number] = [0, 0];

    /** A clean single tap completed this frame (delta < epsilon, max 1 touch). */
    tapped = false;

    /** A touch gesture's movement crossed the tap threshold this frame. */
    dragExceeded = false;

    /** Raw-delta buffer (composition, not inheritance). */
    private _raw = new InputFrame<MultiTouchDeltas>({
        touch: [0, 0],
        count: [0],
        pinch: [0]
    });

    private _element: HTMLElement | null = null;

    private _movement = movementState();

    private _pointerEvents = new Map<number, PointerEvent>();

    private _posX = 0;

    private _posY = 0;

    private _pinchDist = -1;

    /** Touches currently active (running count from .read() deltas). */
    private _touchCount = 0;

    /** Tap-detection state — touch count, max touches, and accumulated movement. */
    private _tapTouches = 0;

    private _tapMaxTouches = 0;

    private _tapDelta = 0;

    get touchCount(): number {
        return this._touchCount;
    }

    // Coordinator forwards the virtual-joystick value here.
    setJoystick(x: number, y: number) {
        this.joystick[0] = x;
        this.joystick[1] = y;
    }

    onPointerDown = (event: PointerEvent): void => {
        this._movement.down(event);

        if (event.pointerType !== 'touch') {
            return;
        }
        this._element?.setPointerCapture(event.pointerId);

        this._pointerEvents.set(event.pointerId, event);

        this._raw.deltas.count.append([1]);
        if (this._pointerEvents.size > 1) {
            const [mx, my] = this._midPoint();
            this._posX = mx;
            this._posY = my;
            this._pinchDist = this._pinch();
        }
    };

    onPointerMove = (event: PointerEvent): void => {
        const [movementX, movementY] = this._movement.move(event);

        if (event.pointerType !== 'touch') {
            return;
        }
        if (event.target !== this._element) {
            return;
        }
        if (this._pointerEvents.size === 0) {
            return;
        }
        this._pointerEvents.set(event.pointerId, event);

        if (this._pointerEvents.size > 1) {
            // pan: midpoint delta
            const [mx, my] = this._midPoint();
            this._raw.deltas.touch.append([mx - this._posX, my - this._posY]);
            this._posX = mx;
            this._posY = my;

            // pinch: distance delta
            const pinchDist = this._pinch();
            if (this._pinchDist > 0) {
                this._raw.deltas.pinch.append([this._pinchDist - pinchDist]);
            }
            this._pinchDist = pinchDist;
        } else {
            this._raw.deltas.touch.append([movementX, movementY]);
        }
    };

    onPointerUp = (event: PointerEvent): void => {
        this._movement.up(event);

        if (event.pointerType !== 'touch') {
            return;
        }
        this._element?.releasePointerCapture(event.pointerId);

        this._pointerEvents.delete(event.pointerId);

        this._raw.deltas.count.append([-1]);
        if (this._pointerEvents.size < 2) {
            this._pinchDist = -1;
        }

        this._posX = 0;
        this._posY = 0;
    };

    onContextMenu = (event: MouseEvent): void => {
        event.preventDefault();
    };

    private _midPoint(): [number, number] {
        if (this._pointerEvents.size < 2) {
            return [0, 0];
        }
        const [a, b] = this._pointerEvents.values();
        const dx = a.clientX - b.clientX;
        const dy = a.clientY - b.clientY;
        return [b.clientX + dx * 0.5, b.clientY + dy * 0.5];
    }

    private _pinch(): number {
        if (this._pointerEvents.size < 2) {
            return 0;
        }
        const [a, b] = this._pointerEvents.values();
        const dx = a.clientX - b.clientX;
        const dy = a.clientY - b.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    register(source: DomEventSource): void {
        this._element = source.canvas;
        source.pointerdown.on(this.onPointerDown);
        source.pointermove.on(this.onPointerMove);
        source.pointerup.on(this.onPointerUp);
        source.pointercancel.on(this.onPointerUp);
        source.contextmenu.on(this.onContextMenu);
    }

    update(): void {
        const { touch, pinch, count } = this._raw.read();

        this._touchCount += count[0];

        this.touch[0] = touch[0];
        this.touch[1] = touch[1];
        this.pinch = pinch[0];
        this.tapped = false;
        this.dragExceeded = false;

        // mode-agnostic tap detection — exposes facts, fires nothing
        const prevTaps = this._tapTouches;
        this._tapTouches = Math.max(0, this._tapTouches + count[0]);

        if (prevTaps === 0 && this._tapTouches > 0) {
            this._tapDelta = 0;
        }
        if (this._tapTouches > 0) {
            this._tapMaxTouches = Math.max(this._tapMaxTouches, this._tapTouches);
        }

        if (this._tapTouches > 0) {
            const prevDelta = this._tapDelta;
            this._tapDelta += Math.abs(touch[0]) + Math.abs(touch[1]) + Math.abs(pinch[0]);
            if (prevDelta < TAP_EPSILON && this._tapDelta >= TAP_EPSILON) {
                this.dragExceeded = true;
            }
        }

        if (prevTaps > 0 && this._tapTouches === 0) {
            if (this._tapDelta < TAP_EPSILON && this._tapMaxTouches === 1) {
                this.tapped = true;
            }
            this._tapMaxTouches = 0;
        }
    }
}

export { TouchDevice };
