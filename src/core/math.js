/**
 * Damping function to smooth out transitions.
 *
 * @param {number} damping - Damping factor (0 < damping < 1).
 * @param {number} dt - Delta time in seconds.
 * @returns {number} - Damping factor adjusted for the delta time.
 */
export const damp = (damping, dt) => 1 - Math.pow(damping, dt * 1000);

/**
 * Easing function for smooth transitions.
 *
 * @param {number} x - Input value in the range [0, 1].
 * @returns {number} - Output value in the range [0, 1].
 */
export const easeOut = x => (1 - (2 ** (-10 * x))) / (1 - (2 ** -10));

/**
 * Modulus function that handles negative values correctly.
 *
 * @param {number} n - The number to be modulated.
 * @param {number} m - The modulus value.
 * @returns {number} - The result of n mod m, adjusted to be non-negative.
 */
export const mod = (n, m) => ((n % m) + m) % m;
