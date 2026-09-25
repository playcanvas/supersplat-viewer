// The resident set: which splats the engine's LOD and streaming have made resident this
// frame, and where each node's data sits. The engine keeps octree LOD, the budget, file
// streaming and the block allocator (one slot range per node); the stochastic renderer
// consumes its decisions and owns everything after them.
//
// Read through the engine's internal (@ignore) gsplat-unified classes until the public
// `world:update` api lands (engine change E3 in the plan). Every internal shape used is
// narrowed here to the members this file reads, so a change in the engine fails in one place.
import { Vec3 } from 'playcanvas';
import type { AppBase, BoundingBox, CameraComponent, EventHandle, Layer, Mat4, Texture } from 'playcanvas';

type EngineFormat = {
    getComputeInputDeclarations(startBinding: number): string;
    getReadCode(): string;
    getComputeBindFormats(): unknown[];
    streams: { name: string }[];
};

type EngineWorkBuffer = {
    format: EngineFormat;
    textureSize: number;
    getTexture(name: string): Texture;
};

type EngineOctreeNode = {
    boundingSphere: { x: number; y: number; z: number; w: number };
};

type EngineSplatInfo = {
    resource: { numSplats: number };
    node: { getWorldTransform(): Mat4 };
    lodIndex: number;
    activeSplats: number;
    aabb: BoundingBox;
    intervals: number[];
    intervalOffsets: number[];
    intervalAllocIds: number[];
    intervalNodeIndices: number[];
    octreeNodes: EngineOctreeNode[] | null;
    allocId: number;
};

type EngineWorldState = {
    version: number;
    splats: EngineSplatInfo[];
    textureSize: number;
    totalActiveSplats: number;
    fullRebuild: boolean;
    needsUploadIds: Set<number>;
};

type EngineRenderer = {
    prepareRenderView: (...args: unknown[]) => boolean;
    meshInstance?: { visible: boolean } | null;
    // the hybrid renderer's gpu pipeline, created lazily by its render prep and its pick prep
    gpuSorter?: { destroy(): void } | null;
    projector?: { destroy(): void } | null;
    intervalCompaction?: { destroy(): void } | null;
};

type EngineManager = {
    world: { currentState: EngineWorldState | undefined; workBuffer: EngineWorkBuffer };
    renderer: EngineRenderer;
};

type EngineDirector = {
    camerasMap: Map<unknown, { layersMap: Map<Layer, { gsplatManager: EngineManager | null }> }>;
};

/** One resident octree node (or a whole single-file resource): a contiguous splat range. */
type ResidentNode = {
    /** Index into {@link ResidentSet.files}. */
    fileIndex: number;
    lodIndex: number;
    /** First splat of the range in the file's own textures. */
    sourceBase: number;
    count: number;
    /** First slot of the range in the engine's work buffer (its block allocator offset). */
    slotBase: number;
    allocId: number;
};

type ResidentFile = {
    fileIndex: number;
    lodIndex: number;
    nodes: ResidentNode[];
    modelMatrix: Mat4;
};

type ResidentSet = {
    /** The engine world-state version this set was built from. */
    version: number;
    activeSplats: number;
    /** Work-buffer capacity in slots: `textureSize²`, the allocator's address space. */
    slotCapacity: number;
    fullRebuild: boolean;
    changedAllocIds: ReadonlySet<number>;
    files: ResidentFile[];
    nodes: ResidentNode[];
    /** World-space bounding sphere per node, 4 floats each (x, y, z, radius). */
    nodeSpheres: Float32Array;
};

type FrameCallback = (set: ResidentSet, changed: boolean, manager: EngineManager) => void;

const tmpVec = new Vec3();
const tmpVec2 = new Vec3();

/**
 * Hooks the engine's per-frame gsplat update for one camera and layer and exposes the resident
 * set. `frame:ready` fires inside `GSplatManager.update()` after `world.bake()` and after the
 * engine's own render prep (both in 2.22.4 and on main), so a listener sees the baked state of
 * the current frame and can replace that prep.
 */
class EngineResidentSetProvider {
    private app: AppBase;

    private camera: CameraComponent;

    private layer: Layer;

    private handles: EventHandle[] = [];

    private callbacks = new Set<FrameCallback>();

    private set: ResidentSet | null = null;

    // the engine renderers this provider has switched off, with their original prep function
    private takenOver = new Map<EngineRenderer, EngineRenderer['prepareRenderView']>();

    // while false the engine keeps rendering the splats itself (XR), and the hook stays quiet
    private active = true;

    constructor(app: AppBase, camera: CameraComponent, layer: Layer) {
        this.app = app;
        this.camera = camera;
        this.layer = layer;

        const system = app.systems.gsplat as unknown as {
            on(name: string, fn: (...args: unknown[]) => void): EventHandle;
        };

        // fires when a manager is created for a camera and layer, before its first update:
        // the earliest point to switch the engine's own renderer off, so it never allocates
        // its projector, sort and draw resources
        this.handles.push(
            system.on('material:created', (material: unknown, cam: unknown, lyr: unknown) => {
                if (cam === this.camera && lyr === this.layer && this.active) {
                    const manager = this.manager();
                    if (manager) this.takeOver(manager);
                }
            })
        );

        this.handles.push(
            system.on('frame:ready', (cam: unknown, lyr: unknown) => {
                if (cam !== this.camera || lyr !== this.layer || !this.active) return;
                const manager = this.manager();
                if (!manager) return;
                this.takeOver(manager);
                const state = manager.world.currentState;
                if (!state) return;
                const changed = !this.set || this.set.version !== state.version;
                if (changed) {
                    this.set = buildResidentSet(state);
                }
                for (const cb of this.callbacks) {
                    cb(this.set!, changed, manager);
                }
            })
        );
    }

