import { DualGestureSource, KeyboardMouseSource, MultiTouchSource } from 'camera-controls';
import { Vec3 } from 'playcanvas';

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

    desktopInput = new KeyboardMouseSource();

    orbitInput = new MultiTouchSource();

    flyInput = new DualGestureSource();

    left = new Input();

    right = new Input();

    /**
     * @param {HTMLElement} element - the element to attach the input to
     */
    constructor(element) {
        this.desktopInput.attach(element);
        this.orbitInput.attach(element);
        this.flyInput.attach(element);
    }

    /**
     * @param {number} dt - delta time in seconds
     * @param {'anim' | 'fly' | 'orbit'} mode - the camera mode
     */
    update(dt, mode) {
        const { key, mouse, wheel } = this.desktopInput.frame();
        const { touch, pinch, count } = this.orbitInput.frame();
        const { left, right } = this.flyInput.frame();

        // multipliers
        const fdt = 60 * dt;
        const moveMult = 5 * fdt;
        const wheelMult = 0.05 * fdt;
        const pinchMult = 0.5 * fdt;
        const lookMult = 1 * fdt;

        // update state
        const [negz, posz, negx, posx, negy, posy] = key;
        this._axis.add(tmpV1.set(posx - negx, posy - negy, posz - negz));
        this._touches += count[0];

        // update mobile input
        switch (mode) {
            case 'orbit': {
                // desktop
                tmpV1.copy(this._axis).normalize();
                this.left.add(
                    -tmpV1.x * moveMult,
                    tmpV1.y * moveMult,
                    tmpV1.z * moveMult + wheel[0] * wheelMult
                );
                this.right.add(
                    mouse[0] * lookMult,
                    mouse[1] * lookMult,
                    0
                );

                // mobile
                if (this._touches > 1) {
                    this.left.add(
                        touch[0] * moveMult * 0.5,
                        touch[1] * moveMult * 0.5,
                        pinch[0] * pinchMult
                    );
                } else {
                    this.right.add(
                        touch[0] * lookMult,
                        touch[1] * lookMult,
                        pinch[0] * pinchMult
                    );
                }
                break;
            }
            case 'fly': {
                // desktop
                tmpV1.copy(this._axis).normalize();
                this.left.add(
                    tmpV1.x * moveMult,
                    tmpV1.z * moveMult,
                    -tmpV1.y * moveMult
                );
                this.right.add(
                    mouse[0] * lookMult,
                    mouse[1] * lookMult,
                    0
                );

                // mobile
                this.left.add(
                    left[0] * moveMult,
                    left[1] * moveMult,
                    0
                );
                this.right.add(
                    right[0] * lookMult,
                    right[1] * lookMult,
                    0
                );
                break;
            }
        }
    }

    clear() {
        this.left.clear();
        this.right.clear();
    }
}

export { AppController };
