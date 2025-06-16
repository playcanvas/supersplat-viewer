import { math, Vec3 } from 'playcanvas';

import { MyQuat } from './math.js';

const v = new Vec3();

// stores a camera pose
class Pose {
    constructor(other) {
        this.position = new Vec3();
        this.rotation = new MyQuat();
        this.distance = 1;
        if (other) {
            this.copy(other);
        }
    }

    copy(pose) {
        this.position.copy(pose.position);
        this.rotation.copy(pose.rotation);
        this.distance = pose.distance;
        return this;
    }

    lerp(a, b, t) {
        this.position.lerp(a.position, b.position, t);
        this.rotation.lerp(a.rotation, b.rotation, t);
        this.distance = math.lerp(a.distance, b.distance, t);
        return this;
    }

    fromLookAt(position, target) {
        this.position.copy(position);
        this.rotation.fromLookAt(position, target);
        this.distance = position.distance(target);
        return this;
    }

    calcTarget(target) {
        this.rotation.transformVector(Vec3.FORWARD, v);
        target.copy(v).mulScalar(this.distance).add(this.position);
    }
}

export { Pose };
