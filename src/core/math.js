import { Quat, Vec3 } from 'playcanvas';

const lerp = (a, b, t) => a * (1 - t) + b * t;

const damp = (damping, dt) => 1 - Math.pow(damping, dt * 1000);

// modulo including negative numbers
const mod = (n, m) => ((n % m) + m) % m;

const x = new Vec3();
const y = new Vec3();
const z = new Vec3();

class MyQuat extends Quat {
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
}

export { lerp, damp, mod, MyQuat };
