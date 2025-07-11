import {
    math,
    DualGestureSource,
    GamepadSource,
    InputFrame,
    KeyboardMouseSource,
    MultiTouchSource,
    PROJECTION_PERSPECTIVE,
    Vec3
} from 'playcanvas';

/** @import { CameraComponent } from 'playcanvas' */

const tmpV1 = new Vec3();
const tmpV2 = new Vec3();

/**
 * Converts screen space mouse deltas to world space pan vector.
 *
 * @param {CameraComponent} camera - The camera component.
 * @param {number} dx - The mouse delta x value.
 * @param {number} dy - The mouse delta y value.
 * @param {number} dz - The world space zoom delta value.
 * @param {Vec3} [out] - The output vector to store the pan result.
 * @returns {Vec3} - The pan vector in world space.
 * @private
 */
const screenToWorld = (camera, dx, dy, dz, out = new Vec3()) => {
    const { system, fov, aspectRatio, horizontalFov, projection, orthoHeight } = camera;
    const { width, height } = system.app.graphicsDevice.clientRect;

    // normalize deltas to device coord space
    out.set(
        -(dx / width) * 2,
        (dy / height) * 2,
        0
    );

    // calculate half size of the view frustum at the current distance
    const halfSize = tmpV2.set(0, 0, 0);
    if (projection === PROJECTION_PERSPECTIVE) {
        const halfSlice = dz * Math.tan(0.5 * fov * math.DEG_TO_RAD);
        if (horizontalFov) {
            halfSize.set(
                halfSlice,
                halfSlice / aspectRatio,
                0
            );
        } else {
            halfSize.set(
                halfSlice * aspectRatio,
                halfSlice,
                0
            );
        }
    } else {
        halfSize.set(
            orthoHeight * aspectRatio,
            orthoHeight,
            0
        );
    }

    // scale by device coord space
    out.mul(halfSize);

    return out;
};

class AppController {
    _camera;

    _axis = new Vec3();

    _touches = 0;

    _mouse = [0, 0, 0];

    _desktopInput = new KeyboardMouseSource();

    _orbitInput = new MultiTouchSource();

    _flyInput = new DualGestureSource();

    _gamepadInput = new GamepadSource();

    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

    joystick = {
        base: null,
        stick: null
    };

    moveSpeed = 0.001 * 60;

    orbitSpeed = 0.16 * 60;

    pinchSpeed = 0.4;

    wheelSpeed = 0.01 * 0.1 * 60;

    /**
     * @param {HTMLElement} element - the element to attach the input to
     * @param {CameraComponent} camera - the camera component to control
     */
    constructor(element, camera) {
        this._desktopInput.attach(element);
        this._orbitInput.attach(element);
        this._flyInput.attach(element);

        this._camera = camera;

        // convert events to joystick state
        this._flyInput.on('joystick:position:left', ([bx, by, sx, sy]) => {
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
     * @param {number} distance - the distance to the camera target
     */
    update(dt, mode, distance) {
        const { keyCode } = KeyboardMouseSource;

        const { key, button, mouse, wheel } = this._desktopInput.read();
        const { touch, pinch, count } = this._orbitInput.read();
        const { leftInput, rightInput } = this._flyInput.read();
        const { leftStick, rightStick } = this._gamepadInput.read();

        // update state
        this._axis.add(tmpV1.set(
            (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
            (key[keyCode.E] - key[keyCode.Q]),
            (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
        ));
        this._touches += count[0];
        for (let i = 0; i < button.length; i++) {
            this._mouse[i] += button[i];
        }

        const orbit = +(mode === 'orbit');
        const fly = +(mode === 'fly');
        const pan = +(this._touches > 1);

        const { deltas } = this.frame;

        // desktop move
        const v = tmpV1.set(0, 0, 0);
        const keyMove = this._axis.clone().normalize();
        v.add(keyMove.mulScalar(this.moveSpeed * dt));
        const panMove = screenToWorld(this._camera, mouse[0], mouse[1], distance);
        v.add(panMove.mulScalar(this._mouse[2]));
        const wheelMove = new Vec3(0, 0, -wheel[0]);
        v.add(wheelMove.mulScalar(this.wheelSpeed * dt));
        // FIXME: need to flip z axis for orbit camera
        deltas.move.append([v.x, v.y, orbit ? -v.z : v.z]);

        // desktop rotate
        v.set(0, 0, 0);
        const mouseRotate = new Vec3(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - this._mouse[2]) * this.orbitSpeed * dt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // mobile move
        v.set(0, 0, 0);
        const orbitMove = screenToWorld(this._camera, touch[0], touch[1], distance);
        v.add(orbitMove.mulScalar(orbit * pan));
        const flyMove = new Vec3(leftInput[0], 0, -leftInput[1]);
        v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        const pinchMove = new Vec3(0, 0, pinch[0]);
        v.add(pinchMove.mulScalar(orbit * pan * this.pinchSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);

        // mobile rotate
        v.set(0, 0, 0);
        const orbitRotate = new Vec3(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - pan) * this.orbitSpeed * dt));
        const flyRotate = new Vec3(rightInput[0], rightInput[1], 0);
        v.add(flyRotate.mulScalar(fly * this.orbitSpeed * dt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // gamepad move
        v.set(0, 0, 0);
        const stickMove = new Vec3(leftStick[0], 0, -leftStick[1]);
        v.add(stickMove.mulScalar(this.moveSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);

        // gamepad rotate
        v.set(0, 0, 0);
        const stickRotate = new Vec3(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(this.orbitSpeed * dt));
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

export { AppController };
