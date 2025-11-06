import {
    Mat4,
    Vec3
} from 'playcanvas';

import { AnimTrack } from '../settings';

/**
 * Creates a rotation animation track
 *
 * @param position - Starting location of the camera.
 * @param target - Target point around which to rotate
 * @param keys - The number of keys in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns - The animation track object containing position and target keyframes.
 */
const createRotateTrack = (position: Vec3, target: Vec3, keys: number = 12, duration: number = 20): AnimTrack => {
    const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
    const positions: number[] = [];
    const targets: number[] = [];

    const mat = new Mat4();
    const vec = new Vec3();
    const dif = new Vec3(
        position.x - target.x,
        position.y - target.y,
        position.z - target.z
    );

    for (let i = 0; i < keys; ++i) {
        mat.setFromEulerAngles(0, -i / keys * 360, 0);
        mat.transformPoint(dif, vec);

        positions.push(target.x + vec.x);
        positions.push(target.y + vec.y);
        positions.push(target.z + vec.z);

        targets.push(target.x);
        targets.push(target.y);
        targets.push(target.z);
    }

    return {
        name: 'rotate',
        duration,
        frameRate: 1,
        target: 'camera',
        loopMode: 'repeat',
        interpolation: 'spline',
        smoothness: 1,
        keyframes: {
            times,
            values: {
                position: positions,
                target: targets
            }
        }
    };
};

export { createRotateTrack };
