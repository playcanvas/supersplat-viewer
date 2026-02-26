import {
    math,
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
const flyTouchPan = new Vec3();
const pinchMove = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();
const stickMove = new Vec3();
const stickRotate = new Vec3();

/** Maximum accumulated touch movement (px) to still count as a tap */
const TAP_EPSILON = 15;

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

// patch keydown and keyup to ignore events with meta key otherwise
// keys can get stuck on macOS.
const patchKeyboardMeta = (desktopInput: any) => {
    const origOnKeyDown = desktopInput._onKeyDown;
    desktopInput._onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        } else if (!event.metaKey) {
            origOnKeyDown(event);
        }
    };

    const origOnKeyUp = desktopInput._onKeyUp;
    desktopInput._onKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        } else if (!event.metaKey) {
            origOnKeyUp(event);
        }
    };
};

class InputController {
    private _state = {
        axis: new Vec3(),
        mouse: [0, 0, 0],
        shift: 0,
        ctrl: 0,
        jump: 0,
        touches: 0
    };

    private _desktopInput: KeyboardMouseSource = new KeyboardMouseSource();

    private _orbitInput = new MultiTouchSource();

    private _gamepadInput = new GamepadSource();

    global: Global;

    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

    // Touch joystick input values [x, y] (-1 to 1)
    private _touchJoystick: number[] = [0, 0];

    // Accumulated forward/backward velocity from pinch gesture (-1 to 1)
    private _pinchVelocity: number = 0;

    // Accumulated strafe/vertical velocity from two-finger pan [x, y] (-1 to 1)
    private _panVelocity: number[] = [0, 0];

    // Sensitivity for pinch delta → velocity conversion
    pinchVelocitySensitivity: number = 0.006;

    // Sensitivity for two-finger pan delta → velocity conversion
    panVelocitySensitivity: number = 0.005;

    // Tap-to-jump state (uses existing MultiTouchSource count/touch deltas)
    private _tapTouches: number = 0;

    private _tapDelta: number = 0;

    private _tapJump: boolean = false;

    // this gets overridden by the viewer based on scene size
    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    pinchSpeed: number = 0.4;

    wheelSpeed: number = 0.06;

    constructor(global: Global) {
        const { app, camera, events, state } = global;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        patchKeyboardMeta(this._desktopInput);

        this._desktopInput.attach(canvas);
        this._orbitInput.attach(canvas);

        // Listen for joystick input from the UI (touch joystick element)
        events.on('joystickInput', (value: { x: number; y: number }) => {
            this._touchJoystick[0] = value.x;
            this._touchJoystick[1] = value.y;
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
                    if (state.cameraMode === 'fps') break;
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

        let recentlyExitedFps = false;

        // handle keyboard events
        window.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (recentlyExitedFps) {
                    // Already handled by pointerlockchange
                } else if (state.cameraMode === 'fps') {
                    events.fire('inputEvent', 'exitFps', event);
                } else {
                    events.fire('inputEvent', 'cancel', event);
                }
            } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
                switch (event.key) {
                    case '1':
                        state.cameraMode = 'orbit';
                        break;
                    case '2':
                        state.cameraMode = 'fly';
                        break;
                    case '3':
                        events.fire('inputEvent', 'toggleFps');
                        break;
                }
                if (state.cameraMode !== 'fps') {
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
            }
        });

        // Lock/unlock Escape key in fullscreen to prevent the browser from
        // exiting both pointer lock and fullscreen on the same Escape press.
        const lockEscape = () => {
            if ('keyboard' in navigator && 'lock' in (navigator as any).keyboard) {
                (navigator as any).keyboard.lock(['Escape']).catch(() => {});
            }
        };

        const unlockKeyboard = () => {
            if ('keyboard' in navigator && 'unlock' in (navigator as any).keyboard) {
                (navigator as any).keyboard.unlock();
            }
        };

        // Pointer lock management for FPS mode on desktop
        events.on('cameraMode:changed', (value: string, prev: string) => {
            if (value === 'fps' && state.inputMode === 'desktop') {
                (this._desktopInput as any)._pointerLock = true;
                canvas.requestPointerLock();
                if (state.isFullscreen) {
                    lockEscape();
                }
            } else if (prev === 'fps') {
                unlockKeyboard();
                (this._desktopInput as any)._pointerLock = false;
                if (document.pointerLockElement === canvas) {
                    if (state.isFullscreen) {
                        events.fire('restoreFullscreen');
                    }
                    document.exitPointerLock();
                }
            }
        });

        // Also lock Escape if entering fullscreen while already in FPS mode
        events.on('isFullscreen:changed', (value: boolean) => {
            if (value && state.cameraMode === 'fps' && state.inputMode === 'desktop') {
                lockEscape();
            }
        });

        document.addEventListener('pointerlockchange', () => {
            if (!document.pointerLockElement && state.cameraMode === 'fps') {
                recentlyExitedFps = true;
                requestAnimationFrame(() => {
                    recentlyExitedFps = false;
                });
                events.fire('inputEvent', 'exitFps');
            }
        });

