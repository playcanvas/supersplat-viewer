import { mod } from '../core/math';

// track an animation cursor with support for repeat and ping-pong loop modes
class AnimCursor {
    duration = 0;

    loopMode: 'none' | 'repeat' | 'pingpong' = 'none';

    timer = 0;

    cursor = 0;

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
                case 'none':
                    this.cursor = this.duration;
                    break;
                case 'repeat':
                    this.cursor %= this.duration;
                    break;
                case 'pingpong':
                    this.cursor %= this.duration * 2;
                    break;
            }
        }
    }

    reset(duration: number, loopMode: 'none' | 'repeat' | 'pingpong') {
        this.duration = duration;
        this.loopMode = loopMode;
        this.timer = 0;
        this.cursor = 0;
    }

    // true once a play-once animation has reached the end of the track
    get ended() {
        return this.loopMode === 'none' && this.cursor >= this.duration;
    }

    set value(value: number) {
        // 'repeat' wraps (the end is the start); 'none' and 'pingpong' clamp so a
        // scrub to the exact end parks on the last frame instead of wrapping to 0
        this.cursor =
            this.loopMode === 'repeat' ? mod(value, this.duration) : Math.max(0, Math.min(this.duration, value));
    }

    get value() {
        return this.cursor > this.duration ? 2 * this.duration - this.cursor : this.cursor;
    }
}

export { AnimCursor };
