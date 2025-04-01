import { lerp, damp } from './math.js';

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

// additive input sums child inputs
class AdditiveInput extends Input {
    constructor(...args) {
        super();
        this.inputs = args;
    }

    update(dt) {
        const { inputs, value, events } = this;
        inputs.forEach((input) => {
            input.update?.(dt);
            value[0] += input.value[0];
            value[1] += input.value[1];
            value[2] += input.value[2];

            // sum events
            events.push(...input.events);
        });
    }

    clear() {
        super.clear();

        this.inputs.forEach(input => input.clear());
    }
}

// joystick sums input deltas based on stick position
class Joystick extends Input {
    constructor() {
        super();
        this.stick = [0, 0, 0];
    }

    update(dt) {
        const { value, stick } = this;
        for (let i = 0; i < 3; ++i) {
            value[i] += stick[i] * dt;
        }
    }
}

// dampens a target value (usually a toggle value based on buttons) and maps it to a joystick axis
class DampedJoystick extends Joystick {
    constructor() {
        super();
        this.target = [0, 0, 0];
    }

    update(dt) {
        const { stick, target } = this;
        const t = damp(0.98, dt);
        for (let i = 0; i < 3; ++i) {
            stick[i] = lerp(stick[i], target[i], t);
            if (Math.abs(stick[i]) < 1e-3) {
                stick[i] = 0;
            }
        }
        super.update(dt);
    }
}

// tracks a touch input and adds to the input value
class TouchInput extends Input {
    constructor() {
        super();
        this.id = null;
        this.prev = [0, 0, 0];
    }

    down(id, x, y, z = 0) {
        const { prev } = this;
        this.id = id;
        prev[0] = x;
        prev[1] = y;
        prev[2] = z;
    }

    move(x, y, z = 0) {
        const { value, prev } = this;
        value[0] += x - prev[0];
        value[1] += y - prev[1];
        value[2] += z - prev[2];
        prev[0] = x;
        prev[1] = y;
        prev[2] = z;
    }

    up() {
        this.id = null;
    }
}

// tracks a touch input and converts it to a joystick input
class TouchJoystick extends Joystick {
    constructor() {
        super();
        this.id = null;
        this.base = [0, 0, 0];
    }

    down(id, x, y, z = 0) {
        const { base } = this;
        this.id = id;
        base[0] = x;
        base[1] = y;
        base[2] = z;
    }

    move(x, y, z = 0) {
        const { base, stick } = this;
        stick[0] = x - base[0];
        stick[1] = y - base[1];
        stick[2] = z - base[2];
    }

    up() {
        const { stick } = this;
        this.id = null;
        stick[0] = 0;
        stick[1] = 0;
        stick[2] = 0;
    }
}

// track two touch inputs and convert them into 2 inputs
class TouchController {
    constructor() {
        const left = new TouchJoystick();
        const right = new TouchInput();

        const get = (id) => {
            return id === left.id ? left : (id === right.id ? right : null);
        };

        this.pointerDown = (event, element) => {
            const isLeft = event.clientX < element.getBoundingClientRect().width / 2;
            const joy = isLeft ? (left.id === null && left) : (right.id === null && right);

            if (joy) {
                joy.down(event.pointerId, event.clientX, event.clientY);
            }

            if (isLeft) {
                element.setPointerCapture(event.pointerId);
            }
        };

        this.pointerMove = (event) => {
            const joy = get(event.pointerId);
            if (joy) {
                joy.move(event.clientX, event.clientY);
            }
        };

        this.pointerUp = (event, element) => {
            const joy = get(event.pointerId);
            if (joy) {
                joy.up();
                if (joy === left) {
                    element.releasePointerCapture(event.pointerId);
                }
            }
        };

        // public interface
        this.left = left;
        this.right = right;
    }
}

// track two touch inputs and convert into 3d input when both are active
// x and y axis is two-touch translation
// z axis is two-touch distance
class TwoTouchInput extends Input {
    constructor(a, b) {
        super();

        this.a = a;
        this.b = b;

        this.active = false;
        this.prev = [0, 0, 0];
    }

    update(dt) {
        const { a, b } = this;

        a.update(dt);
        b.update(dt);

        if (a.id && b.id) {
            const { value, prev } = this;
            const aprev = a.prev;
            const bprev = b.prev;

            const curX = (aprev[0] + bprev[0]) * 0.5;
            const curY = (aprev[1] + bprev[1]) * 0.5;
            const curZ = Math.sqrt(((aprev[0] - bprev[0]) ** 2) + ((aprev[1] - bprev[1]) ** 2));

            if (!this.active) {
                this.active = true;
                prev[0] = curX;
                prev[1] = curY;
                prev[2] = curZ;
            }

            value[0] = curX - prev[0];
            value[1] = curY - prev[1];
            value[2] = -(curZ - prev[2]);

            prev[0] = curX;
            prev[1] = curY;
            prev[2] = curZ;

            // we've consumed the invividual inputs so clear them
            a.clear();
            b.clear();
        } else {
            this.active = false;
        }
    }

    clear() {
        super.clear();

        const { a, b } = this;
        a.clear();
        b.clear();
    }
}

