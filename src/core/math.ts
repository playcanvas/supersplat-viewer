import type { Vec3 } from 'playcanvas';

/**
 * Damping function to smooth out transitions.
 *
 * @param damping - Damping factor (0 < damping < 1).
 * @param dt - Delta time in seconds.
 * @returns - Damping factor adjusted for the delta time.
 */
const damp = (damping: number, dt: number) => 1 - Math.pow(damping, dt * 1000);

/**
 * Easing function for smooth transitions.
 *
 * @param x - Input value in the range [0, 1].
 * @returns - Output value in the range [0, 1].
 */
const easeOut = (x: number) => (1 - (2 ** (-10 * x))) / (1 - (2 ** -10));

/**
 * Modulus function that handles negative values correctly.
 *
 * @param n - The number to be modulated.
 * @param m - The modulus value.
 * @returns - The result of n mod m, adjusted to be non-negative.
 */
const mod = (n: number, m: number) => ((n % m) + m) % m;

const nearlyEquals = (a: Float32Array<ArrayBufferLike>, b: Float32Array<ArrayBufferLike>, epsilon = 1e-4) => {
    return !a.some((v, i) => Math.abs(v - b[i]) >= epsilon);
};

const vecToAngles = (result: Vec3, vec: Vec3) => {
    const radToDeg = 180 / Math.PI;
    result.x = Math.asin(vec.y) * radToDeg;
    result.y = Math.atan2(-vec.x, -vec.z) * radToDeg;
    result.z = 0;
    return result;
};

export { damp, easeOut, mod, nearlyEquals, vecToAngles };
