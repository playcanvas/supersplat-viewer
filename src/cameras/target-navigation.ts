import { math } from 'playcanvas';

const RAD_TO_DEG = 180 / Math.PI;

const shortestAngle = (angle: number) => ((angle % 360) + 540) % 360 - 180;

const smoothstep = (edge0: number, edge1: number, value: number) => {
    const t = math.clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
};

const approach = (value: number, target: number, maxDelta: number) => {
    if (value < target) {
        return Math.min(target, value + maxDelta);
    }

    return Math.max(target, value - maxDelta);
};

const smoothTurnRate = (
    currentRate: number,
    angleDiff: number,
    maxTurnRate: number,
    turnGain: number,
    dt: number
) => {
    if (dt <= 0) {
        return currentRate;
    }

    const desiredRate = math.clamp(angleDiff * turnGain, -maxTurnRate, maxTurnRate);
    const smoothing = 1 - Math.exp(-4 * turnGain * dt);
    return currentRate + (desiredRate - currentRate) * smoothing;
};

const clampTurnStep = (rate: number, remaining: number, dt: number) => {
    const step = rate * dt;
    if (Math.abs(remaining) < 1e-4) {
        return 0;
    }

    return Math.sign(step) === Math.sign(remaining) && Math.abs(step) > Math.abs(remaining) ?
        remaining :
        step;
};

const getYawToTarget = (dx: number, dz: number) => Math.atan2(-dx, -dz) * RAD_TO_DEG;

const getYawDiffToTarget = (dx: number, dz: number, yaw: number) => {
    return shortestAngle(getYawToTarget(dx, dz) - yaw);
};

const getPitchToDirection = (dirY: number) => {
    return Math.asin(math.clamp(dirY, -1, 1)) * RAD_TO_DEG;
};

class ProgressTracker {
    private _blockedTime = 0;

    private _prevDist = Infinity;

    reset() {
        this._blockedTime = 0;
        this._prevDist = Infinity;
    }

    update(distance: number, dt: number, blockedSpeed: number, blockedDuration: number, active = true) {
        if (active && this._prevDist !== Infinity && dt > 0) {
            const speed = (this._prevDist - distance) / dt;
            if (speed < blockedSpeed) {
                this._blockedTime += dt;
                if (this._blockedTime >= blockedDuration) {
                    this._prevDist = distance;
                    return true;
                }
            } else {
                this._blockedTime = 0;
            }
        }

        this._prevDist = distance;
        return false;
    }
}

export {
    ProgressTracker,
    approach,
    clampTurnStep,
    getPitchToDirection,
    getYawDiffToTarget,
    getYawToTarget,
    shortestAngle,
    smoothTurnRate,
    smoothstep
};
