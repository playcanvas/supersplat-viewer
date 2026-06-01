import { InputSource } from './input-frame';
import { movementState } from './movement-state';

const PASSIVE = { passive: false, capture: false };

const KEY_CODES = {
    A: 0,
    B: 1,
    C: 2,
    D: 3,
    E: 4,
    F: 5,
    G: 6,
    H: 7,
    I: 8,
    J: 9,
    K: 10,
    L: 11,
    M: 12,
    N: 13,
    O: 14,
    P: 15,
    Q: 16,
    R: 17,
    S: 18,
    T: 19,
    U: 20,
    V: 21,
    W: 22,
    X: 23,
    Y: 24,
    Z: 25,
    '0': 26,
    '1': 27,
    '2': 28,
    '3': 29,
    '4': 30,
    '5': 31,
    '6': 32,
    '7': 33,
    '8': 34,
    '9': 35,
    UP: 36,
    DOWN: 37,
    LEFT: 38,
    RIGHT: 39,
    SPACE: 40,
    SHIFT: 41,
    CTRL: 42
} as const;
const KEY_COUNT = Object.keys(KEY_CODES).length;

/** Shared scratch buffer for per-frame key deltas. */
const keyScratch = new Array(KEY_COUNT).fill(0);

type KeyboardMouseDeltas = {
    key: number[];
    button: number[];
    mouse: number[];
    wheel: number[];
};

/**
 * Keyboard + mouse input source. Engine-free port of the PlayCanvas
 * `KeyboardMouseSource`, with two viewer-specific additions baked in:
 *
 * - The macOS Meta-key fix (previously a runtime monkey-patch): macOS swallows
 *   `keyup` for any key released while Cmd is held, so we clear all key state
 *   on a Meta event and ignore key events that arrive with `metaKey` set.
 * - A public `pointerLock` setter (previously poked via a private field) so the
 *   pointer-lock manager can toggle how mouse deltas are sourced.
 *
 * `read()` output:
 * - `key`   length 43, per-frame delta (`keyNow - keyPrev`): +1 pressed, -1 released, 0 unchanged
 * - `button` length 3 [L,M,R], level/edge: 1 pressed, -1 released-this-frame, 0 up
 * - `mouse`  [dx, dy], accumulated screen-space delta (native movementX/Y under pointer lock)
 * - `wheel`  [dY], accumulated raw wheel deltaY
 */
class KeyboardMouseSource extends InputSource<KeyboardMouseDeltas> {
    static keyCode = KEY_CODES;

    private _movement = movementState();

    private _pointerId = -1;

    private _pointerLock: boolean;

    private _keyMap = new Map<string, number>();

    private _keyPrev = new Array(KEY_COUNT).fill(0);

    private _keyNow = new Array(KEY_COUNT).fill(0);

    private _button = [0, 0, 0];

    constructor({ pointerLock = false }: { pointerLock?: boolean } = {}) {
        super({
            key: new Array(KEY_COUNT).fill(0),
            button: [0, 0, 0],
            mouse: [0, 0],
            wheel: [0]
        });

        this._pointerLock = pointerLock;

        const { keyCode } = KeyboardMouseSource;

        for (let i = 0; i < 26; i++) {
            this._keyMap.set(`Key${String.fromCharCode('A'.charCodeAt(0) + i)}`, keyCode.A + i);
        }
        for (let i = 0; i < 10; i++) {
            this._keyMap.set(`Digit${i}`, keyCode['0'] + i);
        }
        this._keyMap.set('ArrowUp', keyCode.UP);
        this._keyMap.set('ArrowDown', keyCode.DOWN);
        this._keyMap.set('ArrowLeft', keyCode.LEFT);
        this._keyMap.set('ArrowRight', keyCode.RIGHT);
        this._keyMap.set('Space', keyCode.SPACE);
        this._keyMap.set('ShiftLeft', keyCode.SHIFT);
        this._keyMap.set('ShiftRight', keyCode.SHIFT);
        this._keyMap.set('ControlLeft', keyCode.CTRL);
        this._keyMap.set('ControlRight', keyCode.CTRL);
    }

    /** Toggle native pointer-lock mouse-delta sourcing. */
    set pointerLock(value: boolean) {
        this._pointerLock = value;
    }

    get pointerLock(): boolean {
        return this._pointerLock;
    }

    private _onWheel = (event: WheelEvent) => {
        event.preventDefault();
        this.deltas.wheel.append([event.deltaY]);
    };

