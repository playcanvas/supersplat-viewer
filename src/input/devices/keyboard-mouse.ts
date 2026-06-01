import { Vec3 } from 'playcanvas';

import { damp } from '../../core/math';
import type { Global } from '../../types';
import { InputFrame } from '../input-frame';
import { movementState } from '../movement-state';
import type { InputDevice, UpdateContext } from '../shared';

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

const tmpV1 = new Vec3();
const keyMove = new Vec3();
const flyKeyVelocity = new Vec3();

type KeyboardMouseDeltas = {
    key: number[];
    button: number[];
    mouse: number[];
    wheel: number[];
};

/**
 * Keyboard + mouse reader: a self-contained input device that binds its own DOM
 * listeners and accumulates raw deltas (engine-free port of the PlayCanvas
 * `KeyboardMouseSource`), maintains the held-state shared across camera modes,
 * fires the (mode-aware) discrete intents, and exposes normalized signals +
 * tuning constants for the control schemes to map. The schemes write the
 * move/rotate frame — not this class.
 *
 * Two viewer-specific behaviours are baked into the raw reading:
 * - macOS Meta-key fix: macOS swallows `keyup` for any key released while Cmd
 *   is held, so we clear all key state on a Meta event and ignore key events
 *   that arrive with `metaKey` set.
 * - a public `pointerLock` setter so the pointer-lock manager can toggle how
 *   mouse deltas are sourced.
 *
 * Raw `read()` output (consumed internally by `update`):
 * - `key`   length 43, per-frame delta (`keyNow - keyPrev`): +1 pressed, -1 released, 0 unchanged
 * - `button` length 3 [L,M,R], level/edge: 1 pressed, -1 released-this-frame, 0 up
 * - `mouse`  [dx, dy], accumulated screen-space delta (native movementX/Y under pointer lock)
 * - `wheel`  [dY], accumulated raw wheel deltaY
 */
class KeyboardMouseDevice extends InputFrame<KeyboardMouseDeltas> implements InputDevice {
    static keyCode = KEY_CODES;

    // tuning constants (read by the schemes)
    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    wheelSpeed: number = 0.06;

    mouseRotateSensitivity: number = 0.5;

    flyMoveAccelerationDamping: number = 0.992;

    flyMoveDecelerationDamping: number = 0.993;

    /** Held WASD/QE/arrow direction (running sum of key deltas). */
    axis = new Vec3();

    shift = 0;

    ctrl = 0;

    jump = 0;

    /** Held button state per index: [LMB, MMB, RMB]. */
    buttons: [number, number, number] = [0, 0, 0];

    /** This-frame mouse delta [dx, dy]. */
    mouse: [number, number] = [0, 0];

    /** This-frame wheel delta. */
    wheel = 0;

    /** Pan-active flag (RMB held / released this frame / 2+ touches). */
    pan = 0;

    /** Smoothed fly-mode WASD velocity (zeroed outside fly mode). */
    flyVelocity = new Vec3();

    private _element: HTMLElement | null = null;

    private _global: Global | null = null;

    private _movement = movementState();

    private _pointerId = -1;

    private _pointerLock = false;

    private _keyMap = new Map<string, number>();

    private _keyPrev = new Array(KEY_COUNT).fill(0);

    private _keyNow = new Array(KEY_COUNT).fill(0);

    private _button = [0, 0, 0];

    /** This-frame button edge per index: 1 pressed, -1 released, 0 unchanged. */
    private _buttonEdge: [number, number, number] = [0, 0, 0];

    constructor() {
        super({
            key: new Array(KEY_COUNT).fill(0),
            button: [0, 0, 0],
            mouse: [0, 0],
            wheel: [0]
        });

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

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._element = canvas;

        canvas.addEventListener('wheel', this._onWheel, PASSIVE);
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerUp);
        canvas.addEventListener('pointerleave', this._onPointerUp);
        canvas.addEventListener('lostpointercapture', this._onPointerUp);
        canvas.addEventListener('contextmenu', this._onContextMenu);

