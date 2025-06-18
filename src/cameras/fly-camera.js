import { math, InputController, Quat, Vec3 } from 'playcanvas';

import { damp } from '../core/math.js';

/** @import { InputFrame, Pose } from 'playcanvas' */

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const v = new Vec3();
const q = new Quat();

class FlyCamera extends InputController {
    position = new Vec3();

    rotation = new Vec3();

    distance = 1;

    smoothPosition = new Vec3();

    smoothRotation = new Vec3();

    /**
     * @param {Pose} pose - initial camera pose
     * @param {boolean} [smooth] - whether to smooth the camera movement
     * @override
     */
    attach(pose, smooth = true) {
        this.position.copy(pose.position);
        this.rotation.copy(pose.angles);
        this.distance = pose.distance;
        if (!smooth) {
            this.smoothPosition.copy(pose.position);
            this.smoothRotation.copy(pose.angles);
        }
    }

    /**
     * @param {InputFrame<{ move: number[], rotate: number[] }>} frame - The input frame.
     * @param {number} dt - The delta time.
     * @returns {Pose} - The controller pose.
     */
    update(frame, dt) {
        const { move, rotate } = frame.read();

        // move
        const { position, rotation } = this;

        q.setFromEulerAngles(rotation);

        // get camera vectors
        q.transformVector(Vec3.FORWARD, forward);
        q.transformVector(Vec3.RIGHT, right);
        q.transformVector(Vec3.UP, up);

        // move
        v.copy(right).mulScalar(move[0]);
        position.add(v);

        v.copy(up).mulScalar(move[1]);
        position.add(v);

        v.copy(forward).mulScalar(move[2]);
        position.add(v);

        // rotate
        rotation.x = (rotation.x - rotate[1]) % 360;
        rotation.y = (rotation.y - rotate[0]) % 360;

        // smooth
        const weight = damp(0.98, dt);
        this.smoothPosition.lerp(this.smoothPosition, this.position, weight);
        this.smoothRotation.x = math.lerpAngle(this.smoothRotation.x, this.rotation.x, weight) % 360;
        this.smoothRotation.y = math.lerpAngle(this.smoothRotation.y, this.rotation.y, weight) % 360;
        this.smoothRotation.z = math.lerpAngle(this.smoothRotation.z, this.rotation.z, weight) % 360;

        // update pose
        this._pose.position.copy(this.smoothPosition);
        this._pose.angles.copy(this.smoothRotation);
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
