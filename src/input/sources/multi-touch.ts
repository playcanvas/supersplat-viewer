import { InputSource } from './input-frame';
import { movementState } from './movement-state';

type MultiTouchDeltas = {
    touch: number[];
    count: number[];
    pinch: number[];
};

/**
 * Multi-touch input source. Engine-free port of the PlayCanvas
 * `MultiTouchSource`.
 *
 * `read()` output:
 * - `touch` [dx, dy]: two-finger pan = midpoint delta; single-finger = movement delta
 * - `count` [±1]: per-event change in active touch count
 * - `pinch` [d]: change in two-finger distance (`oldDist - newDist`, so pinch-in is positive)
 */
class MultiTouchSource extends InputSource<MultiTouchDeltas> {
    private _movement = movementState();

    private _pointerEvents = new Map<number, PointerEvent>();

    private _posX = 0;

    private _posY = 0;

    private _pinchDist = -1;

    constructor() {
        super({
            touch: [0, 0],
            count: [0],
            pinch: [0]
        });
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

    attach(element: HTMLElement): void {
        super.attach(element);

        this._element = element;
        element.addEventListener('pointerdown', this._onPointerDown);
        element.addEventListener('pointermove', this._onPointerMove);
        element.addEventListener('pointerup', this._onPointerUp);
        element.addEventListener('pointercancel', this._onPointerUp);
        element.addEventListener('contextmenu', this._onContextMenu);
    }

    detach(): void {
        if (!this._element) {
            return;
        }
        this._element.removeEventListener('pointerdown', this._onPointerDown);
        this._element.removeEventListener('pointermove', this._onPointerMove);
        this._element.removeEventListener('pointerup', this._onPointerUp);
        this._element.removeEventListener('pointercancel', this._onPointerUp);
        this._element.removeEventListener('contextmenu', this._onContextMenu);

        this._pointerEvents.clear();

        super.detach();
    }
}

export { MultiTouchSource };
