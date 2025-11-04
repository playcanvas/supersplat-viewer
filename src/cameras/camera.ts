import type { InputFrame, Pose } from 'playcanvas';

type CameraFrame = InputFrame<{
    move: [number, number, number];
    rotate: [number, number, number];
}>;

type Camera = {
    pose: Pose;
    update(inputFrame: CameraFrame, dt: number): void;
};

export type { CameraFrame, Camera };
