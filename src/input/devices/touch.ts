import type { Global } from '../../types';
import { TAP_EPSILON } from '../shared';
import type { InputDevice, UpdateContext } from '../shared';
import { MultiTouchSource } from '../sources/multi-touch';

/**
 * Touch reader. Reads the raw multi-touch source, maintains the running touch
 * count + tap-detection state, fires the (mode-aware) tap intents, and exposes
 * normalized signals + tuning constants for the control schemes to map.
 */
class TouchDevice implements InputDevice {
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

    private _source = new MultiTouchSource();

    private _global: Global | null = null;

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

    get touchCount(): number {
        return this._touchCount;
    }

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._source.attach(canvas);
        global.events.on('joystickInput', this._onJoystickInput);
    }

    detach(): void {
        this._source.detach();
        if (this._global) {
            this._global.events.off('joystickInput', this._onJoystickInput);
            this._global = null;
        }
    }

    update(ctx: UpdateContext): void {
        const { touch, pinch, count } = this._source.read();
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
