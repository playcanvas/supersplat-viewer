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
        const moveMult = 0.5;
        const lookMult = 0.2;
        const panMult = 0.01;
        const pinchMult = 0.5;
        const wheelMult = 0.005;

        // update state
        const [forward, back, left, right, down, up] = key;
        this._axis.add(tmpV1.set(right - left, up - down, back - forward));
        this._touches += count[0];
        for (let i = 0; i < button.length; i++) {
            this._mouse[i] += button[i];
        }

        const orbit = +(mode === 'orbit');
        const fly = +(mode === 'fly');
        const pan = +(this._touches > 1);
        const { deltas } = this._frame;

        // desktop move
        const v = tmpV1.set(0, 0, 0);
        const keyMove = this._axis.clone().normalize();
        v.add(keyMove.mulScalar(moveMult * bdt));
        const panMove = new Vec3(-mouse[0], mouse[1], 0);
        v.add(panMove.mulScalar(this._mouse[2] * panMult * bdt));
        const wheelMove = new Vec3(0, 0, wheel[0]);
        v.add(wheelMove.mulScalar(wheelMult * bdt));
        // FIXME: flip axis for fly
        if (orbit) {
            deltas.move.append([-v.x, v.y, v.z]);
        } else {
            deltas.move.append([v.x, v.z, -v.y]);
        }

        // desktop rotate
        v.set(0, 0, 0);
        const mouseRotate = new Vec3(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - this._mouse[2]) * lookMult * bdt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // mobile move
        v.set(0, 0, 0);
        const touchPan = new Vec3(touch[0], touch[1], 0);
        v.add(touchPan.mulScalar(orbit * pan * panMult * bdt));
        const flyMove = new Vec3(leftInput[0], leftInput[1], 0);
        v.add(flyMove.mulScalar(fly * moveMult * bdt));
        const pinchMove = new Vec3(0, 0, pinch[0]);
        v.add(pinchMove.mulScalar(orbit * pan * pinchMult * bdt));
        deltas.move.append([v.x, v.y, v.z]);

        // mobile rotate
        v.set(0, 0, 0);
        const touchRotate = new Vec3(touch[0], touch[1], 0);
        v.add(touchRotate.mulScalar(orbit * (1 - pan) * lookMult * bdt));
        const flyRotate = new Vec3(rightInput[0], rightInput[1], 0);
        v.add(flyRotate.mulScalar(fly * lookMult * bdt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // gamepad move
        v.set(0, 0, 0);
        const stickMove = new Vec3(leftStick[0], leftStick[1], 0);
        v.add(stickMove.mulScalar(moveMult * bdt));
        deltas.move.append([v.x, v.y, v.z]);

        // gamepad rotate
        v.set(0, 0, 0);
        const stickRotate = new Vec3(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(lookMult * bdt));
        deltas.rotate.append([v.x, v.y, v.z]);
    }

    read() {
        return this._frame.read();
    }
}

export { AppController };
