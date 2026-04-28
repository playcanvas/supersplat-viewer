import { math, MultiTouchSource, Vec3 } from 'playcanvas';

import type { Global } from '../../types';
import {
    DISPLACEMENT_SCALE,
    TAP_EPSILON,
    screenToWorld
} from '../shared';
import type { CameraInputFrame, InputDevice, UpdateContext } from '../shared';

const tmpV = new Vec3();
const orbitMove = new Vec3();
const flyMoveTmp = new Vec3();
const flyTouchPan = new Vec3();
const pinchMoveTmp = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();

class TouchDevice implements InputDevice {
    orbitSpeed: number = 18;

    moveSpeed: number = 4;

    pinchSpeed: number = 0.4;

    touchRotateSensitivity: number = 1.5;

    touchPinchMoveSensitivity: number = 1.5;

    pinchVelocitySensitivity: number = 0.006;

    panVelocitySensitivity: number = 0.005;

    private _source = new MultiTouchSource();

    private _global: Global | null = null;

    /** Touches currently active (running count from .read() deltas). */
    private _touchCount = 0;

    /** UI joystick value [x, y], -1..1. */
    private _joystick: [number, number] = [0, 0];

    /** Smoothed forward/back velocity from pinch gesture (-1..1). */
    private _pinchVelocity = 0;

    /** Smoothed strafe/vertical velocity from two-finger pan, -1..1 each. */
    private _panVelocity: [number, number] = [0, 0];

    /** Tap-detection state — touch count and accumulated finger movement. */
    private _tapTouches = 0;

    private _tapDelta = 0;

    /** True for one frame after a tap is detected during gaming controls. */
    private _tapJump = false;

    get touchCount(): number {
        return this._touchCount;
    }

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._source.attach(canvas);
        global.events.on('joystickInput', (value: { x: number; y: number }) => {
            this._joystick[0] = value.x;
            this._joystick[1] = value.y;
        });
    }

    detach(): void {
        // MultiTouchSource doesn't expose a detach.
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { touch, pinch, count } = this._source.read();
        const { isWalk, isFirstPerson, isOrbit, gamingControls, dt, distance, cameraComponent } = ctx;

        // running touch count
        this._touchCount += count[0];

        // tap detection (walk mode only)
        if (isWalk) {
            const prevTaps = this._tapTouches;
            this._tapTouches = Math.max(0, this._tapTouches + count[0]);

            if (prevTaps === 0 && this._tapTouches > 0) {
                this._tapDelta = 0;
            }

            if (this._tapTouches > 0) {
                const prevDelta = this._tapDelta;
                this._tapDelta += Math.abs(touch[0]) + Math.abs(touch[1]);
                if (prevDelta < TAP_EPSILON && this._tapDelta >= TAP_EPSILON) {
                    if (!gamingControls) {
                        this._global!.events.fire('walkCancel');
                    }
                }
            }

            if (prevTaps > 0 && this._tapTouches === 0) {
                if (this._tapDelta < TAP_EPSILON) {
                    if (!gamingControls) {
                        // Walk-interaction listens for this and fires walkTo
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    } else {
                        this._tapJump = true;
                    }
                }
            }
        } else {
            this._tapTouches = 0;
        }

        // smoothed velocities for fly/walk first-person motion (non-gaming)
        if (isFirstPerson && !gamingControls && this._touchCount > 1) {
            // pinch[0] = oldDist - newDist: negative when spreading,
            // positive when closing. Spreading = forward → subtract.
            this._pinchVelocity -= pinch[0] * this.pinchVelocitySensitivity;
            this._pinchVelocity = math.clamp(this._pinchVelocity, -1.0, 1.0);
            this._panVelocity[0] += touch[0] * this.panVelocitySensitivity;
            this._panVelocity[0] = math.clamp(this._panVelocity[0], -1.0, 1.0);
            this._panVelocity[1] += touch[1] * this.panVelocitySensitivity;
            this._panVelocity[1] = math.clamp(this._panVelocity[1], -1.0, 1.0);
        } else if (isFirstPerson && this._touchCount <= 1) {
            this._pinchVelocity = 0;
            this._panVelocity[0] = 0;
            this._panVelocity[1] = 0;
        }

        const orbit = isOrbit ? 1 : 0;
        const fly = isFirstPerson ? 1 : 0;
        const double = this._touchCount > 1 ? 1 : 0;
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const dragInvert = (isFirstPerson && !gamingControls) ? -1 : 1;

        const { deltas } = frame;

        // move
        const v = tmpV.set(0, 0, 0);
        // two-finger orbit-pan when in orbit mode (single touch is rotate, double is pan)
        orbitMove.copy(screenToWorld(cameraComponent, touch[0], touch[1], distance));
        v.add(orbitMove.mulScalar(orbit * double));
        if (gamingControls) {
            // joystick UI drives strafe + forward/back in fly/walk
            flyMoveTmp.set(this._joystick[0], 0, -this._joystick[1]);
            v.add(flyMoveTmp.mulScalar(fly * this.moveSpeed * dt));
        } else {
            // smoothed pan velocity → strafe (X) and vertical (Y, fly only)
            flyTouchPan.set(this._panVelocity[0], isWalk ? 0 : -this._panVelocity[1], 0);
            v.add(flyTouchPan.mulScalar(fly * this.touchPinchMoveSensitivity * this.moveSpeed * dt));
            // smoothed pinch velocity → forward/back
            flyMoveTmp.set(0, 0, this._pinchVelocity);
            v.add(flyMoveTmp.mulScalar(fly * this.touchPinchMoveSensitivity * this.moveSpeed * dt));
        }
        // raw pinch for orbit-mode zoom
        pinchMoveTmp.set(0, 0, pinch[0]);
        v.add(pinchMoveTmp.mulScalar(orbit * double * this.pinchSpeed * DISPLACEMENT_SCALE));
        // tap-to-jump in walk + gaming controls
        if (isWalk && this._tapJump) {
            v.y = 1;
            this._tapJump = false;
        }
        deltas.move.append([v.x, v.y, v.z]);

        // rotate
        v.set(0, 0, 0);
        // single-touch orbit rotate (masked when there are 2+ touches)
        orbitRotate.set(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - double) * this.orbitSpeed * this.touchRotateSensitivity * DISPLACEMENT_SCALE));
        // single-touch fly look (inverted in non-gaming first-person)
        flyRotate.set(touch[0] * dragInvert, touch[1] * dragInvert, 0);
        v.add(flyRotate.mulScalar(fly * (1 - double) * this.orbitSpeed * orbitFactor * this.touchRotateSensitivity * DISPLACEMENT_SCALE));
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

export { TouchDevice };
