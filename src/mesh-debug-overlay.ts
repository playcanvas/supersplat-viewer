import {
    type AppBase,
    BLEND_NONE,
    Color,
    CULLFACE_NONE,
    Entity,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    RENDERSTYLE_WIREFRAME,
    StandardMaterial
} from 'playcanvas';

import type { MeshCollision } from './collision';

class MeshDebugOverlay {
    private entity: Entity;

    private _enabled = false;

    constructor(app: AppBase, collision: MeshCollision) {
        const { positions, indices } = collision;

        // Build a triangle mesh and let the engine generate a line index buffer
        // for it. RENDERSTYLE_WIREFRAME selects that secondary index buffer.
        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setIndices(indices instanceof Uint32Array ? indices : new Uint32Array(indices));
        mesh.update(PRIMITIVE_TRIANGLES);
        mesh.generateWireframe();

        const material = new StandardMaterial();
        material.useLighting = false;
        material.diffuse = new Color(0, 0, 0);
        material.emissive = new Color(0, 0, 0);
        material.blendType = BLEND_NONE;
        material.depthTest = true;
        material.depthWrite = true;
        material.cull = CULLFACE_NONE;
        material.update();

        const meshInstance = new MeshInstance(mesh, material);

        this.entity = new Entity('MeshCollisionDebug');
        this.entity.addComponent('render', { meshInstances: [meshInstance] });
        // The render component overwrites each meshInstance.renderStyle with
        // its own value, so set it on the component after the component exists.
        this.entity.render.renderStyle = RENDERSTYLE_WIREFRAME;
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
