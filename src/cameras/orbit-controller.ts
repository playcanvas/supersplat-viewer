import { math, Vec3 } from 'playcanvas';

import type { Camera, CameraFrame, CameraController } from './camera';
import {
    DEFAULT_CONTROLLER_DAMPING,
    applyFrameRotation,
    dampAngles,
    setBasisOffset,
    setCameraBasis,
    setCameraForward
} from './camera-utils';
import { damp } from '../core/math';

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();

class OrbitController implements CameraController {
    fov = 90;

    rotateDamping = DEFAULT_CONTROLLER_DAMPING;

    moveDamping = DEFAULT_CONTROLLER_DAMPING;

    zoomDamping = DEFAULT_CONTROLLER_DAMPING;

    minZoom = 0.01;

    maxZoom = Infinity;

    /** Smoothed focus point (centre of orbit) and its target. */
    private _focus = new Vec3();

    private _targetFocus = new Vec3();

    /** Smoothed orbit angles and their target. */
    private _angles = new Vec3();

    private _targetAngles = new Vec3();

    /** Smoothed distance from focus point and its target. */
    private _distance = 1;

    private _targetDistance = 1;

    onEnter(camera: Camera): void {
        this._attach(camera);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        // rotate the orbit angles (pitch clamped, roll zeroed)
        applyFrameRotation(this._targetAngles, rotate);

        // pan the focus point in the camera's right/up plane; the device
        // layer emits camera-local move deltas, so rotate them into world
        // space using the current orbit basis.
        setCameraBasis(this._angles, forward, right, up);
        setBasisOffset(offset, move[0], move[1], 0, forward, right, up);
        this._targetFocus.add(offset);

        // zoom: move[2] is a fractional dolly toward / away from the focus
        this._targetDistance = math.clamp(this._targetDistance * (1 + move[2]), this.minZoom, this.maxZoom);

        // smoothing
        this._focus.lerp(this._focus, this._targetFocus, damp(this.moveDamping, deltaTime));
        dampAngles(this._angles, this._targetAngles, this.rotateDamping, deltaTime);
        this._distance = math.lerp(this._distance, this._targetDistance, damp(this.zoomDamping, deltaTime));

        // place the camera behind the focus point along its forward vector
        setCameraForward(this._angles, forward);
        camera.position.sub2(this._focus, offset.copy(forward).mulScalar(this._distance));
        camera.angles.copy(this._angles);
        camera.distance = this._distance;
        camera.fov = this.fov;
    }

    onExit(_camera: Camera): void {

    }

    goto(camera: Camera) {
        this.fov = camera.fov;
        this._attach(camera);
    }

    private _attach(camera: Camera) {
        camera.calcFocusPoint(this._targetFocus);
        this._focus.copy(this._targetFocus);
        this._targetAngles.copy(camera.angles);
        this._angles.copy(camera.angles);
        this._targetDistance = Math.max(camera.distance, this.minZoom);
        this._distance = this._targetDistance;
    }
}

export { OrbitController };
