import { DualGestureSource, KeyboardMouseSource, MultiTouchSource, Vec3 } from 'playcanvas';

const tmpV1 = new Vec3();

// stores the input deltas for 3 axes (x, y, z)
class Input {
    constructor() {
        this.value = [0, 0, 0];
        this.events = [];
    }

    // helper to add to the input value
    add(x, y, z) {
        this.value[0] += x;
        this.value[1] += y;
        this.value[2] += z;
    }

    update(dt) {

    }

    clear() {
        this.value.fill(0);
        this.events.splice(0);
    }
}

class AppController {
    _axis = new Vec3();

    _touches = 0;

    _mouse = [0, 0, 0];

    _desktopInput = new KeyboardMouseSource();

    _orbitInput = new MultiTouchSource();

    _flyInput = new DualGestureSource();

    left = new Input();

    right = new Input();

    joystick = {
        base: null,
        stick: null
    };

    /**
     * @param {HTMLElement} element - the element to attach the input to
     */
    constructor(element) {
        this._desktopInput.attach(element);
        this._orbitInput.attach(element);
        this._flyInput.attach(element);

        // convert events to joystick state
        this._flyInput.leftJoystick.on('position:base', (x, y) => {
            this.joystick.base = [x, y];
        });
        this._flyInput.leftJoystick.on('position:stick', (x, y) => {
            const dx = x - this.joystick.base[0];
            const dy = y - this.joystick.base[1];
            this.joystick.stick = [dx, dy];
        });
        this._flyInput.leftJoystick.on('reset', () => {
            this.joystick.base = null;
            this.joystick.stick = null;
        });
    }

    /**
     * @param {number} dt - delta time in seconds
     * @param {'anim' | 'fly' | 'orbit'} mode - the camera mode
     */
    update(dt, mode) {
        const { key, button, mouse, wheel } = this._desktopInput.frame();
        const { touch, pinch, count } = this._orbitInput.frame();
        const { left, right } = this._flyInput.frame();

        // multipliers
        const bdt = 60 * dt;
        const moveDt = 5 * bdt;
        const lookDt = 1 * bdt;

        // update state
        const [negz, posz, negx, posx, negy, posy] = key;
        this._axis.add(tmpV1.set(posx - negx, posy - negy, posz - negz));
        this._touches += count[0];
        for (let i = 0; i < button.length; i++) {
            this._mouse[i] += button[i];
        }

        // update desktop input
        const axis = tmpV1.copy(this._axis).normalize();
        this.left.add(
            (-axis.x + this._mouse[2] * mouse[0] * 0.25) * moveDt,
            (axis.y + this._mouse[2] * mouse[1] * 0.25) * moveDt,
            (axis.z + wheel[0] * 0.01) * moveDt
        );
        this.right.add(
            (1 - this._mouse[2]) * mouse[0] * lookDt,
            (1 - this._mouse[2]) * mouse[1] * lookDt,
            0
        );

        // update mobile input
        const pan = +(this._touches > 1);
        const orbit = +(mode === 'orbit');
        this.left.add(
            (orbit * (pan * touch[0] * 0.25) + (1 - orbit) * left[0]) * moveDt,
            (orbit * (pan * touch[1] * 0.25) + (1 - orbit) * left[1]) * moveDt,
            (orbit * (pan * pinch[0] * 0.1)) * moveDt
        );
        this.right.add(
            (orbit * ((1 - pan) * touch[0]) + (1 - orbit) * right[0]) * lookDt,
            (orbit * ((1 - pan) * touch[1]) + (1 - orbit) * right[1]) * lookDt,
            (orbit * ((1 - pan) * pinch[0] * 0.1)) * moveDt
        );
    }

    clear() {
        this.left.clear();
        this.right.clear();
    }
}

export { AppController };
