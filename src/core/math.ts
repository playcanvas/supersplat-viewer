/**
 * Damping function to smooth out transitions.
 *
 * @param damping - Damping factor (0 < damping < 1).
 * @param dt - Delta time in seconds.
 * @returns - Damping factor adjusted for the delta time.
 */
export const damp = (damping: number, dt: number) => 1 - Math.pow(damping, dt * 1000);

/**
 * Easing function for smooth transitions.
 *
 * @param x - Input value in the range [0, 1].
 * @returns - Output value in the range [0, 1].
 */
export const easeOut = (x: number) => (1 - (2 ** (-10 * x))) / (1 - (2 ** -10));

/**
 * Modulus function that handles negative values correctly.
 *
 * @param n - The number to be modulated.
 * @param m - The modulus value.
 * @returns - The result of n mod m, adjusted to be non-negative.
 */
export const mod = (n: number, m: number) => ((n % m) + m) % m;
