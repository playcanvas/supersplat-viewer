import { Vec3 } from 'playcanvas';

import { BaseCamera } from './base-camera.js';
import { damp, MyQuat } from '../core/math.js';

/** @import { Pose } from '../core/pose.js' */

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const v = new Vec3();
const q = new MyQuat();

class FlyCamera extends BaseCamera {
    position = new Vec3();

    rotation = new MyQuat();

    distance = 1;

    smoothPosition = new Vec3();

    smoothRotation = new MyQuat();

    /**
     * @param {object} input - input data for camera movement
     * @param {number[]} input.move - [x, y, z] movement vector
     * @param {number[]} input.rotate - [yaw, pitch, roll] rotation vector
     * @private
     */
    _move(input) {
        const { position, rotation } = this;
        const { move, rotate } = input;

        // get camera vectors
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        rotation.transformVector(Vec3.UP, up);

        // move
        v.copy(right).mulScalar(move[0]);
        position.add(v);

        v.copy(up).mulScalar(move[1]);
        position.add(v);

        v.copy(forward).mulScalar(move[2]);
        position.add(v);

        // rotate
        q.setFromAxisAngle(right, -rotate[1]);
        rotation.mul2(q, rotation);

        q.setFromAxisAngle(Vec3.UP, -rotate[0]);
        rotation.mul2(q, rotation);

        q.setFromAxisAngle(forward, -rotate[2]);
        rotation.mul2(q, rotation);

        rotation.normalize();
    }

    /**
     * @param {number} dt - delta time in seconds
     * @private
     */
    _smooth(dt) {
        const weight = damp(0.98, dt);
        this.smoothPosition.lerp(this.smoothPosition, this.position, weight);
        this.smoothRotation.lerp(this.smoothRotation, this.rotation, weight);
    }

    /**
     * @param {Pose} pose - initial camera pose
     * @param {boolean} snap - whether to snap the camera to the initial pose
     * @override
     */
    attach(pose, snap = true) {
        this.position.copy(pose.position);
        this.rotation.copy(pose.rotation);
        this.distance = pose.distance;
        if (snap) {
            this.smoothPosition.copy(pose.position);
            this.smoothRotation.copy(pose.rotation);
        }
    }

    /**
     * @param {number} dt - delta time in seconds
     * @param {object} input - input data for camera movement
     * @param {number[]} input.move - [x, y, z] movement vector
     * @param {number[]} input.rotate - [yaw, pitch, roll] rotation vector
     * @returns {Pose} - updated camera pose
     * @override
     */
    update(dt, input) {
        if (input) {
            this._move(input);
        }
        this._smooth(dt);

        // update pose
        this._pose.position.copy(this.smoothPosition);
        this._pose.rotation.copy(this.smoothRotation);
        this._pose.distance = this.distance;
        return this._pose;
    }

    /**
     * @override
     */
    detach() {
        this.smoothPosition.copy(this.position);
        this.smoothRotation.copy(this.rotation);
    }
}

export { FlyCamera };
