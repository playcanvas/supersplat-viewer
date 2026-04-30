import {
    type AppBase,
    BLEND_NORMAL,
    Color,
    CULLFACE_NONE,
    Entity,
    Mesh,
    MeshInstance,
    PRIMITIVE_LINES,
    StandardMaterial
} from 'playcanvas';

import type { MeshCollision } from './collision';

class MeshDebugOverlay {
    private entity: Entity;

    private _enabled = false;

    constructor(app: AppBase, collision: MeshCollision) {
        const { positions, indices } = collision;
        const numTris = Math.floor(indices.length / 3);

        // Each triangle becomes 3 line segments (6 indices).
        const lineIndices = new Uint32Array(numTris * 6);
        for (let i = 0; i < numTris; i++) {
            const i0 = indices[i * 3];
            const i1 = indices[i * 3 + 1];
            const i2 = indices[i * 3 + 2];
            const o = i * 6;
            lineIndices[o]     = i0; lineIndices[o + 1] = i1;
            lineIndices[o + 2] = i1; lineIndices[o + 3] = i2;
            lineIndices[o + 4] = i2; lineIndices[o + 5] = i0;
        }

        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setIndices(lineIndices);
        mesh.update(PRIMITIVE_LINES);

        const material = new StandardMaterial();
        material.useLighting = false;
        material.diffuse = new Color(0, 0, 0);
        material.emissive = new Color(1.0, 0.25, 0.2);
        material.opacity = 0.85;
        material.blendType = BLEND_NORMAL;
        material.depthTest = false;
        material.depthWrite = false;
        material.cull = CULLFACE_NONE;
        material.update();

        const meshInstance = new MeshInstance(mesh, material);
        meshInstance.cull = false;

        this.entity = new Entity('MeshCollisionDebug');
        this.entity.addComponent('render', { meshInstances: [meshInstance] });
        this.entity.enabled = false;
        app.root.addChild(this.entity);
    }

    set enabled(value: boolean) {
        this._enabled = value;
        this.entity.enabled = value;
    }

    get enabled(): boolean {
        return this._enabled;
    }

    destroy(): void {
        this.entity?.destroy();
    }
}

export { MeshDebugOverlay };