class OrbitTouchController {
    constructor() {
        const first = new TouchInput();
        const second = new TouchInput();
        const twoTouch = new TwoTouchInput(first, second);

        this.pointerDown = (event, element) => {
            if (first.id === null) {
                first.down(event.pointerId, event.clientX, event.clientY);
                element.setPointerCapture(event.pointerId);
            } else if (second.id === null) {
                second.down(event.pointerId, event.clientX, event.clientY);
                element.setPointerCapture(event.pointerId);
            }
        };

        this.pointerMove = (event) => {
            if (event.pointerId === first.id) {
                first.move(event.clientX, event.clientY);
            } else if (event.pointerId === second.id) {
                second.move(event.clientX, event.clientY);
            }
        };

        this.pointerUp = (event, element) => {
            if (event.pointerId === first.id) {
                first.up();
                element.releasePointerCapture(event.pointerId);
            } else if (event.pointerId === second.id) {
                second.up();
                element.releasePointerCapture(event.pointerId);
            }
        };

        this.pointerCancel = this.pointerUp;

        // public interface
        this.left = twoTouch;
        this.right = first;
    }
}

class MouseInput {
    constructor() {
        this.prev = [0, 0, 0];
        this.left = new Input();
        this.middle = new Input();
        this.right = new Input();
    }

    down(x, y, z = 0) {
        const { prev } = this;
        prev[0] = x;
        prev[1] = y;
        prev[2] = z;
    }

    move(buttons, x, y, z = 0) {
        const { prev } = this;
        const dx = x - prev[0];
        const dy = y - prev[1];
        const dz = z - prev[2];
        prev[0] = x;
        prev[1] = y;
        prev[2] = z;

        if (buttons === 1) this.left.add(dx, dy, dz);
        else if (buttons === 2) this.right.add(dx, dy, dz);
        else if (buttons === 4) this.middle.add(dx, dy, dz);
    }

    up() {
        this.left.events.push('up');
    }

    clear() {
        const { left, right, middle } = this;
        left.clear();
        right.clear();
        middle.clear();
    }
}

// keyboard and mouse controller
class DesktopController {
    constructor() {
        const controls = {
            left: false,
            right: false,
            forward: false,
            backward: false,
            up: false,
            down: false,
            lookleft: false,
            lookright: false,
            lookup: false,
            lookdown: false
        };

        const keys = {
            keyw: 'forward',
            keya: 'left',
            keys: 'backward',
            keyd: 'right',
            keyq: 'up',
            keye: 'down',
            arrowleft: 'lookleft',
            arrowright: 'lookright',
            arrowup: 'lookup',
            arrowdown: 'lookdown'
        };

        const mouseInput = new MouseInput();
        const leftKeys = new DampedJoystick();
        const rightKeys = new DampedJoystick();
        const left = new AdditiveInput(mouseInput.right, leftKeys);
        const right = new AdditiveInput(mouseInput.left, rightKeys);

        this.wheel = (event) => {
            mouseInput.right.value[2] += event.deltaY * 0.1;
            mouseInput.left.value[0] += event.deltaX;
            event.preventDefault();
        };

        this.pointerDown = (event, element) => {
            mouseInput.down(event.clientX, event.clientY);
            element.setPointerCapture(event.pointerId);
        };

        this.pointerMove = (event) => {
            mouseInput.move(event.buttons, event.clientX, event.clientY);
        };

        this.pointerUp = (event, element) => {
            mouseInput.up();
            element.releasePointerCapture(event.pointerId);
        };

        this.contextMenu = event => event.preventDefault();

        const handleKey = (event, state) => {

            // ignore all keys in combination with meta
            if (event.metaKey && state) {
                return;
            }

            const key = event.code.toLowerCase();
            if (keys.hasOwnProperty(key)) {
                event.stopPropagation();
                event.preventDefault();

                controls[keys[key]] = state;

                const s = 300;

                switch (keys[key]) {
                    case 'left':
                    case 'right':
                        leftKeys.target[0] = (controls.left ? -s : 0) + (controls.right ? s : 0);
                        break;
                    case 'forward':
                    case 'backward':
                        leftKeys.target[1] = (controls.forward ? -s : 0) + (controls.backward ? s : 0);
                        break;
                    case 'up':
                    case 'down':
                        leftKeys.target[2] = (controls.up ? s : 0) + (controls.down ? -s : 0);
                        break;
                    case 'lookleft':
                    case 'lookright':
                        rightKeys.target[0] = (controls.lookleft ? -s : 0) + (controls.lookright ? s : 0);
                        break;
                    case 'lookup':
                    case 'lookdown':
                        rightKeys.target[1] = (controls.lookup ? -s : 0) + (controls.lookdown ? s : 0);
                        break;
                }
            }
        };

        this.keyDown = event => handleKey(event, true);
        this.keyUp = event => handleKey(event, false);

        this.left = left;
        this.right = right;
    }
}

class AppController {
    constructor() {
        this.touch = new TouchController();
        this.orbit = new OrbitTouchController();
        this.desktop = new DesktopController();

        // final left and right inputs are the sum of supported possible inputs
        this.left = new AdditiveInput(this.touch.left, this.orbit.left, this.desktop.left);
        this.right = new AdditiveInput(this.touch.right, this.orbit.right, this.desktop.right);

        this.update = (dt) => {
            this.left.update(dt);
            this.right.update(dt);
        };

        this.clear = () => {
            this.left.clear();
            this.right.clear();
        };
    }
}

export { AppController };
