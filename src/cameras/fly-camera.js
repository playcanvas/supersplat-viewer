import { FlyController, Mat4, Vec2, Vec3 } from 'playcanvas';

import { damp, MyQuat } from '../core/math.js';

const m = new Mat4();
const move = new Vec3();
const rotate = new Vec2();

class FlyCamera {
    _controller = new FlyController();

    position = new Vec3();

    rotation = new MyQuat();

    distance = 1;

    smoothPosition = new Vec3();

    smoothRotation = new MyQuat();

    moveSpeed = 0.1;

    rotateSpeed = 0.2;

    constructor() {
        this._controller.moveDamping = 0;
        this._controller.rotateDamping = 0;
    }

    reset(pose, snap = true) {
        this.position.copy(pose.position);
        this.rotation.copy(pose.rotation);
        this.distance = pose.distance;
        if (snap) {
            this.smoothPosition.copy(pose.position);
            this.smoothRotation.copy(pose.rotation);
        }

        m.setTRS(this.position, this.rotation, Vec3.ONE);
        this._controller.attach(m);
    }

    update(dt, input) {
        if (input) {
            move.fromArray(input.move.value).mulScalar(this.moveSpeed * 25);
            rotate.fromArray(input.rotate.value).mulScalar(this.rotateSpeed);

            m.copy(this._controller.update({ move, rotate }, dt));
            this.position.set(m.data[12], m.data[13], m.data[14]);
            this.rotation.setFromMat4(m);
        }

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
