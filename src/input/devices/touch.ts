import { MultiTouchSource, Vec3 } from 'playcanvas';

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
const pinchMoveTmp = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();

class TouchDevice implements InputDevice {
    orbitSpeed: number = 18;

    moveSpeed: number = 4;

    pinchSpeed: number = 0.4;

    touchRotateSensitivity: number = 1.5;

    private _source = new MultiTouchSource();

    private _global: Global | null = null;

    /** Touches currently active (running count from .read() deltas). */
    private _touchCount = 0;

    /** UI joystick value [x, y], -1..1. */
    private _joystick: [number, number] = [0, 0];

    /** Tap-detection state — touch count, max touches, and accumulated movement. */
    private _tapTouches = 0;

    private _tapMaxTouches = 0;

    private _tapDelta = 0;

    /** True for one frame after a tap is detected during gaming controls. */
    private _tapJump = false;

    private _onJoystickInput = (value: { x: number; y: number }) => {
        this._joystick[0] = value.x;
        this._joystick[1] = value.y;
    };

    get touchCount(): number {
        return this._touchCount;
    }

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._source.attach(canvas);
        global.events.on('joystickInput', this._onJoystickInput);
    }

    detach(): void {
        // MultiTouchSource doesn't expose a detach.
        if (this._global) {
            this._global.events.off('joystickInput', this._onJoystickInput);
            this._global = null;
        }
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { touch, pinch, count } = this._source.read();
        const { isFly, isWalk, isFirstPerson, isOrbit, gamingControls, dt, distance, cameraComponent } = ctx;

        // running touch count
        this._touchCount += count[0];

        if (isFly && gamingControls && (this._joystick[0] !== 0 || this._joystick[1] !== 0)) {
            this._global!.events.fire('navigateCancel');
        }

        // tap detection for click/tap target and focus modes
        if (isWalk || isFly || isOrbit) {
            const prevTaps = this._tapTouches;
            this._tapTouches = Math.max(0, this._tapTouches + count[0]);

            if (prevTaps === 0 && this._tapTouches > 0) {
                this._tapDelta = 0;
            }
            if (this._tapTouches > 0) {
                this._tapMaxTouches = Math.max(this._tapMaxTouches, this._tapTouches);
            }

            if (this._tapTouches > 0) {
                const prevDelta = this._tapDelta;
                this._tapDelta += Math.abs(touch[0]) + Math.abs(touch[1]) + Math.abs(pinch[0]);
                if (prevDelta < TAP_EPSILON && this._tapDelta >= TAP_EPSILON) {
                    if ((isWalk && !gamingControls) || isFly) {
                        this._global!.events.fire('navigateCancel');
                    }
                }
            }

            if (prevTaps > 0 && this._tapTouches === 0) {
                if (this._tapDelta < TAP_EPSILON && this._tapMaxTouches === 1) {
                    if (isWalk && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    } else if (isWalk) {
                        this._tapJump = true;
                    } else if (isFly && !gamingControls) {
                        // Walk-interaction listens for this and fires navigateTo
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    } else if (isOrbit) {
                        // Walk-interaction listens for this and sets orbit focus
                        // after picking.
                        this._global!.events.fire('mobileTap');
                    }
                }
                this._tapMaxTouches = 0;
            }
        } else {
            this._tapTouches = 0;
            this._tapMaxTouches = 0;
        }

        const orbit = isOrbit ? 1 : 0;
        const fly = isFirstPerson ? 1 : 0;
        const double = this._touchCount > 1 ? 1 : 0;
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const dragInvert = (isFirstPerson && !gamingControls) ? -1 : 1;
        // First-person modes (fly and walk) opt into the direct two-finger
        // model only outside gaming controls (gaming uses the joystick).
        const directFirstPerson = fly * (gamingControls ? 0 : 1);

        const { deltas } = frame;

        // move
        const v = tmpV.set(0, 0, 0);
        // Two-finger pan: orbit pans the target; fly strafes/rises in the
        // camera basis; walk strafes along the ground plane. Identical 1:1
        // screen-space mapping in every mode so dragging feels the same —
        // what your fingers move, the camera moves. Walk zeros y because
        // WalkController treats any nonzero move[1] as a jump trigger.
        screenToWorld(cameraComponent, touch[0], touch[1], distance, orbitMove);
        if (isWalk) {
            orbitMove.y = 0;
        }
        v.add(orbitMove.mulScalar((orbit + directFirstPerson) * double));
        if (gamingControls) {
            // joystick UI drives strafe + forward/back in fly/walk
            flyMoveTmp.set(this._joystick[0], 0, -this._joystick[1]);
            v.add(flyMoveTmp.mulScalar(fly * this.moveSpeed * dt));
        }
        // Two-finger pinch z: orbit interprets +z as "farther from target"
        // (close-pinch = +pinch[0] = zoom out). First-person modes interpret
        // +z as "forward", so spreading (pinch[0] < 0) should move forward —
        // flip the sign there.
        pinchMoveTmp.set(0, 0, (orbit - directFirstPerson) * pinch[0]);
        v.add(pinchMoveTmp.mulScalar(double * this.pinchSpeed * DISPLACEMENT_SCALE));
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
