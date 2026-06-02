/**
 * Engine-free input plumbing. Originally ported from the PlayCanvas engine's
 * `extras/input/input.js` (which split `InputDelta` / `InputFrame`); collapsed
 * here to a single `InputFrame`, since each per-channel delta was only ever a
 * fixed-length `number[]` you appended to.
 *
 * An `InputFrame` is a named bundle of fixed-length numeric deltas. `accumulate`
 * sums raw offsets into a named channel (element-wise); `read` returns a copy of
 * every channel's current value and zeroes it. Used both as the camera
 * move/rotate frame and as the private buffer each input reader composes to
 * accumulate its own raw DOM deltas.
 */

type DeltaShape = Record<string, number[]>;

class InputFrame<T extends DeltaShape = DeltaShape> {
    private _values: Record<keyof T, number[]>;

    constructor(data: T) {
        this._values = {} as Record<keyof T, number[]>;
        for (const name in data) {
            this._values[name] = data[name].slice();
        }
    }

    // Accumulate raw offsets into the named delta (element-wise, fixed length).
    accumulate(name: keyof T, offsets: number[]): void {
        const value = this._values[name];
        for (let i = 0; i < value.length; i++) {
            value[i] += offsets[i] || 0;
        }
    }

    // Return a copy of every delta's current value and reset each to zero.
    read(): Record<keyof T, number[]> {
        const frame = {} as Record<keyof T, number[]>;
        for (const name in this._values) {
            const value = this._values[name];
            frame[name] = value.slice();
            value.fill(0);
        }
        return frame;
    }
}

export { InputFrame };