        window.addEventListener('keydown', this._onKeyDown, false);
        window.addEventListener('keyup', this._onKeyUp, false);
    }

    detach(): void {
        if (this._element) {
            this._element.removeEventListener('wheel', this._onWheel, PASSIVE);
            this._element.removeEventListener('pointerdown', this._onPointerDown);
            this._element.removeEventListener('pointermove', this._onPointerMove);
            this._element.removeEventListener('pointerup', this._onPointerUp);
            this._element.removeEventListener('pointercancel', this._onPointerUp);
            this._element.removeEventListener('pointerleave', this._onPointerUp);
            this._element.removeEventListener('lostpointercapture', this._onPointerUp);
            this._element.removeEventListener('contextmenu', this._onContextMenu);
            this._element = null;
        }

        window.removeEventListener('keydown', this._onKeyDown, false);
        window.removeEventListener('keyup', this._onKeyUp, false);

        this._keyNow.fill(0);
        this._keyPrev.fill(0);
        this.read();
        this._global = null;
    }

    read(): KeyboardMouseDeltas {
        for (let i = 0; i < KEY_COUNT; i++) {
            keyScratch[i] = this._keyNow[i] - this._keyPrev[i];
            this._keyPrev[i] = this._keyNow[i];
        }
        this.deltas.key.append(keyScratch);

        return super.read();
    }

    update(ctx: UpdateContext): void {
        const { keyCode } = KeyboardMouseDevice;
        const { key, button, mouse, wheel } = this.read();
        const { events } = this._global!;

        // accumulate running input state
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
            this._buttonEdge[i] = button[i];
        }

        const { isFly, isWalk, isFirstPerson, gamingControls, dt, touchCount } = ctx;
        const pan = this.buttons[2] || +(this._buttonEdge[2] === -1) || +(touchCount > 1);
        this.pan = pan;

        // expose this-frame mouse / wheel deltas
        this.mouse[0] = mouse[0];
        this.mouse[1] = mouse[1];
        this.wheel = wheel[0];

        // auto-move cancellation and requestFirstPerson events (driven by keyboard axes)
        if (isWalk && (this.axis.x !== 0 || this.axis.z !== 0)) {
            events.fire('navigateCancel');
        }
        if (isFly && (this.axis.x !== 0 || this.axis.y !== 0 || this.axis.z !== 0)) {
            events.fire('navigateCancel');
        }
        if (isFly && wheel[0] !== 0) {
            events.fire('navigateCancel');
        }
        if (isFly && (gamingControls || pan) && (mouse[0] !== 0 || mouse[1] !== 0)) {
            events.fire('navigateCancel');
        }
        if (!isFirstPerson && this.axis.length() > 0) {
            events.fire('inputEvent', 'requestFirstPerson');
        }

        // Fly-mode WASD velocity (smoothed, accel/decel damping). Computed here
        // (every frame, mode-aware) so it resets each non-fly frame and starts
        // from rest when fly is re-entered; the fly scheme applies it.
        if (isFly) {
            keyMove.copy(this.axis);
            keyMove.normalize();
            const speed = this.moveSpeed * (this.shift ? 4 : this.ctrl ? 0.25 : 1);
            keyMove.mulScalar(speed);
            flyKeyVelocity.copy(keyMove);
            const damping = flyKeyVelocity.lengthSq() > this.flyVelocity.lengthSq() ?
                this.flyMoveAccelerationDamping :
                this.flyMoveDecelerationDamping;
            this.flyVelocity.lerp(this.flyVelocity, flyKeyVelocity, damp(damping, dt));
            if (flyKeyVelocity.lengthSq() === 0 && this.flyVelocity.lengthSq() < 1e-4) {
                this.flyVelocity.set(0, 0, 0);
            }
        } else {
            this.flyVelocity.set(0, 0, 0);
        }
    }
}

export { KeyboardMouseDevice };
