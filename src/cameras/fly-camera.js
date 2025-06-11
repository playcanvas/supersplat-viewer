import { Vec3 } from 'playcanvas';

import { damp, MyQuat } from '../core/math.js';

const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const v = new Vec3();
const q = new MyQuat();

class FlyCamera {
    position = new Vec3();

    rotation = new MyQuat();

    distance = 1;

    smoothPosition = new Vec3();

    smoothRotation = new MyQuat();

    moveSpeed = 0.1;

    rotateSpeed = 0.2;

    reset(pose, snap = true) {
        this.position.copy(pose.position);
        this.rotation.copy(pose.rotation);
        this.distance = pose.distance;
        if (snap) {
            this.smoothPosition.copy(pose.position);
            this.smoothRotation.copy(pose.rotation);
        }
    }

    update(dt, input) {
        if (input) {
            this.move(input);
        }
        this.smooth(dt);
    }

    move(input) {
        const { position, rotation, moveSpeed, rotateSpeed } = this;
        const { move, rotate } = input;

        // get camera vectors
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        rotation.transformVector(Vec3.UP, up);

        // move
        v.copy(right).mulScalar(move[0] * moveSpeed);
        position.add(v);

        v.copy(up).mulScalar(move[2] * -moveSpeed);
        position.add(v);

        v.copy(forward).mulScalar(move[1] * -moveSpeed);
        position.add(v);

        // rotate
        q.setFromAxisAngle(right, -rotate[1] * rotateSpeed);
        rotation.mul2(q, rotation);

        q.setFromAxisAngle(Vec3.UP, -rotate[0] * rotateSpeed);
        rotation.mul2(q, rotation);

        q.setFromAxisAngle(forward, -rotate[2] * rotateSpeed);
        rotation.mul2(q, rotation);

        rotation.normalize();
    }

    smooth(dt) {
        const weight = damp(0.98, dt);
        this.smoothPosition.lerp(this.smoothPosition, this.position, weight);
        this.smoothRotation.lerp(this.smoothRotation, this.rotation, weight);
    }

    getPose(pose) {
        const { smoothPosition, smoothRotation, distance } = this;
        pose.position.copy(smoothPosition);
        pose.rotation.copy(smoothRotation);
        pose.distance = distance;
    }
}

export { FlyCamera };
