import { math, Vec3 } from 'playcanvas';

import type { Camera, CameraFrame, CameraController } from './camera';
import { applyFrameRotation, dampAlpha, lerpAngles, setBasisOffset, setCameraBasis } from './camera-utils';

const MIN_DISTANCE = 0.01;
const MAX_DISTANCE = Infinity;

const focus = new Vec3();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const pan = new Vec3();

class OrbitController implements CameraController {
    fov = 90;

    rotateDamping = 0.97;

    moveDamping = 0.97;

    zoomDamping = 0.97;

    private _focus = new Vec3();

    private _targetFocus = new Vec3();

    private _angles = new Vec3();

    private _targetAngles = new Vec3();

    private _distance = 1;

    private _targetDistance = 1;

    onEnter(camera: Camera): void {
        this._syncPose(camera, false);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();

        setCameraBasis(this._angles, forward, right, up);

        setBasisOffset(pan, move[0], move[1], 0, forward, right, up);
        this._targetFocus.add(pan);

        this._targetDistance = math.clamp(
            this._targetDistance * (1 + move[2]),
            MIN_DISTANCE,
            MAX_DISTANCE
        );

        applyFrameRotation(this._targetAngles, rotate);

        this._focus.lerp(this._focus, this._targetFocus, dampAlpha(this.moveDamping, deltaTime));
        lerpAngles(this._angles, this._angles, this._targetAngles, dampAlpha(this.rotateDamping, deltaTime));
        this._distance = math.lerp(
            this._distance,
            this._targetDistance,
            dampAlpha(this.zoomDamping, deltaTime)
        );

        setCameraBasis(this._angles, forward, right, up);
        camera.position.copy(this._focus).sub(forward.mulScalar(this._distance));
        camera.angles.copy(this._angles);
        camera.distance = this._distance;
        camera.fov = this.fov;
    }

    onExit(_camera: Camera): void {

    }

    goto(camera: Camera) {
        this._syncPose(camera, true);
    }

    private _syncPose(camera: Camera, copyFov: boolean) {
        camera.calcFocusPoint(focus);

        this._focus.copy(focus);
        this._targetFocus.copy(focus);

        this._angles.copy(camera.angles);
        this._targetAngles.copy(camera.angles);

        this._distance = math.clamp(camera.distance, MIN_DISTANCE, MAX_DISTANCE);
        this._targetDistance = this._distance;

        if (copyFov) {
            this.fov = camera.fov;
        }
    }
}

export { OrbitController };
