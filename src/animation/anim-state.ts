import { Vec3 } from 'playcanvas';

import { CubicSpline } from '../core/spline';
import { AnimTrack } from '../settings';
import { AnimCursor } from './anim-cursor';

// manage the state of a camera animation track
class AnimState {
    spline: CubicSpline;

    cursor: AnimCursor = new AnimCursor(0, 'none');

    frameRate: number;

    result: number[] = [];

    position: Vec3 = new Vec3();

    target: Vec3 = new Vec3();

    constructor(spline: CubicSpline, duration: number, loopMode: 'none' | 'repeat' | 'pingpong', frameRate: number) {
        this.spline = spline;
        this.cursor.reset(duration, loopMode);
        this.frameRate = frameRate;
    }

    // update given delta time
    update(dt: number) {
        const { cursor, result, spline, frameRate, position, target } = this;

        // update the animation cursor
        cursor.update(dt);

        // evaluate the spline
        spline.evaluate(cursor.value * frameRate, result);

        if (result.every(isFinite)) {
            position.set(result[0], result[1], result[2]);
            target.set(result[3], result[4], result[5]);
        }
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

        return new AnimState(spline, duration, loopMode, frameRate);
    }
}

export { AnimState };
