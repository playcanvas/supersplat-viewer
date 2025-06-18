import { Pose } from '../core/pose.js';

class BaseCamera {
    /**
     * @type {Pose}
     * @protected
     */
    _pose = new Pose();

    /**
     * @param {Pose} pose - initial camera pose
     * @param {boolean} snap - whether to snap the camera to the initial pose
     */
    attach(pose, snap = true) {
    }

    /**
     * @param {number} dt - delta time in seconds
     * @param {object} input - input data for camera movement
     * @param {number[]} input.move - [x, y, z] movement vector
     * @param {number[]} input.rotate - [yaw, pitch, roll] rotation vector
     * @returns {Pose} - updated camera pose
     */
    update(dt, input) {
        return this._pose;
    }

    detach() {
    }
}

export { BaseCamera };
