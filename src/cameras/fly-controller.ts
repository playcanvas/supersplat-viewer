import {
    FlyController as FlyControllerPC,
    Pose,
    Vec2
} from 'playcanvas';

import type { PushOut, VoxelCollider } from '../voxel-collider';
import type { CameraFrame, Camera, CameraController } from './camera';

/** Radius of the camera collision sphere (meters) */
const CAMERA_RADIUS = 0.2;

const p = new Pose();

/** Pre-allocated push-out vector for sphere collision */
const pushOut: PushOut = { x: 0, y: 0, z: 0 };

class FlyController implements CameraController {
    controller: FlyControllerPC;

    /** Optional voxel collider for sphere collision with sliding */
    collider: VoxelCollider | null = null;

    constructor() {
        this.controller = new FlyControllerPC();
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
    }

    onEnter(camera: Camera): void {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, false);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const pose = this.controller.update(inputFrame, deltaTime);

        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;

        if (this.collider) {
            // Convert new position to voxel space (negate X and Y for the 180° Z rotation)
            const vx = -pose.position.x;
            const vy = -pose.position.y;
            const vz = pose.position.z;

            if (this.collider.querySphere(vx, vy, vz, CAMERA_RADIUS, pushOut)) {
                // Apply push-out: convert back from voxel space to world space (negate X and Y)
                pose.position.x += -pushOut.x;
                pose.position.y += -pushOut.y;
                pose.position.z += pushOut.z;

                // Also correct the target pose position to prevent drift back into the voxel.
                // Only position is touched -- angles are left intact to preserve rotation momentum.
                const target = (this.controller as any)._targetPose;
                target.position.x += -pushOut.x;
                target.position.y += -pushOut.y;
                target.position.z += pushOut.z;
            }
        }

        camera.position.copy(pose.position);
    }

    onExit(camera: Camera): void {

    }

    goto(pose: Pose) {
        this.controller.attach(pose, true);
    }
}

export { FlyController };