        // Pointer lock request rejected (e.g., no user gesture, document hidden).
        // Revert to avoid being stuck in FPS mode without mouse capture.
        document.addEventListener('pointerlockerror', () => {
            (this._desktopInput as any)._pointerLock = false;
            events.fire('inputEvent', 'exitFps');
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
        const { leftStick, rightStick } = this._gamepadInput.read();

        const { state, events } = this.global;
        const { camera } = this.global.camera;

        // update state
        this._state.axis.add(tmpV1.set(
            (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
            (key[keyCode.E] - key[keyCode.Q]),
            (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
        ));
        this._state.jump += key[keyCode.SPACE];
        this._state.touches += count[0];
        for (let i = 0; i < button.length; i++) {
            this._state.mouse[i] += button[i];
        }
        this._state.shift += key[keyCode.SHIFT];
        this._state.ctrl += key[keyCode.CTRL];

        const isFps = state.cameraMode === 'fps';

        // Tap-to-jump detection using existing MultiTouchSource deltas
        if (isFps) {
            const prevTaps = this._tapTouches;
            this._tapTouches = Math.max(0, this._tapTouches + count[0]);

            // Touch just started (0 → 1+)
            if (prevTaps === 0 && this._tapTouches > 0) {
                this._tapDelta = 0;
            }

            // Accumulate movement while touch is active
            if (this._tapTouches > 0) {
                this._tapDelta += Math.abs(touch[0]) + Math.abs(touch[1]);
            }

            // Touch just ended (1+ → 0): check if it was a tap
            if (prevTaps > 0 && this._tapTouches === 0) {
                if (this._tapDelta < TAP_EPSILON) {
                    this._tapJump = true;
                }
            }
        } else {
            this._tapTouches = 0;
        }

        const isFirstPerson = state.cameraMode === 'fly' || isFps;

        // Accumulate pinch and pan deltas into velocity when using pinch control scheme
        // pinch[0] = oldDist - newDist: negative when spreading, positive when closing
        // Spreading = forward → subtract pinch delta
        if (isFirstPerson && state.touchControlScheme === 'pinch' && this._state.touches > 1) {
            this._pinchVelocity -= pinch[0] * this.pinchVelocitySensitivity;
            this._pinchVelocity = math.clamp(this._pinchVelocity, -1.0, 1.0);
            this._panVelocity[0] += touch[0] * this.panVelocitySensitivity;
            this._panVelocity[0] = math.clamp(this._panVelocity[0], -1.0, 1.0);
            this._panVelocity[1] += touch[1] * this.panVelocitySensitivity;
            this._panVelocity[1] = math.clamp(this._panVelocity[1], -1.0, 1.0);
        } else if (isFirstPerson && this._state.touches <= 1) {
            this._pinchVelocity = 0;
            this._panVelocity[0] = 0;
            this._panVelocity[1] = 0;
        }

        if (!isFirstPerson && this._state.axis.length() > 0) {
            events.fire('inputEvent', 'requestFirstPerson');
        }

        const orbit = +(state.cameraMode === 'orbit');
        const fly = +isFirstPerson;
        const double = +(this._state.touches > 1);
        const pan = this._state.mouse[2] || +(button[2] === -1) || double;

        const orbitFactor = fly ? camera.fov / 120 : 1;

        const { deltas } = this.frame;

        // desktop move
        const v = tmpV1.set(0, 0, 0);
        const keyMove = this._state.axis.clone();
        if (isFps) {
            // In FPS mode, normalize only horizontal axes so jump doesn't reduce speed
            keyMove.y = 0;
        }
        keyMove.normalize();
        const shiftMul = isFps ? 2 : 4;
        const ctrlMul = isFps ? 0.5 : 0.25;
        const speed = this.moveSpeed * (this._state.shift ? shiftMul : this._state.ctrl ? ctrlMul : 1);
        v.add(keyMove.mulScalar(fly * speed * dt));
        if (isFps) {
            // Pass jump signal as raw Y; FPS controller uses move[1] > 0 as boolean trigger
            v.y = this._state.jump > 0 ? 1 : 0;
        }
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
        if (state.touchControlScheme === 'joystick') {
            // Use touch joystick values for fly movement (X = strafe, Y = forward/backward)
            flyMove.set(this._touchJoystick[0], 0, -this._touchJoystick[1]);
            v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        } else {
            // Pan velocity → strafe (X) and vertical (Y, fly only — FPS uses gravity)
            flyTouchPan.set(this._panVelocity[0], isFps ? 0 : -this._panVelocity[1], 0);
            v.add(flyTouchPan.mulScalar(fly * 1.5 * this.moveSpeed * dt));
            // Pinch velocity → forward/backward
            flyMove.set(0, 0, this._pinchVelocity);
            v.add(flyMove.mulScalar(fly * 1.5 * this.moveSpeed * dt));
        }
        pinchMove.set(0, 0, pinch[0]);
        v.add(pinchMove.mulScalar(orbit * double * this.pinchSpeed * dt));
        // Tap-to-jump for mobile FPS mode
        if (isFps && this._tapJump) {
            v.y = 1;
            this._tapJump = false;
        }
        deltas.move.append([v.x, v.y, v.z]);

        // mobile rotate
        v.set(0, 0, 0);
        orbitRotate.set(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - pan) * this.orbitSpeed * dt));
        // In fly mode, use single touch for look-around (inverted direction)
        // Exclude multi-touch (double) to avoid interference with pinch/strafe gestures
        flyRotate.set(touch[0], touch[1], 0);
        v.add(flyRotate.mulScalar(fly * (1 - double) * this.orbitSpeed * orbitFactor * 1.25 * dt));
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
    }
}

export { InputController };
