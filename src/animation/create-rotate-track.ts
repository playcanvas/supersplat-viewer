import {
    Vec3
} from 'playcanvas';

import { AnimTrack } from '../settings';

/**
 * Creates a rotation animation track
 *
 * @param position - Starting location of the camera.
 * @param target - Target point around which to rotate
 * @param fov - The camera field of view.
 * @param keys - The number of keys in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns - The animation track object containing position and target keyframes.
 */
const createRotateTrack = (position: Vec3, target: Vec3, fov: number, keys: number = 12, duration: number = 20): AnimTrack => {
    const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
    const positions: number[] = [];
    const targets: number[] = [];
    const fovs = new Array(keys).fill(fov);

    const dx = position.x - target.x;
    const dy = position.y - target.y;
    const dz = position.z - target.z;

    const horizontalRadius = Math.sqrt(dx * dx + dz * dz);
    const totalDist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // when the offset is nearly vertical, use a fraction of the total distance
    // as the orbit radius so the camera actually moves in a circle
    const minRadius = totalDist * 0.3;
    const radius = Math.max(horizontalRadius, minRadius);

    const startAngle = Math.atan2(dx, dz);

    for (let i = 0; i < keys; ++i) {
        const angle = startAngle - i / keys * Math.PI * 2;

        positions.push(target.x + radius * Math.sin(angle));
        positions.push(target.y + dy);
        positions.push(target.z + radius * Math.cos(angle));

        targets.push(target.x);
        targets.push(target.y);
        targets.push(target.z);
    }

    return {
        name: 'rotate',
        duration,
        frameRate: 1,
        loopMode: 'repeat',
        interpolation: 'spline',
        smoothness: 1,
        keyframes: {
            times,
            values: {
                position: positions,
                target: targets,
                fov: fovs
            }
        }
    };
};

export { createRotateTrack };
