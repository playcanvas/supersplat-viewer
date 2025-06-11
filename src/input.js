import {
    DualGestureSource,
    GamepadSource,
    InputFrame,
    KeyboardMouseSource,
    MultiTouchSource,
    Vec3
} from 'playcanvas';

const tmpV1 = new Vec3();

class AppController {
    _axis = new Vec3();

    _touches = 0;

    _mouse = [0, 0, 0];

    _desktopInput = new KeyboardMouseSource();

    _orbitInput = new MultiTouchSource();

    _flyInput = new DualGestureSource();

    _gamepadInput = new GamepadSource();

    _frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

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
        this._flyInput.leftJoystick.on('position', (bx, by, sx, sy) => {
            if (bx < 0 || by < 0 || sx < 0 || sy < 0) {
                this.joystick.base = null;
                this.joystick.stick = null;
                return;
            }
            this.joystick.base = [bx, by];
            this.joystick.stick = [sx - bx, sy - by];
        });
    }

    /**
     * @param {number} dt - delta time in seconds
     * @param {'anim' | 'fly' | 'orbit'} mode - the camera mode
     */
    update(dt, mode) {
        const { key, button, mouse, wheel } = this._desktopInput.read();
        const { touch, pinch, count } = this._orbitInput.read();
        const { leftInput, rightInput } = this._flyInput.read();
        const { leftStick, rightStick } = this._gamepadInput.read();

        // multipliers
        const bdt = 60 * dt;
        const { moveMult, lookMult, panMult, pinchMult, wheelMult } = this;

        // update state
        const [forward, back, left, right, down, up] = key;
        this._axis.add(tmpV1.set(right - left, up - down, back - forward));
        this._touches += count[0];
        for (let i = 0; i < button.length; i++) {
            this._mouse[i] += button[i];
        }

        const orbit = +(mode === 'orbit');
        const pan = +(this._touches > 1);
        const axis = tmpV1.copy(this._axis).normalize();
        const { deltas } = this._frame;

        // update desktop input
        // FIXME: flip axis for fly
        const dx = axis.x + (this._mouse[2] * -mouse[0] * panMult);
        const dy = axis.y + (this._mouse[2] * mouse[1] * panMult);
        const dz = axis.z + wheel[0] * wheelMult;
        deltas.move.append([
            (orbit ? -dx : dx) * moveMult * bdt,
            (orbit ? dy : dz) * moveMult * bdt,
            (orbit ? dz : -dy) * moveMult * bdt
        ]);
        deltas.rotate.append([
            (1 - this._mouse[2]) * mouse[0] * lookMult * bdt,
            (1 - this._mouse[2]) * mouse[1] * lookMult * bdt,
            0
        ]);

        // update mobile input
        deltas.move.append([
            (orbit ? (pan * touch[0] * panMult) : leftInput[0]) * moveMult * bdt,
            (orbit ? (pan * touch[1] * panMult) : leftInput[1]) * moveMult * bdt,
            (orbit * (pan * pinch[0] * pinchMult)) * moveMult * bdt
        ]);
        deltas.rotate.append([
            (orbit ? ((1 - pan) * touch[0]) : rightInput[0]) * lookMult * bdt,
            (orbit ? ((1 - pan) * touch[1]) : rightInput[1]) * lookMult * bdt,
            (orbit * ((1 - pan) * pinch[0] * pinchMult)) * moveMult * bdt
        ]);

        // update gamepad input
        deltas.move.append([
            leftStick[0] * moveMult * bdt,
            leftStick[1] * moveMult * bdt,
            0
        ]);
        deltas.rotate.append([
            rightStick[0] * lookMult * bdt,
            rightStick[1] * lookMult * bdt,
            0
        ]);
    }

    read() {
        return this._frame.read();
    }
}

export { AppController };
