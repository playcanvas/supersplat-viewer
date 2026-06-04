import { Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

import type { Collision } from '../collision';
import type { Picker } from './picker';

// A picked surface point + its outward normal, in world space.
type PickTarget = {
    position: Vec3;
    normal: Vec3;
};

const tmpDir = new Vec3();
const scratch: PickTarget = { position: new Vec3(), normal: new Vec3() };

// Cast a ray from the camera through screen offset (offsetX, offsetY) and find
// the first collision-surface hit. Writes the world position + surface normal
// into `out` (caller-owned, so frequent callers like the hover cursor can reuse
// a scratch and avoid per-move allocation). Returns whether anything was hit.
const probeCollision = (
    camera: Entity,
    collision: Collision,
    offsetX: number,
    offsetY: number,
    out: PickTarget
): boolean => {
    const cameraPos = camera.getPosition();
    camera.camera!.screenToWorld(offsetX, offsetY, 1.0, tmpDir);
    tmpDir.sub(cameraPos).normalize();

    const hit = collision.queryRay(
        cameraPos.x, cameraPos.y, cameraPos.z,
        tmpDir.x, tmpDir.y, tmpDir.z,
        camera.camera!.farClip
    );
    if (!hit) {
        return false;
    }

    const sn = collision.querySurfaceNormal(hit.x, hit.y, hit.z, tmpDir.x, tmpDir.y, tmpDir.z);
    out.position.set(hit.x, hit.y, hit.z);
    out.normal.set(sn.nx, sn.ny, sn.nz);
    return true;
};

// Resolve a screen offset to a world target: the collision surface if present,
// otherwise rendered-scene (splat-depth) picking. Allocates a fresh target — for
// the click / tap path, which is rare. Returns null if nothing is under the cursor.
const probeSurface = (
    camera: Entity,
    collision: Collision | null,
    picker: Picker,
    canvas: HTMLCanvasElement,
    offsetX: number,
    offsetY: number
): Promise<PickTarget | null> => {
    if (collision && probeCollision(camera, collision, offsetX, offsetY, scratch)) {
        return Promise.resolve({ position: scratch.position.clone(), normal: scratch.normal.clone() });
    }
    return picker.pickSurface(offsetX / canvas.clientWidth, offsetY / canvas.clientHeight);
};

export { probeCollision, probeSurface };
export type { PickTarget };
