import { InputSource } from './input-frame';

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
 * Gamepad input source. Engine-free port of the PlayCanvas `GamepadSource`.
 * Polls `navigator.getGamepads()` on `read()` (no DOM listeners).
 *
 * `read()` output (standard-mapping pads with 2 sticks + 12 buttons only):
 * - `buttons` length 12, per-frame delta: +1 pressed, -1 released, 0 unchanged
 * - `leftStick` / `rightStick` [x, y], raw axis values in [-1, 1]
 */
class GamepadSource extends InputSource<GamepadDeltas> {
    static buttonCode = BUTTON_CODES;

    private _buttonPrev = new Array(BUTTON_COUNT).fill(0);

    constructor() {
        super({
            buttons: new Array(BUTTON_COUNT).fill(0),
            leftStick: [0, 0],
            rightStick: [0, 0]
        });
    }

    read(): { buttons: number[]; leftStick: number[]; rightStick: number[] } {
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
}

export { GamepadSource };
