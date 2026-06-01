import type { Global } from '../../types';
import { InputFrame } from '../input-frame';
import type { InputDevice, UpdateContext } from '../shared';

const BUTTON_CODES = {
    A: 0,
    B: 1,
    X: 2,
    Y: 3,
    LB: 4,
    RB: 5,
    LT: 6,
    RT: 7,
    SELECT: 8,
    START: 9,
    LEFT_STICK: 10,
    RIGHT_STICK: 11
} as const;
const BUTTON_COUNT = Object.keys(BUTTON_CODES).length;

/** Shared scratch buffer for per-frame button deltas. */
const buttonScratch = new Array(BUTTON_COUNT).fill(0);

type GamepadDeltas = {
    buttons: number[];
    leftStick: number[];
    rightStick: number[];
};

/**
 * Gamepad reader: a self-contained input device that polls
 * `navigator.getGamepads()` on `read()` (engine-free port of the PlayCanvas
 * `GamepadSource`; no DOM listeners), fires the (fly-mode) navigateCancel
 * intent, and exposes the stick signals + tuning constants for the control
 * schemes to map.
 *
 * Raw `read()` output (standard-mapping pads with 2 sticks + 12 buttons only):
 * - `buttons` length 12, per-frame delta: +1 pressed, -1 released, 0 unchanged
 * - `leftStick` / `rightStick` [x, y], raw axis values in [-1, 1]
 */
class GamepadDevice extends InputFrame<GamepadDeltas> implements InputDevice {
    static buttonCode = BUTTON_CODES;

    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    gamepadRotateSensitivity: number = 1.0;

    /** This-frame left stick [x, y]. */
    leftStick: [number, number] = [0, 0];

    /** This-frame right stick [x, y]. */
    rightStick: [number, number] = [0, 0];

    private _global: Global | null = null;

    private _buttonPrev = new Array(BUTTON_COUNT).fill(0);

    constructor() {
        super({
            buttons: new Array(BUTTON_COUNT).fill(0),
            leftStick: [0, 0],
            rightStick: [0, 0]
        });
    }

    attach(_canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        // Polls navigator.getGamepads() in read() — no DOM attach needed.
    }

    detach(): void {
        this._global = null;
    }

    read(): GamepadDeltas {
        const gamepads = navigator.getGamepads();
        for (let i = 0; i < gamepads.length; i++) {
            const gp = gamepads[i];

            if (!gp) {
                continue;
            }
            if (gp.mapping !== 'standard') {
                continue;
            }
            if (gp.axes.length < 4) {
                continue;
            }
            if (gp.buttons.length < BUTTON_COUNT) {
                continue;
            }

            for (let j = 0; j < this._buttonPrev.length; j++) {
                const state = +gp.buttons[j].pressed;
                buttonScratch[j] = state - this._buttonPrev[j];
                this._buttonPrev[j] = state;
            }
            this.deltas.buttons.append(buttonScratch);

            this.deltas.leftStick.append([gp.axes[0], gp.axes[1]]);
            this.deltas.rightStick.append([gp.axes[2], gp.axes[3]]);
        }

        return super.read();
    }

    update(ctx: UpdateContext): void {
        const { leftStick, rightStick } = this.read();

        this.leftStick[0] = leftStick[0];
        this.leftStick[1] = leftStick[1];
        this.rightStick[0] = rightStick[0];
        this.rightStick[1] = rightStick[1];

        if (ctx.isFly && (leftStick[0] !== 0 || leftStick[1] !== 0 || rightStick[0] !== 0 || rightStick[1] !== 0)) {
            this._global?.events.fire('navigateCancel');
        }
    }
}

export { GamepadDevice };