    private _onPointerDown = (event: PointerEvent) => {
        this._movement.down(event);

        if (event.pointerType !== 'mouse') {
            return;
        }
        if (this._pointerLock) {
            if (document.pointerLockElement !== this._element) {
                this._element?.requestPointerLock();
            }
        } else {
            this._element?.setPointerCapture(event.pointerId);
        }

        this._clearButtons();
        this._button[event.button] = 1;
        this.deltas.button.append(this._button);

        if (this._pointerId !== -1) {
            return;
        }
        this._pointerId = event.pointerId;
    };

    private _onPointerMove = (event: PointerEvent) => {
        // Native movementX/Y under pointer lock, otherwise our screen-delta tracker.
        const [movementX, movementY] = this._pointerLock && document.pointerLockElement === this._element ?
            [event.movementX, event.movementY] :
            this._movement.move(event);

        if (event.pointerType !== 'mouse') {
            return;
        }
        if (event.target !== this._element) {
            return;
        }
        if (this._pointerLock) {
            if (document.pointerLockElement !== this._element) {
                return;
            }
        } else if (this._pointerId !== event.pointerId) {
            return;
        }

        this.deltas.mouse.append([movementX, movementY]);
    };

    private _onPointerUp = (event: PointerEvent) => {
        this._movement.up(event);

        if (event.pointerType !== 'mouse') {
            return;
        }
        if (!this._pointerLock) {
            this._element?.releasePointerCapture(event.pointerId);
        }

        this._clearButtons();
        this.deltas.button.append(this._button);

        if (this._pointerId !== event.pointerId) {
            return;
        }
        this._pointerId = -1;
    };

    private _onContextMenu = (event: MouseEvent) => {
        event.preventDefault();
    };

    private _onKeyDown = (event: KeyboardEvent) => {
        // macOS Meta-key fix: clear all keys when Meta is involved, and ignore
        // keys arriving while Cmd is held (their keyup is swallowed by the OS).
        if (event.key === 'Meta') {
            this._keyNow.fill(0);
            return;
        }
        if (event.metaKey) {
            return;
        }
        if (this._pointerLock && document.pointerLockElement !== this._element) {
            return;
        }
        event.stopPropagation();
        this._setKey(event.code, 1);
    };

    private _onKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Meta') {
            this._keyNow.fill(0);
            return;
        }
        if (event.metaKey) {
            return;
        }
        event.stopPropagation();
        this._setKey(event.code, 0);
    };

    private _clearButtons() {
        for (let i = 0; i < this._button.length; i++) {
            this._button[i] = this._button[i] === 1 ? -1 : 0;
        }
    }

    private _setKey(code: string, value: number) {
        const index = this._keyMap.get(code);
        if (index === undefined) {
            return;
        }
        this._keyNow[index] = value;
    }

    attach(element: HTMLElement): void {
        super.attach(element);

        this._element = element;
        element.addEventListener('wheel', this._onWheel, PASSIVE);
        element.addEventListener('pointerdown', this._onPointerDown);
        element.addEventListener('pointermove', this._onPointerMove);
        element.addEventListener('pointerup', this._onPointerUp);
        element.addEventListener('pointercancel', this._onPointerUp);
        element.addEventListener('pointerleave', this._onPointerUp);
        element.addEventListener('lostpointercapture', this._onPointerUp);
        element.addEventListener('contextmenu', this._onContextMenu);

        window.addEventListener('keydown', this._onKeyDown, false);
        window.addEventListener('keyup', this._onKeyUp, false);
    }

    detach(): void {
        if (!this._element) {
            return;
        }
        this._element.removeEventListener('wheel', this._onWheel, PASSIVE);
        this._element.removeEventListener('pointerdown', this._onPointerDown);
        this._element.removeEventListener('pointermove', this._onPointerMove);
        this._element.removeEventListener('pointerup', this._onPointerUp);
        this._element.removeEventListener('pointercancel', this._onPointerUp);
        this._element.removeEventListener('pointerleave', this._onPointerUp);
        this._element.removeEventListener('lostpointercapture', this._onPointerUp);
        this._element.removeEventListener('contextmenu', this._onContextMenu);

        window.removeEventListener('keydown', this._onKeyDown, false);
        window.removeEventListener('keyup', this._onKeyUp, false);

        this._keyNow.fill(0);
        this._keyPrev.fill(0);

        super.detach();
    }

    read(): { key: number[]; button: number[]; mouse: number[]; wheel: number[] } {
        for (let i = 0; i < KEY_COUNT; i++) {
            keyScratch[i] = this._keyNow[i] - this._keyPrev[i];
            this._keyPrev[i] = this._keyNow[i];
        }
        this.deltas.key.append(keyScratch);

        return super.read();
    }
}

export { KeyboardMouseSource };
