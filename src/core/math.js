import { Quat, Vec3 } from 'playcanvas';

const lerp = (a, b, t) => a * (1 - t) + b * t;

const damp = (damping, dt) => 1 - Math.pow(damping, dt * 1000);

// modulo including negative numbers
const mod = (n, m) => ((n % m) + m) % m;

const x = new Vec3();
const y = new Vec3();
const z = new Vec3();

class MyQuat extends Quat {
    dot(other) {
        return this.x * other.x + this.y * other.y + this.z * other.z + this.w * other.w;
    }

    lerp(a, b, t) {
        const omt = (1 - t) * (a.dot(b) < 0 ? -1 : 1);
        this.x = a.x * omt + b.x * t;
        this.y = a.y * omt + b.y * t;
        this.z = a.z * omt + b.z * t;
        this.w = a.w * omt + b.w * t;
        return this.normalize();
    }

    // set a quaternion given an orthonormal basis
    fromBasis(x, y, z) {
        const m00 = x.x;
        const m01 = x.y;
        const m02 = x.z;
        const m10 = y.x;
        const m11 = y.y;
        const m12 = y.z;
        const m20 = z.x;
        const m21 = z.y;
        const m22 = z.z;

        if (m22 < 0) {
            if (m00 > m11) {
                this.set(1 + m00 - m11 - m22, m01 + m10, m20 + m02, m12 - m21);
            } else {
                this.set(m01 + m10, 1 - m00 + m11 - m22, m12 + m21, m20 - m02);
            }
        } else {
            if (m00 < -m11) {
                this.set(m20 + m02, m12 + m21, 1 - m00 - m11 + m22, m01 - m10);
            } else {
                this.set(m12 - m21, m20 - m02, m01 - m10, 1 + m00 + m11 + m22);
            }
        }

        this.mulScalar(1.0 / this.length());

        return this;
    }

    // set this quaternion to the rotation defined by a viewer
    // placed at position looking at target
    fromLookAt(position, target) {
        z.sub2(position, target).normalize();
        if (Math.abs(z.dot(Vec3.UP)) > 0.9999) {
            x.cross(Vec3.RIGHT, z).normalize();
        } else {
            x.cross(Vec3.UP, z).normalize();
        }
        y.cross(z, x);
        return this.fromBasis(x, y, z);
    }

    fromArray(array, offset = 0) {
        this.x = array[offset];
        this.y = array[offset + 1];
        this.z = array[offset + 2];
        return this;
    }

    toArray(array, offset = 0) {
        array[offset] = this.x;
        array[offset + 1] = this.y;
        array[offset + 2] = this.z;
        return array;
    }
}

class SmoothDamp {
    constructor(value, smoothTime = 0.05) {
        this.dims = value.length;
        this.value = value;
        this.target = value.slice();
        this.velocity = value.slice().fill(0);
        this.smoothTime = smoothTime;
    }

    reset(newValue) {
        const { dims, value, velocity } = this;
        for (let i = 0; i < dims; i++) {
            value[i] = newValue[i];
            velocity[i] = 0;
        }
    }

    update(dt) {
        const { dims, value, target, velocity, smoothTime } = this;

        const omega = 2 / smoothTime;
        const x = omega * dt;
        const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

        for (let i = 0; i < dims; i++) {
            const change = value[i] - target[i];
            const temp = (velocity[i] + omega * change) * dt;
            velocity[i] = (velocity[i] - omega * temp) * exp;
            value[i] = target[i] + (change + temp) * exp;
        }
    }
}

export { lerp, damp, mod, MyQuat, SmoothDamp };
