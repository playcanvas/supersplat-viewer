import { math, Quat, Vec3 } from 'playcanvas';

import { damp } from '../core/math';

const rotation = new Quat();

/**
 * Apply a CameraFrame rotate delta to camera Euler angles.
 *
 * CameraFrame rotate uses [yaw, pitch, roll]-style input deltas, while camera
 * angles are stored as [pitch, yaw, roll].
 *
 * @param angles - Camera Euler angles to mutate.
 * @param rotate - Frame rotate delta.
 * @param minPitch - Minimum pitch angle in degrees.
 * @param maxPitch - Maximum pitch angle in degrees.
 * @returns The mutated angles.
 */
const applyFrameRotation = (
    angles: Vec3,
    rotate: readonly number[],
    minPitch = -90,
    maxPitch = 90
) => {
    angles.x -= rotate[1];
    angles.y -= rotate[0];
    angles.z = 0;
    angles.x = math.clamp(angles.x, minPitch, maxPitch);
    return angles;
};

/**
 * Calculate camera-relative basis vectors from Euler angles.
 *
 * @param angles - Camera Euler angles in degrees.
 * @param forward - Receives the forward vector.
 * @param right - Receives the right vector.
 * @param up - Receives the up vector.
 */
const setCameraBasis = (angles: Vec3, forward: Vec3, right: Vec3, up: Vec3) => {
    rotation.setFromEulerAngles(angles);
    rotation.transformVector(Vec3.FORWARD, forward);
    rotation.transformVector(Vec3.RIGHT, right);
    rotation.transformVector(Vec3.UP, up);
};

/**
 * Calculate a camera forward vector from Euler angles.
 *
 * @param angles - Camera Euler angles in degrees.
 * @param forward - Receives the forward vector.
 */
const setCameraForward = (angles: Vec3, forward: Vec3) => {
    rotation.setFromEulerAngles(angles);
    rotation.transformVector(Vec3.FORWARD, forward);
};

/**
 * Calculate yaw-only movement basis vectors.
 *
 * @param yaw - Camera yaw angle in degrees.
 * @param forward - Receives the horizontal forward vector.
 * @param right - Receives the horizontal right vector.
 */
const setYawBasis = (yaw: number, forward: Vec3, right: Vec3) => {
    rotation.setFromEulerAngles(0, yaw, 0);
    rotation.transformVector(Vec3.FORWARD, forward);
    rotation.transformVector(Vec3.RIGHT, right);
};

/**
 * Build a world-space offset from local movement along camera basis vectors.
 *
 * @param out - Receives the world-space offset.
 * @param x - Local right movement.
 * @param y - Local up movement.
 * @param z - Local forward movement.
 * @param forward - Forward basis vector.
 * @param right - Right basis vector.
 * @param up - Up basis vector.
 * @returns The mutated output vector.
 */
const setBasisOffset = (
    out: Vec3,
    x: number,
    y: number,
    z: number,
    forward: Vec3,
    right: Vec3,
    up: Vec3
) => {
    out.set(
        right.x * x + up.x * y + forward.x * z,
        right.y * x + up.y * y + forward.y * z,
        right.z * x + up.z * y + forward.z * z
    );
    return out;
};

/**
 * Interpolate Euler angles using shortest-path angle interpolation.
 *
 * @param result - Receives the interpolated angles.
 * @param a - Start angles.
 * @param b - End angles.
 * @param t - Interpolation factor.
 * @returns The mutated result.
 */
const lerpAngles = (result: Vec3, a: Vec3, b: Vec3, t: number) => {
    result.x = math.lerpAngle(a.x, b.x, t) % 360;
    result.y = math.lerpAngle(a.y, b.y, t) % 360;
    result.z = math.lerpAngle(a.z, b.z, t) % 360;
    return result;
};

/**
 * Convert a damping value to a frame-rate-independent interpolation alpha.
 *
 * @param damping - Damping factor.
 * @param dt - Delta time in seconds.
 * @returns Interpolation alpha for this frame.
 */
const dampAlpha = (damping: number, dt: number) => {
    return dt > 0 ? damp(damping, dt) : 0;
};

export {
    applyFrameRotation,
    dampAlpha,
    lerpAngles,
    setBasisOffset,
    setCameraBasis,
    setCameraForward,
    setYawBasis
};
