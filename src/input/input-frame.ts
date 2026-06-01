/**
 * Engine-free input plumbing. Ported from the PlayCanvas engine's
 * `extras/input/input.js` so the input layer carries no PlayCanvas dependency.
 *
 * An `InputDelta` accumulates per-frame deltas and zeroes itself on `read()`.
 * An `InputFrame` is a named bundle of deltas — used both as the camera
 * move/rotate frame and as the base each input reader extends to accumulate its
 * own raw DOM deltas.
 */

type DeltaShape = Record<string, number[]>;

/**
 * A fixed-length numeric delta that accumulates offsets and resets to zero
 * when read.
 */
class InputDelta {
    private _value: number[];

    constructor(arg: number | number[]) {
        this._value = Array.isArray(arg) ? arg.slice() : new Array(arg).fill(0);
    }

    // Add another delta's values into this one.
    add(other: InputDelta): this {
        for (let i = 0; i < this._value.length; i++) {
            this._value[i] += other._value[i] || 0;
        }
        return this;
    }

    // Accumulate raw offsets into this delta.
    append(offsets: number[]): this {
        for (let i = 0; i < this._value.length; i++) {
            this._value[i] += offsets[i] || 0;
        }
        return this;
    }

    // Copy another delta's values into this one.
    copy(other: InputDelta): this {
        for (let i = 0; i < this._value.length; i++) {
            this._value[i] = other._value[i] || 0;
        }
        return this;
    }

    // Euclidean magnitude of the accumulated delta.
    length(): number {
        let sum = 0;
        for (const v of this._value) {
            sum += v * v;
        }
        return Math.sqrt(sum);
    }

    // Return a copy of the current values and reset them to zero.
    read(): number[] {
        const value = this._value.slice();
        this._value.fill(0);
        return value;
    }
}

/**
 * A named bundle of input deltas. `read()` flushes (and zeroes) every delta.
 * Input readers extend this to accumulate their raw per-frame deltas.
 */
class InputFrame<T extends DeltaShape = DeltaShape> {
    deltas: Record<keyof T, InputDelta>;

    constructor(data: T) {
        this.deltas = {} as Record<keyof T, InputDelta>;
        for (const name in data) {
            this.deltas[name] = new InputDelta(data[name]);
        }
    }

    // Flush every delta to its current value and reset to zero.
    read(): Record<keyof T, number[]> {
        const frame = {} as Record<keyof T, number[]>;
        for (const name in this.deltas) {
            frame[name] = this.deltas[name].read();
        }
        return frame;
    }
}

export { InputDelta, InputFrame };
