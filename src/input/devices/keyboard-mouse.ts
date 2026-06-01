import { Vec3 } from 'playcanvas';

import { InputFrame } from '../input-frame';
import { movementState } from '../movement-state';
import type { InputDevice } from '../shared';

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

const tmpV1 = new Vec3();

type KeyboardMouseDeltas = {
    key: number[];
    button: number[];
    mouse: number[];
    wheel: number[];
};

/**
 * Keyboard + mouse reader (layer 1): pure, mode-agnostic. Does NOT register its
 * own DOM listeners — the central `DomEventSource` owns registration and calls
 * the public `on*` handlers (the coordinator wires them in explicit order). The
 * handlers accumulate raw deltas into a private buffer; `update()` integrates
 * the held-state shared across modes and refreshes the exposed signals.
 *
 * macOS Meta-key fix is baked into the raw reading (macOS swallows `keyup` for
 * keys released while Cmd is held); a public `pointerLock` setter lets the
 * pointer-lock manager switch mouse-delta sourcing.
 */
class KeyboardMouseDevice implements InputDevice {
    static keyCode = KEY_CODES;

    /** Held WASD/QE/arrow direction (running sum of key deltas). */
    axis = new Vec3();

    shift = 0;

    ctrl = 0;

    jump = 0;

    /** Held button state per index: [LMB, MMB, RMB]. */
    buttons: [number, number, number] = [0, 0, 0];

    /** This-frame button edge per index: 1 pressed, -1 released, 0 unchanged. */
    buttonEdge: [number, number, number] = [0, 0, 0];

    /** This-frame mouse delta [dx, dy]. */
    mouse: [number, number] = [0, 0];

    /** This-frame wheel delta. */
    wheel = 0;

    /** Raw-delta buffer (composition, not inheritance). */
    private _raw = new InputFrame<KeyboardMouseDeltas>({
        key: new Array(KEY_COUNT).fill(0),
        button: [0, 0, 0],
        mouse: [0, 0],
        wheel: [0]
    });

    private _element: HTMLElement | null = null;

    private _movement = movementState();

    private _pointerId = -1;

    private _pointerLock = false;

    private _keyMap = new Map<string, number>();

    private _keyPrev = new Array(KEY_COUNT).fill(0);

    private _keyNow = new Array(KEY_COUNT).fill(0);

    private _button = [0, 0, 0];

    constructor() {
        const { keyCode } = KeyboardMouseDevice;

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

    onWheel = (e: Event): void => {
        const event = e as WheelEvent;
        event.preventDefault();
        this._raw.deltas.wheel.append([event.deltaY]);
    };

    onPointerDown = (e: Event): void => {
        const event = e as PointerEvent;
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
        this._raw.deltas.button.append(this._button);

        if (this._pointerId !== -1) {
            return;
        }
        this._pointerId = event.pointerId;
    };

    onPointerMove = (e: Event): void => {
        const event = e as PointerEvent;
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

        this._raw.deltas.mouse.append([movementX, movementY]);
    };

    onPointerUp = (e: Event): void => {
        const event = e as PointerEvent;
        this._movement.up(event);

        if (event.pointerType !== 'mouse') {
            return;
        }
        if (!this._pointerLock) {
            this._element?.releasePointerCapture(event.pointerId);
        }

        this._clearButtons();
        this._raw.deltas.button.append(this._button);

        if (this._pointerId !== event.pointerId) {
            return;
        }
        this._pointerId = -1;
    };

    onContextMenu = (e: Event): void => {
        e.preventDefault();
    };

    onKeyDown = (e: Event): void => {
        const event = e as KeyboardEvent;
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

    onKeyUp = (e: Event): void => {
        const event = e as KeyboardEvent;
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

    // Compute per-frame key deltas, then flush the raw buffer.
    private _read(): KeyboardMouseDeltas {
        for (let i = 0; i < KEY_COUNT; i++) {
            keyScratch[i] = this._keyNow[i] - this._keyPrev[i];
            this._keyPrev[i] = this._keyNow[i];
        }
        this._raw.deltas.key.append(keyScratch);
        return this._raw.read();
    }

    attach(canvas: HTMLCanvasElement): void {
        this._element = canvas;
    }

    detach(): void {
        this._element = null;
        this._keyNow.fill(0);
        this._keyPrev.fill(0);
        this._read();
    }

    update(): void {
        const { keyCode } = KeyboardMouseDevice;
        const { key, button, mouse, wheel } = this._read();

        this.axis.add(tmpV1.set(
            (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
            (key[keyCode.E] - key[keyCode.Q]),
            (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
        ));
        this.jump += key[keyCode.SPACE];
        this.shift += key[keyCode.SHIFT];
        this.ctrl += key[keyCode.CTRL];

        const n = Math.min(button.length, this.buttons.length);
        for (let i = 0; i < n; i++) {
            this.buttons[i] += button[i];
            this.buttonEdge[i] = button[i];
        }

        this.mouse[0] = mouse[0];
        this.mouse[1] = mouse[1];
        this.wheel = wheel[0];
    }
}

export { KeyboardMouseDevice };
