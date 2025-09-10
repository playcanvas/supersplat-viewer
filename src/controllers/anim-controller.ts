import { InputController, Vec3, type InputFrame } from 'playcanvas';

import { mod } from '../core/math';
import { CubicSpline } from '../core/spline';

type AnimTrack = {
    name: string;
    duration: number;
    frameRate: number;
    target: 'camera';
    interpolation: 'spline';
    loopMode: 'none' | 'repeat' | 'pingpong';
    smoothness: number;
    keyframes: {
        times: number[];
        values: {
            position: number[];
            target: number[];
        };
    };
}

// track an animation cursor with support for looping and ping-pong modes
class AnimCursor {
    duration: number = 0;

    loopMode: 'none' | 'repeat' | 'pingpong' = 'none';

    timer: number = 0;

    cursor: number = 0;

    constructor(duration: number, loopMode: 'none' | 'repeat' | 'pingpong') {
        this.reset(duration, loopMode);
    }

    update(deltaTime: number) {
        // update animation timer
        this.timer += deltaTime;

        // update the track cursor
        this.cursor += deltaTime;

        if (this.cursor >= this.duration) {
            switch (this.loopMode) {
                case 'none': this.cursor = this.duration; break;
                case 'repeat': this.cursor %= this.duration; break;
                case 'pingpong': this.cursor %= (this.duration * 2); break;
            }
        }
    }

    reset(duration: number, loopMode: 'none' | 'repeat' | 'pingpong') {
        this.duration = duration;
        this.loopMode = loopMode;
        this.timer = 0;
        this.cursor = 0;
    }

    set value(value: number) {
        this.cursor = mod(value, this.duration);
    }

    get value() {
        return this.cursor > this.duration ? this.duration - this.cursor : this.cursor;
    }
}

// Manage the state of a camera animation track
class AnimController extends InputController {
    spline: CubicSpline;

    cursor: AnimCursor = new AnimCursor(0, 'none');

    frameRate: number;

    result: number[] = [];

    position: Vec3 = new Vec3();

    target: Vec3 = new Vec3();

    constructor(spline: CubicSpline, duration: number, loopMode: 'none' | 'repeat' | 'pingpong', frameRate: number) {
        super();
        this.spline = spline;
        this.cursor.reset(duration, loopMode);
        this.frameRate = frameRate;
    }

    /**
     * @param frame - The input frame.
     * @param dt - The delta time.
     * @returns - The controller pose.
     */
    update(frame: InputFrame<{ move: number[], rotate: number[] }>, dt: number) {
        // discard frame
        frame.read();

        const { cursor, result, spline, frameRate, position, target } = this;

        // update the animation cursor
        cursor.update(dt);

        // evaluate the spline
        spline.evaluate(cursor.value * frameRate, result);

        if (result.every(isFinite)) {
            position.set(result[0], result[1], result[2]);
            target.set(result[3], result[4], result[5]);
        }

        // update pose
        return this._pose.look(position, target);
    }

    // construct an animation from a settings track
    static fromTrack(track: AnimTrack) {
        const { keyframes, duration, frameRate, loopMode, smoothness } = track;
        const { times, values } = keyframes;
        const { position, target } = values;

        // construct the points array containing position and target
        const points = [];
        for (let i = 0; i < times.length; i++) {
            points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
            points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
        }

        const extra = (duration === times[times.length - 1] / frameRate) ? 1 : 0;

        const spline = CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, smoothness);

        return new AnimController(spline, duration, loopMode, frameRate);
    }
}

export { AnimTrack, AnimController };
