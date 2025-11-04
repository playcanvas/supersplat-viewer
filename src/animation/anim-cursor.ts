import { mod } from '../core/math';

// track an animation cursor with support for repeat and ping-pong loop modes
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

export { AnimCursor };
