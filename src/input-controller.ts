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
import type { CameraComponent } from 'playcanvas';

import { Picker } from './picker';
import type { Global } from './types';

/* Vec initialisation to avoid recurrent memory allocation */
const tmpV1 = new Vec3();
const tmpV2 = new Vec3();
const mouseRotate = new Vec3();
const flyMove = new Vec3();
const pinchMove = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();
const stickMove = new Vec3();
const stickRotate = new Vec3();

/**
 * Converts screen space mouse deltas to world space pan vector.
 *
 * @param camera - The camera component.
 * @param dx - The mouse delta x value.
 * @param dy - The mouse delta y value.
 * @param dz - The world space zoom delta value.
 * @param out - The output vector to store the pan result.
 * @returns - The pan vector in world space.
 * @private
 */
const screenToWorld = (camera: CameraComponent, dx: number, dy: number, dz: number, out: Vec3 = new Vec3()) => {
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

class InputController {
    private _state = {
        axis: new Vec3(),
        mouse: [0, 0, 0],
        shift: 0,
        ctrl: 0,
        touches: 0
    };

    private _desktopInput: KeyboardMouseSource = new KeyboardMouseSource();

    private _orbitInput = new MultiTouchSource();

    private _flyInput = new DualGestureSource();

    private _gamepadInput = new GamepadSource();

    global: Global;

    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

    joystick: {
        base: [number, number] | null,
        stick: [number, number] | null
    } = { base: null, stick: null };

    // this gets overridden by the viewer based on scene size
    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    pinchSpeed: number = 0.4;

    wheelSpeed: number = 0.06;

    constructor(global: Global) {
        const { app, camera, events, state } = global;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        this._desktopInput.attach(canvas);
        this._orbitInput.attach(canvas);
        this._flyInput.attach(canvas);

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

        this.global = global;

        // Generate input events
        ['wheel', 'pointerdown', 'contextmenu', 'keydown'].forEach((eventName) => {
            canvas.addEventListener(eventName, (event) => {
                events.fire('inputEvent', 'interrupt', event);
            });
        });

        canvas.addEventListener('pointermove', (event) => {
            events.fire('inputEvent', 'interact', event);
        });

        // Detect double taps manually because iOS doesn't send dblclick events
        const lastTap = { time: 0, x: 0, y: 0 };
        canvas.addEventListener('pointerdown', (event) => {
            const now = Date.now();
            const delay = Math.max(0, now - lastTap.time);
            if (delay < 300 &&
                Math.abs(event.clientX - lastTap.x) < 8 &&
                Math.abs(event.clientY - lastTap.y) < 8) {
                events.fire('inputEvent', 'dblclick', event);
                lastTap.time = 0;
            } else {
                lastTap.time = now;
                lastTap.x = event.clientX;
                lastTap.y = event.clientY;
            }
        });

        // Calculate pick location on double click
        let picker: Picker | null = null;
        events.on('inputEvent', async (eventName, event) => {
            switch (eventName) {
                case 'dblclick': {
                    if (!picker) {
                        picker = new Picker(app, camera);
                    }
                    const result = await picker.pick(event.offsetX / canvas.clientWidth, event.offsetY / canvas.clientHeight);
                    if (result) {
                        events.fire('pick', result);
                    }
                    break;
                }
            }
        });

        // update input mode based on pointer event
        ['pointerdown', 'pointermove'].forEach((eventName) => {
            window.addEventListener(eventName, (event: PointerEvent) => {
                state.inputMode = event.pointerType === 'touch' ? 'touch' : 'desktop';
            });
        });

        // handle keyboard events
        window.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                events.fire('inputEvent', 'cancel', event);
            } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
                switch (event.key) {
                    case 'f':
                        events.fire('inputEvent', 'frame', event);
                        break;
                    case 'r':
                        events.fire('inputEvent', 'reset', event);
                        break;
                    case ' ':
                        events.fire('inputEvent', 'playPause', event);
                        break;
                }
            }
        });
    }

    /**
     * @param dt - delta time in seconds
     * @param state - the current state of the app
     * @param state.cameraMode - the current camera mode
     * @param distance - the distance to the camera target
     */
    update(dt: number, distance: number) {
        const { keyCode } = KeyboardMouseSource;

        const { key, button, mouse, wheel } = this._desktopInput.read();
        const { touch, pinch, count } = this._orbitInput.read();
        const { leftInput, rightInput } = this._flyInput.read();
        const { leftStick, rightStick } = this._gamepadInput.read();

        const { events, state } = this.global;
        const { camera } = this.global.camera;

        // update state
        this._state.axis.add(tmpV1.set(
            (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
            (key[keyCode.E] - key[keyCode.Q]),
            (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
        ));
        this._state.touches += count[0];
        for (let i = 0; i < button.length; i++) {
            this._state.mouse[i] += button[i];
        }
        this._state.shift += key[keyCode.SHIFT];
        this._state.ctrl += key[keyCode.CTRL];

        if (state.cameraMode !== 'fly' && this._state.axis.length() > 0) {
            state.cameraMode = 'fly';
        }

        const orbit = +(state.cameraMode === 'orbit');
        const fly = +(state.cameraMode === 'fly');
        const double = +(this._state.touches > 1);
        const pan = this._state.mouse[2] || +(button[2] === -1) || double;

        const orbitFactor = fly ? camera.fov / 120 : 1;

        const { deltas } = this.frame;

        // desktop move
        const v = tmpV1.set(0, 0, 0);
        const keyMove = this._state.axis.clone().normalize();
        v.add(keyMove.mulScalar(fly * this.moveSpeed * (this._state.shift ? 4 : this._state.ctrl ? 0.25 : 1) * dt));
        const panMove = screenToWorld(camera, mouse[0], mouse[1], distance);
        v.add(panMove.mulScalar(pan));
        const wheelMove = new Vec3(0, 0, -wheel[0]);
        v.add(wheelMove.mulScalar(this.wheelSpeed * dt));
        // FIXME: need to flip z axis for orbit camera
        deltas.move.append([v.x, v.y, orbit ? -v.z : v.z]);

        // desktop rotate
        v.set(0, 0, 0);
        mouseRotate.set(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - pan) * this.orbitSpeed * orbitFactor * dt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // mobile move
        v.set(0, 0, 0);
        const orbitMove = screenToWorld(camera, touch[0], touch[1], distance);
        v.add(orbitMove.mulScalar(orbit * pan));
        flyMove.set(leftInput[0], 0, -leftInput[1]);
        v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        pinchMove.set(0, 0, pinch[0]);
        v.add(pinchMove.mulScalar(orbit * double * this.pinchSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);

        // mobile rotate
        v.set(0, 0, 0);
        orbitRotate.set(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - pan) * this.orbitSpeed * dt));
        flyRotate.set(rightInput[0], rightInput[1], 0);
        v.add(flyRotate.mulScalar(fly * this.orbitSpeed * orbitFactor * dt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // gamepad move
        v.set(0, 0, 0);
        stickMove.set(leftStick[0], 0, -leftStick[1]);
        v.add(stickMove.mulScalar(this.moveSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);

        // gamepad rotate
        v.set(0, 0, 0);
        stickRotate.set(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(this.orbitSpeed * orbitFactor * dt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // update touch joystick UI
        if (state.cameraMode === 'fly') {
            events.fire('touchJoystickUpdate', this.joystick.base, this.joystick.stick);
        }
    }
}

export { InputController };
