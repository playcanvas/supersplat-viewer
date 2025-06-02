import { DualGestureSource, GamepadSource, KeyboardMouseSource, MultiTouchSource, Vec3 } from 'playcanvas';

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

    _gamepadInput = new GamepadSource();

    left = new Input();

    right = new Input();

    joystick = {
        base: null,
        stick: null
    };

    moveMult = 5;

    lookMult = 1;

    panMult = 0.25;

    pinchMult = 0.1;

    wheelMult = 0.01;

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
        const { leftStick, rightStick } = this._gamepadInput.frame();

        // multipliers
        const bdt = 60 * dt;
        const { moveMult, lookMult, panMult, pinchMult, wheelMult } = this;

        // update state
        const [negz, posz, negx, posx, negy, posy] = key;
        this._axis.add(tmpV1.set(posx - negx, posy - negy, posz - negz));
        this._touches += count[0];
        for (let i = 0; i < button.length; i++) {
            this._mouse[i] += button[i];
        }

        const orbit = +(mode === 'orbit');
        const pan = +(this._touches > 1);
        const axis = tmpV1.copy(this._axis).normalize();

        // update desktop input
        // FIXME: flip axis for fly
        const dx = axis.x + (this._mouse[2] * -mouse[0] * panMult);
        const dy = axis.y + (this._mouse[2] * mouse[1] * panMult);
        const dz = axis.z + wheel[0] * wheelMult;
        this.left.add(
            (orbit ? -dx : dx) * moveMult * bdt,
            (orbit ? dy : dz) * moveMult * bdt,
            (orbit ? dz : -dy) * moveMult * bdt
        );
        this.right.add(
            (1 - this._mouse[2]) * mouse[0] * lookMult * bdt,
            (1 - this._mouse[2]) * mouse[1] * lookMult * bdt,
            0
        );

        // update mobile input
        this.left.add(
            (orbit ? (pan * touch[0] * panMult) : left[0]) * moveMult * bdt,
            (orbit ? (pan * touch[1] * panMult) : left[1]) * moveMult * bdt,
            (orbit * (pan * pinch[0] * pinchMult)) * moveMult * bdt
        );
        this.right.add(
            (orbit ? ((1 - pan) * touch[0]) : right[0]) * lookMult * bdt,
            (orbit ? ((1 - pan) * touch[1]) : right[1]) * lookMult * bdt,
            (orbit * ((1 - pan) * pinch[0] * pinchMult)) * moveMult * bdt
        );

        // update gamepad input
        this.left.add(
            leftStick[0] * moveMult * bdt,
            leftStick[1] * moveMult * bdt,
            0
        );
        this.right.add(
            rightStick[0] * lookMult * bdt,
            rightStick[1] * lookMult * bdt,
            0
        );
    }

    clear() {
        this.left.clear();
        this.right.clear();
    }
}

export { AppController };
