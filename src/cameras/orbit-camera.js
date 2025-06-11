import { Vec3 } from 'playcanvas';

import { BaseCamera } from './base-camera.js';
import { mod, MyQuat, SmoothDamp } from '../core/math.js';

/** @import { Pose } from '../core/pose.js' */

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const v = new Vec3();
const q = new MyQuat();

const radToDeg = 180 / Math.PI;

class OrbitCamera extends BaseCamera {
    focus = new Vec3();

    rotation = new Vec3();

    distance = 1;

    smoothDamp = new SmoothDamp([0, 0, 0, 0, 0, 0, 1]);

    moveSpeed = 0.001;

    rotateSpeed = 0.16;

    distanceSpeed = 0.01;

    /**
     * @param {object} input - input data for camera movement
     * @param {number[]} input.move - [x, y, z] movement vector
     * @param {number[]} input.rotate - [yaw, pitch] rotation vector
     * @private
     */
    _move(input) {
        const { focus, rotation, moveSpeed, distanceSpeed, rotateSpeed } = this;
        const { move, rotate } = input;

        q.setFromEulerAngles(rotation);

        // get camera vectors
        q.transformVector(Vec3.FORWARD, forward);
        q.transformVector(Vec3.RIGHT, right);
        q.transformVector(Vec3.UP, up);

        // focus point
        v.copy(right).mulScalar(move[0] * -moveSpeed * this.distance);
        focus.add(v);

        v.copy(up).mulScalar(move[1] * moveSpeed * this.distance);
        focus.add(v);

        // distance
        this.distance = Math.max(0.01, this.distance * (1 + move[2] * distanceSpeed));

        // rotate
        rotation.x = Math.max(-90, Math.min(90, rotation.x - rotate[1] * rotateSpeed));
        rotation.y = mod(rotation.y - rotate[0] * rotateSpeed, 360);
    }

    /**
     * @param {number} dt - delta time in seconds
     * @private
     */
    _smooth(dt) {
        const { focus, rotation, smoothDamp } = this;
        const { value, target } = smoothDamp;

        // package latest target values
        focus.toArray(target, 0);
        rotation.toArray(target, 3);
        target[6] = this.distance;

        // ensure rotations wrap around correctly
        value[3] = target[3] + mod((value[3] - target[3]) + 90, 180) - 90;
        value[4] = target[4] + mod((value[4] - target[4]) + 180, 360) - 180;

        // update
        smoothDamp.update(dt);
    }

    /**
     * @param {Pose} pose - initial camera pose
     * @param {boolean} snap - whether to snap the camera to the initial pose
     * @override
     */
    reset(pose, snap = true) {
        pose.rotation.transformVector(Vec3.FORWARD, v);
        v.normalize();

        this.focus.copy(v).mulScalar(pose.distance).add(pose.position);

        this.rotation.x = Math.asin(v.y) * radToDeg;
        this.rotation.y = mod(Math.atan2(-v.x, -v.z) * radToDeg, 360);
        this.rotation.z = 0;

        this.distance = pose.distance;

        if (snap) {
            this.focus.toArray(this.smoothDamp.value, 0);
            this.rotation.toArray(this.smoothDamp.value, 3);
            this.smoothDamp.value[6] = pose.distance;
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
    getPose(pose) {
        const { smoothDamp } = this;
        const { value } = smoothDamp;

        v.fromArray(value, 3);
        pose.rotation.setFromEulerAngles(v);
        pose.rotation.transformVector(Vec3.FORWARD, v);
        pose.distance = value[6];
        v.mulScalar(-pose.distance);
        pose.position.fromArray(value).add(v);
    }
}

export { OrbitCamera };
