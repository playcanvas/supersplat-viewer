import {
    Vec3
} from 'playcanvas';

import { AnimTrack } from '../settings';

/**
 * Creates a figure-8 (lemniscate / infinity sign) camera animation track.
 * The camera traces a horizontal figure-8 centered at its initial position
 * while looking at the target point.
 *
 * @param position - Starting location of the camera.
 * @param target - Target point the camera looks at.
 * @param fov - The camera field of view.
 * @param size - Controls the scale of the figure-8 path. The left-right extent equals `size`
 * and the forward-back extent is half that (`size * 0.5`).
 * @param keys - The number of keyframes in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns The animation track object containing position and target keyframes.
 */
const createFigure8Track = (position: Vec3, target: Vec3, fov: number, size: number = 1, keys: number = 24, duration: number = 20): AnimTrack => {
    const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
    const positions: number[] = [];
    const targets: number[] = [];
    const fovs = new Array(keys).fill(fov);

    const amplitude = size * 0.5;

    const dx = position.x - target.x;
    const dz = position.z - target.z;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);

    // compute local horizontal axes relative to camera-target direction
    let rightX: number, rightZ: number;
    let fwdX: number, fwdZ: number;

    if (horizontalDist > 0.001) {
        fwdX = dx / horizontalDist;
        fwdZ = dz / horizontalDist;
        rightX = -fwdZ;
        rightZ = fwdX;
    } else {
        fwdX = 0;
        fwdZ = 1;
        rightX = 1;
        rightZ = 0;
    }

    for (let i = 0; i < keys; ++i) {
        const t = i / keys * Math.PI * 2;

        // lemniscate offsets: sin(t) for left-right, sin(2t)/2 for forward-back
        const offsetRight = amplitude * Math.sin(t);
        const offsetFwd = amplitude * Math.sin(2 * t) / 2;

        positions.push(position.x + rightX * offsetRight + fwdX * offsetFwd);
        positions.push(position.y);
        positions.push(position.z + rightZ * offsetRight + fwdZ * offsetFwd);

        targets.push(target.x);
        targets.push(target.y);
        targets.push(target.z);
    }

    return {
        name: 'figure8',
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

export { createFigure8Track };
