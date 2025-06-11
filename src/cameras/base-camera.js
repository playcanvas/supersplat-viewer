/** @import { Pose } from '../core/pose.js' */

class BaseCamera {
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
     */
    update(dt, input) {
    }

    /**
     * @param {Pose} pose - pose to update with the current camera state
     */
    detach(pose) {
    }
}

export { BaseCamera };
