import { math, Vec3 } from 'playcanvas';

import { BaseCamera } from './base-camera.js';
import { damp, mod, MyQuat } from '../core/math.js';

/** @import { Pose } from '../core/pose.js' */

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const v = new Vec3();
const q = new MyQuat();

class OrbitCamera extends BaseCamera {
    focus = new Vec3();

    rotation = new Vec3();

    distance = 1;

    smoothFocus = new Vec3();

    smoothRotation = new Vec3();

    smoothDistance = 1;

    /**
     * @param {object} input - input data for camera movement
     * @param {number[]} input.move - [x, y, z] movement vector
     * @param {number[]} input.rotate - [yaw, pitch] rotation vector
     * @private
     */
    _move(input) {
        const { focus, rotation } = this;
        const { move, rotate } = input;

        q.setFromEulerAngles(rotation);

        // get camera vectors
        q.transformVector(Vec3.FORWARD, forward);
        q.transformVector(Vec3.RIGHT, right);
        q.transformVector(Vec3.UP, up);

        // focus point
        v.copy(right).mulScalar(-move[0]);
        focus.add(v);

        v.copy(up).mulScalar(move[1]);
        focus.add(v);

        // distance
        this.distance = Math.max(0.01, this.distance * (1 + move[2]));

        // rotate
        rotation.x = Math.max(-90, Math.min(90, (rotation.x - rotate[1]) % 360));
        rotation.y = (rotation.y - rotate[0]) % 360;

    }

    /**
     * @param {number} dt - delta time in seconds
     * @private
     */
    _smooth(dt) {
        const weight = damp(0.98, dt);
        this.smoothFocus.lerp(this.smoothFocus, this.focus, weight);
        this.smoothRotation.x = math.lerpAngle(this.smoothRotation.x, this.rotation.x, weight) % 360;
        this.smoothRotation.y = math.lerpAngle(this.smoothRotation.y, this.rotation.y, weight) % 360;
        this.smoothRotation.z = math.lerpAngle(this.smoothRotation.z, this.rotation.z, weight) % 360;
        this.smoothDistance = math.lerp(this.smoothDistance, this.distance, weight);
    }

    /**
     * @param {Pose} pose - initial camera pose
     * @param {boolean} snap - whether to snap the camera to the initial pose
     * @override
     */
    attach(pose, snap = true) {
        pose.rotation.transformVector(Vec3.FORWARD, v);
        v.normalize();

        this.focus.copy(v).mulScalar(pose.distance).add(pose.position);

        this.rotation.x = Math.asin(v.y) * math.RAD_TO_DEG;
        this.rotation.y = mod(Math.atan2(-v.x, -v.z) * math.RAD_TO_DEG, 360);
        this.rotation.z = 0;

        this.distance = pose.distance;

        if (snap) {
            this.smoothFocus.copy(this.focus);
            this.smoothRotation.copy(this.rotation);
            this.smoothDistance = this.distance;
        }
    }

    /**
     * @param {number} dt - delta time in seconds
     * @param {object} input - input data for camera movement
     * @param {number[]} input.move - [x, y, z] movement vector
     * @param {number[]} input.rotate - [yaw, pitch, roll] rotation vector
     * @override
     */
    update(dt, input) {
        if (input) {
            this._move(input);
        }
        this._smooth(dt);
    }

    /**
     * @param {Pose} pose - pose to update with the current camera state
     * @override
     */
    detach(pose) {
        pose.rotation.setFromEulerAngles(this.smoothRotation);
        pose.rotation.transformVector(Vec3.FORWARD, v);
        v.normalize();
        pose.position.copy(this.smoothFocus).sub(v.mulScalar(this.smoothDistance));
        pose.distance = this.smoothDistance;
    }
}

export { OrbitCamera };
