import { InputFrame } from '../input-frame';
import type { InputDevice } from '../shared';

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
 * Gamepad reader (layer 1): pure, mode-agnostic. Polls `navigator.getGamepads()`
 * (engine-free port of the PlayCanvas `GamepadSource`; no DOM listeners) and
 * exposes the stick signals. No mode logic, no intents — the schemes own those.
 */
class GamepadDevice implements InputDevice {
    static buttonCode = BUTTON_CODES;

    /** This-frame left stick [x, y]. */
    leftStick: [number, number] = [0, 0];

    /** This-frame right stick [x, y]. */
    rightStick: [number, number] = [0, 0];

    /** Raw-delta buffer (composition, not inheritance). */
    private _raw = new InputFrame<GamepadDeltas>({
        buttons: new Array(BUTTON_COUNT).fill(0),
        leftStick: [0, 0],
        rightStick: [0, 0]
    });

    private _buttonPrev = new Array(BUTTON_COUNT).fill(0);

    // Polls navigator.getGamepads() in update() — no DOM listeners, no register.

    private _read(): GamepadDeltas {
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
            this._raw.accumulate('buttons', buttonScratch);

            this._raw.accumulate('leftStick', [gp.axes[0], gp.axes[1]]);
            this._raw.accumulate('rightStick', [gp.axes[2], gp.axes[3]]);
        }

        return this._raw.read();
    }

    update(): void {
        const { leftStick, rightStick } = this._read();

        this.leftStick[0] = leftStick[0];
        this.leftStick[1] = leftStick[1];
        this.rightStick[0] = rightStick[0];
        this.rightStick[1] = rightStick[1];
    }
}

export { GamepadDevice };
