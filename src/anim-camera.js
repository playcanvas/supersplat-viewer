import { Vec3 } from 'playcanvas';

import { mod, MyQuat } from './core/math.js';
import { CubicSpline } from './core/spline.js';

const q = new MyQuat();

// track an animation cursor with support for looping and ping-pong modes
class AnimCursor {
    duration = 0;

    loopMode = 'none';

    timer = 0;

    cursor = 0;

    constructor(duration, loopMode) {
        this.reset(duration, loopMode);
    }

    update(deltaTime) {
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

    reset(duration, loopMode) {
        this.duration = duration;
        this.loopMode = loopMode;
        this.timer = 0;
        this.cursor = 0;
    }

    set value(value) {
        this.cursor = mod(value, this.duration);
    }

    get value() {
        return this.cursor > this.duration ? this.duration - this.cursor : this.cursor;
    }
}

// Manage the state of a camera animation track
class AnimCamera {
    spline;

    cursor = new AnimCursor();

    frameRate;

    result = [];

    position = new Vec3();

    target = new Vec3();

    rotateSpeed = 0.2;

    rotation = new Vec3();

    constructor(spline, duration, loopMode, frameRate) {
        this.spline = spline;
        this.cursor.reset(duration, loopMode);
        this.frameRate = frameRate;

        // initialize the camera to the start frame
        this.update(0, null);
    }

    update(deltaTime, input) {
        const { cursor, result, spline, frameRate, position, target, rotateSpeed, rotation } = this;

        // update the animation cursor
        cursor.update(deltaTime);

        // evaluate the spline
        spline.evaluate(cursor.value * frameRate, result);

        if (result.every(isFinite)) {
            position.set(result[0], result[1], result[2]);
            target.set(result[3], result[4], result[5]);
        }

        // rotate
        if (input?.rotate) {
            if (input.rotate.events.indexOf('up') !== -1) {
                // reset on up event`
                rotation.set(0, 0, 0);
            } else {
                rotation.x = Math.max(-90, Math.min(90, rotation.x - input.rotate.value[1] * rotateSpeed));
                rotation.y = Math.max(-180, Math.min(180, rotation.y - input.rotate.value[0] * rotateSpeed));
            }
        }
    }

    getPose(pose) {
        const { position, target, rotation } = this;

        pose.fromLookAt(position, target);

        q.setFromAxisAngle(Vec3.RIGHT, rotation.x);
        pose.rotation.mul2(pose.rotation, q);

        q.setFromAxisAngle(Vec3.UP, rotation.y);
        pose.rotation.mul2(q, pose.rotation);
    }

    // construct an animation from a settings track
    static fromTrack(track) {
        const { keyframes, duration, frameRate, loopMode } = track;
        const { times, values } = keyframes;
        const { position, target } = values;

        // construct the points array containing position and target
        const points = [];
        for (let i = 0; i < times.length; i++) {
            points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
            points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
        }

        const extra = (duration === times[times.length - 1] / frameRate) ? 1 : 0;

        const spline = CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, -1);

        return new AnimCamera(spline, duration, loopMode, frameRate);
    }
}

export { AnimCamera };
