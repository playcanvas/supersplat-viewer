import type { Global } from '../../types';
import { InputFrame } from '../input-frame';
import { movementState } from '../movement-state';
import { TAP_EPSILON } from '../shared';
import type { InputDevice, UpdateContext } from '../shared';

type MultiTouchDeltas = {
    touch: number[];
    count: number[];
    pinch: number[];
};

/**
 * Touch reader: a self-contained input device that binds its own multi-touch
 * listeners and accumulates raw deltas (engine-free port of the PlayCanvas
 * `MultiTouchSource`), maintains the running touch count + tap-detection state,
 * fires the (mode-aware) tap intents, and exposes normalized signals + tuning
 * constants for the control schemes to map.
 *
 * Raw `read()` output (consumed internally by `update`):
 * - `touch` [dx, dy]: two-finger pan = midpoint delta; single-finger = movement delta
 * - `count` [±1]: per-event change in active touch count
 * - `pinch` [d]: change in two-finger distance (`oldDist - newDist`, so pinch-in is positive)
 */
class TouchDevice extends InputFrame<MultiTouchDeltas> implements InputDevice {
    orbitSpeed: number = 18;

    moveSpeed: number = 4;

    pinchSpeed: number = 0.4;

    touchRotateSensitivity: number = 1.5;

    /** This-frame touch delta [dx, dy] (single-finger move or two-finger pan). */
    touch: [number, number] = [0, 0];

    /** This-frame pinch distance delta. */
    pinch = 0;

    /** UI joystick value [x, y], -1..1. */
    joystick: [number, number] = [0, 0];

    /** True for one frame after a tap is detected during gaming controls (walk jump). */
    tapJump = false;

    private _element: HTMLElement | null = null;

    private _global: Global | null = null;

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

    private _onJoystickInput = (value: { x: number; y: number }) => {
        this.joystick[0] = value.x;
        this.joystick[1] = value.y;
    };

    constructor() {
        super({
            touch: [0, 0],
            count: [0],
            pinch: [0]
        });
    }

    get touchCount(): number {
        return this._touchCount;
    }

    private _onPointerDown = (event: PointerEvent) => {
        this._movement.down(event);

        if (event.pointerType !== 'touch') {
            return;
        }
        this._element?.setPointerCapture(event.pointerId);

        this._pointerEvents.set(event.pointerId, event);

        this.deltas.count.append([1]);
        if (this._pointerEvents.size > 1) {
            const [mx, my] = this._midPoint();
            this._posX = mx;
            this._posY = my;
            this._pinchDist = this._pinch();
        }
    };

    private _onPointerMove = (event: PointerEvent) => {
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
            this.deltas.touch.append([mx - this._posX, my - this._posY]);
            this._posX = mx;
            this._posY = my;

            // pinch: distance delta
            const pinchDist = this._pinch();
            if (this._pinchDist > 0) {
                this.deltas.pinch.append([this._pinchDist - pinchDist]);
            }
            this._pinchDist = pinchDist;
        } else {
            this.deltas.touch.append([movementX, movementY]);
        }
    };

    private _onPointerUp = (event: PointerEvent) => {
        this._movement.up(event);

        if (event.pointerType !== 'touch') {
            return;
        }
        this._element?.releasePointerCapture(event.pointerId);

        this._pointerEvents.delete(event.pointerId);

        this.deltas.count.append([-1]);
        if (this._pointerEvents.size < 2) {
            this._pinchDist = -1;
        }

        this._posX = 0;
        this._posY = 0;
    };

    private _onContextMenu = (event: MouseEvent) => {
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

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._element = canvas;
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerUp);
        canvas.addEventListener('contextmenu', this._onContextMenu);
        global.events.on('joystickInput', this._onJoystickInput);
    }

    detach(): void {
        if (this._element) {
            this._element.removeEventListener('pointerdown', this._onPointerDown);
            this._element.removeEventListener('pointermove', this._onPointerMove);
            this._element.removeEventListener('pointerup', this._onPointerUp);
            this._element.removeEventListener('pointercancel', this._onPointerUp);
            this._element.removeEventListener('contextmenu', this._onContextMenu);
            this._element = null;
        }
        this._pointerEvents.clear();
        this.read();
        if (this._global) {
            this._global.events.off('joystickInput', this._onJoystickInput);
            this._global = null;
        }
    }

    update(ctx: UpdateContext): void {
        const { touch, pinch, count } = this.read();
        const { isFly, isWalk, isOrbit, gamingControls } = ctx;

        // running touch count
        this._touchCount += count[0];

        // expose this-frame deltas
        this.touch[0] = touch[0];
        this.touch[1] = touch[1];
        this.pinch = pinch[0];
        this.tapJump = false;

        if (isFly && gamingControls && (this.joystick[0] !== 0 || this.joystick[1] !== 0)) {
            this._global!.events.fire('navigateCancel');
        }

        // tap detection for click/tap target and focus modes
        if (isWalk || isFly || isOrbit) {
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
                    if ((isWalk && !gamingControls) || isFly) {
                        this._global!.events.fire('navigateCancel');
                    }
                }
            }

            if (prevTaps > 0 && this._tapTouches === 0) {
                if (this._tapDelta < TAP_EPSILON && this._tapMaxTouches === 1) {
                    if (isWalk && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    } else if (isWalk) {
                        this.tapJump = true;
                    } else if (isFly && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    } else if (isOrbit) {
                        // Walk-interaction listens for this and sets orbit focus
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    }
                }
                this._tapMaxTouches = 0;
            }
        } else {
            this._tapTouches = 0;
            this._tapMaxTouches = 0;
        }
    }
}

export { TouchDevice };
