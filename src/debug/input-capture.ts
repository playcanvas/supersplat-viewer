import type { InputController } from '../input-controller';
import type { Global } from '../types';

/**
 * TEMPORARY debug harness for verifying input-mapping parity across the
 * Step-2 control-scheme refactor. Enabled only with `?inputcapture`.
 *
 * When active, the viewer cedes the per-frame input/camera update so this
 * drives `InputController.update` synchronously via `tick()`, recording the
 * resulting `{move, rotate}` frame deltas (non-draining `peek`, then drain).
 * A scripted input sequence run before and after the refactor must produce
 * identical records. Remove once Step 2 is verified.
 */
type CaptureRecord = {
    mode: string;
    gamingControls: boolean;
    inputMode: string;
    move: number[];
    rotate: number[];
};

const round = (n: number) => Math.round(n * 1e6) / 1e6;

class InputCapture {
    active = false;

    private _records: CaptureRecord[] = [];

    private _global: Global;

    private _input: InputController;

    constructor(global: Global, input: InputController) {
        this._global = global;
        this._input = input;
    }

    start() {
        this._records = [];
        this.active = true;
    }

    stop() {
        this.active = false;
    }

    clear() {
        this._records = [];
    }

    setState(key: string, value: unknown) {
        (this._global.state as unknown as Record<string, unknown>)[key] = value;
    }

    tick(dt = 1 / 60, distance = 5) {
        this._input.update(dt, distance);
        const { move, rotate } = this._input.frame.peek();
        const { state } = this._global;
        this._records.push({
            mode: state.cameraMode,
            gamingControls: state.gamingControls,
            inputMode: state.inputMode,
            move: move.map(round),
            rotate: rotate.map(round)
        });
        // drain so deltas don't leak into the next tick (camera-manager,
        // which normally reads the frame, is skipped during capture)
        this._input.frame.read();
    }

    dump(): CaptureRecord[] {
        return this._records;
    }
}

const installInputCapture = (global: Global, input: InputController): InputCapture => {
    const capture = new InputCapture(global, input);
    (window as unknown as Record<string, unknown>).__inputCapture = capture;
    return capture;
};

export { installInputCapture, InputCapture };