    /** The engine manager for this camera and layer, once the engine has created it. */
    manager(): EngineManager | null {
        const director = (this.app.renderer as unknown as { gsplatDirector?: EngineDirector | null }).gsplatDirector;
        // the director keys its cameras by the scene camera, not the component
        const cameraData = director?.camerasMap.get(this.camera.camera);
        return cameraData?.layersMap.get(this.layer)?.gsplatManager ?? null;
    }

    /** Hand the splats back to the engine's renderer (false), or take them over again (true). */
    setActive(value: boolean) {
        if (this.active === value) return;
        this.active = value;
        if (value) {
            const manager = this.manager();
            if (manager) this.takeOver(manager);
        } else {
            this.restore();
        }
    }

    onFrame(cb: FrameCallback): () => void {
        this.callbacks.add(cb);
        return () => this.callbacks.delete(cb);
    }

    /**
     * Switch the engine's own splat rendering off for this manager: its render prep returns
     * false (so the hybrid renderer never builds its projector, sorter or cache) and its mesh
     * instance is hidden. The world (LOD, streaming, allocation, the work-buffer copy) keeps
     * running. Reversed by {@link restore}.
     */
    takeOver(manager: EngineManager) {
        const renderer = manager.renderer;
        if (!this.takenOver.has(renderer)) {
            this.takenOver.set(renderer, renderer.prepareRenderView);
            renderer.prepareRenderView = () => false;
        }
        if (renderer.meshInstance) renderer.meshInstance.visible = false;
        // The manager's first update runs its render prep before frame:ready fires, and
        // material:created fires before the layer data holds the manager, so the engine's
        // projector, sorter and compaction get allocated once (32 bytes a splat and more).
        // Release them; the engine recreates them lazily if it renders again (XR, restore)
        // or picks through its sorted path.
        for (const key of ['gpuSorter', 'projector', 'intervalCompaction'] as const) {
            const resource = renderer[key];
            if (resource) {
                resource.destroy();
                renderer[key] = null;
            }
        }
    }

    restore() {
        for (const [renderer, original] of this.takenOver) {
            renderer.prepareRenderView = original;
            if (renderer.meshInstance) renderer.meshInstance.visible = true;
        }
        this.takenOver.clear();
    }

    destroy() {
        this.restore();
        for (const handle of this.handles) handle.off();
        this.handles.length = 0;
        this.callbacks.clear();
        this.set = null;
    }
}

// Flatten the engine world state into files and nodes with world-space bounds.
const buildResidentSet = (state: EngineWorldState): ResidentSet => {
    const files: ResidentFile[] = [];
    const nodes: ResidentNode[] = [];
    const spheres: number[] = [];

    const pushNode = (node: ResidentNode, cx: number, cy: number, cz: number, radius: number) => {
        nodes.push(node);
        spheres.push(cx, cy, cz, radius);
    };

    state.splats.forEach((info, fileIndex) => {
        const modelMatrix = info.node.getWorldTransform().clone();
        const scale = modelMatrix.getScale(tmpVec2);
        const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
        const file: ResidentFile = { fileIndex, lodIndex: info.lodIndex, nodes: [], modelMatrix };
        const numIntervals = info.intervals.length / 2;

        if (numIntervals === 0) {
            // a single-file resource: one range covering it whole, bounded by its aabb
            const node: ResidentNode = {
                fileIndex,
                lodIndex: info.lodIndex,
                sourceBase: 0,
                count: info.activeSplats,
                slotBase: info.intervalOffsets[0] ?? 0,
                allocId: info.allocId
            };
            modelMatrix.transformPoint(info.aabb.center, tmpVec);
            const he = info.aabb.halfExtents;
            pushNode(node, tmpVec.x, tmpVec.y, tmpVec.z, he.length() * maxScale);
            file.nodes.push(node);
        } else {
            for (let j = 0; j < numIntervals; j++) {
                const start = info.intervals[j * 2];
                const end = info.intervals[j * 2 + 1];
                const nodeIndex = info.intervalNodeIndices[j];
                const node: ResidentNode = {
                    fileIndex,
                    lodIndex: info.lodIndex,
                    sourceBase: start,
                    count: end - start,
                    slotBase: info.intervalOffsets[j] ?? 0,
                    allocId: info.intervalAllocIds[j]
                };
                const sphere = info.octreeNodes?.[nodeIndex]?.boundingSphere;
                if (sphere) {
                    tmpVec.set(sphere.x, sphere.y, sphere.z);
                    modelMatrix.transformPoint(tmpVec, tmpVec);
                    pushNode(node, tmpVec.x, tmpVec.y, tmpVec.z, sphere.w * maxScale);
                } else {
                    // no bounds: never culled
                    pushNode(node, 0, 0, 0, Infinity);
                }
                file.nodes.push(node);
            }
        }
        files.push(file);
    });

    return {
        version: state.version,
        activeSplats: state.totalActiveSplats,
        slotCapacity: state.textureSize * state.textureSize,
        fullRebuild: state.fullRebuild,
        changedAllocIds: state.needsUploadIds,
        files,
        nodes,
        nodeSpheres: new Float32Array(spheres)
    };
};

export { EngineResidentSetProvider };
export type { EngineManager, EngineWorkBuffer, ResidentFile, ResidentNode, ResidentSet };
