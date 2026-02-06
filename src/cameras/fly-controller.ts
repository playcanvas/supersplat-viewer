import {
    FlyController as FlyControllerPC,
    Pose,
    Vec2
} from 'playcanvas';

import type { VoxelCollider } from '../voxel-collider';
import type { CameraFrame, Camera, CameraController } from './camera';

/** Half-extent of the camera AABB on each axis (meters) */
const CAMERA_HALF_EXTENT = 0.05;

const p = new Pose();

class FlyController implements CameraController {
    controller: FlyControllerPC;

    /** Optional voxel collider for AABB collision with sliding */
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

            // Build AABB in voxel space
            const minX = vx - CAMERA_HALF_EXTENT;
            const minY = vy - CAMERA_HALF_EXTENT;
            const minZ = vz - CAMERA_HALF_EXTENT;
            const maxX = vx + CAMERA_HALF_EXTENT;
            const maxY = vy + CAMERA_HALF_EXTENT;
            const maxZ = vz + CAMERA_HALF_EXTENT;

            const pushOut = this.collider.queryAABB(
                minX, minY, minZ,
                maxX, maxY, maxZ
            );

            if (pushOut) {
                // Apply push-out: convert back from voxel space to world space (negate X and Y)
                pose.position.x += -pushOut.x;
                pose.position.y += -pushOut.y;
                pose.position.z += pushOut.z;
            }

            camera.position.copy(pose.position);

            // Re-sync the internal controller pose so damping continues from the resolved position
            p.position.copy(pose.position);
            p.angles.copy(pose.angles);
            p.distance = pose.distance;
            this.controller.attach(p, false);
        } else {
            camera.position.copy(pose.position);
        }
    }

    onExit(camera: Camera): void {

    }

    goto(pose: Pose) {
        this.controller.attach(pose, true);
    }
}

export { FlyController };
