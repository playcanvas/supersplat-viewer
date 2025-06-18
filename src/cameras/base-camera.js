import { Pose } from 'playcanvas';

/** @import { InputFrame } from 'playcanvas' */

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
     * @param {InputFrame<{ move: number[], rotate: number[] }>} frame - The input frame.
     * @param {number} dt - The delta time.
     * @returns {Pose} - The controller pose.
     */
    update(frame, dt) {
        return this._pose;
    }

    detach() {
    }
}

export { BaseCamera };
