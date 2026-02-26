import {
    type AppBase,
    type CameraComponent,
    type Entity,
    type GSplatComponent,
    Color,
    CUBEFACE_POSX,
    CUBEFACE_NEGX,
    CUBEFACE_POSY,
    CUBEFACE_NEGY,
    CUBEFACE_POSZ,
    CUBEFACE_NEGZ,
    LAYERID_WORLD,
    Mat4,
    PIXELFORMAT_RGBA8,
    Quat,
    RenderPassForward,
    RenderPassShaderQuad,
    RenderTarget,
    ShaderUtils,
    Texture,
    TEXTURELOCK_WRITE,
    Vec3
} from 'playcanvas';

const CUBEMAP_SIZE = 512;
const MOVE_THRESHOLD = 0.05;

const FACE_EULER_ANGLES: [number, number, number][] = [
    [0, 90, 0],      // CUBEFACE_POSX: look +X
    [0, -90, 0],     // CUBEFACE_NEGX: look -X
    [-90, 0, 180],   // CUBEFACE_POSY: look +Y
    [90, 0, 180],    // CUBEFACE_NEGY: look -Y
    [0, 180, 0],     // CUBEFACE_POSZ: look +Z
    [0, 0, 0]        // CUBEFACE_NEGZ: look -Z
];

const FACE_INDICES = [
    CUBEFACE_POSX, CUBEFACE_NEGX,
    CUBEFACE_POSY, CUBEFACE_NEGY,
    CUBEFACE_POSZ, CUBEFACE_NEGZ
];

// axis index (0=X, 1=Y, 2=Z) and whether to reverse (descending)
// sort direction matches actual camera forward: back-to-front = farthest first
const FACE_SORT_MAP: { axis: number; descending: boolean }[] = [
    { axis: 0, descending: false },  // +X cubemap: camera looks -X, farthest = lowest X
    { axis: 0, descending: true },   // -X cubemap: camera looks +X, farthest = highest X
    { axis: 1, descending: true },   // +Y: camera looks +Y, farthest = highest Y
    { axis: 1, descending: false },  // -Y: camera looks -Y, farthest = lowest Y
    { axis: 2, descending: true },   // +Z: camera looks +Z, farthest = highest Z
    { axis: 2, descending: false }   // -Z: camera looks -Z, farthest = lowest Z
];

const compositeVsGlsl = /* glsl */`
attribute vec2 vertex_position;
varying vec2 vUv;
void main() {
    gl_Position = vec4(vertex_position, 0.5, 1.0);
    vUv = vertex_position * 0.5 + 0.5;
}
`;

const compositeFsGlsl = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform samplerCube uCubemap;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;

void main() {
    vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec4 world = uInvViewProj * clip;
    vec3 viewDir = normalize(world.xyz / world.w - uCameraPos);
    gl_FragColor = textureCube(uCubemap, vec3(-viewDir.x, -viewDir.y, viewDir.z));
}
`;

const compositeVsWgsl = /* wgsl */`
attribute vertex_position: vec2f;
varying vUv: vec2f;

@vertex fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(input.vertex_position, 0.5, 1.0);
    output.vUv = input.vertex_position * 0.5 + 0.5;
    return output;
}
`;

const compositeFsWgsl = /* wgsl */`
varying vUv: vec2f;
var uCubemap: texture_cube<f32>;
var uCubemap_sampler: sampler;
uniform uInvViewProj: mat4x4f;
uniform uCameraPos: vec3f;

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    let clip = vec4f(input.vUv * 2.0 - 1.0, 1.0, 1.0);
    let world = uniform.uInvViewProj * clip;
    let viewDir = normalize(world.xyz / world.w - uniform.uCameraPos);
    var output: FragmentOutput;
    output.color = textureSampleLevel(uCubemap, uCubemap_sampler, vec3f(-viewDir.x, viewDir.y, viewDir.z), 0.0);
    return output;
}
`;

const tmpVec = new Vec3();
const tmpMat = new Mat4();
const instanceSize = 128;

class SplatCache {
    private app: AppBase;
    private gsplatEntity: Entity;
    private cameraEntity: Entity;

    private cubemapTexture: Texture;
    private faceRenderTargets: RenderTarget[] = [];
    private facePasses: RenderPassForward[] = [];
    private compositePass: RenderPassShaderQuad;

    // precomputed sort orders in world space
    private sortAsc: Uint32Array[] = [];   // [axisX, axisY, axisZ]
    private sortDesc: Uint32Array[] = [];  // [axisX, axisY, axisZ]
    private worldCenters: Float32Array;
    private numSplats: number;

    // saved camera state
    private savedPosition = new Vec3();
    private savedRotation = new Quat();
    private savedFov = 0;
    private savedNear = 0;
    private savedFar = 0;
    private savedHorizontalFov = false;
    private savedAspectRatioMode = 0;
    private savedAspectRatio = 1;

    // cache invalidation
    private capturePosition = new Vec3();
    private stale = true;

    // saved sorter reference
    private originalSorter: any = null;

    constructor(app: AppBase, gsplatEntity: Entity, cameraEntity: Entity) {
        this.app = app;
        this.gsplatEntity = gsplatEntity;
        this.cameraEntity = cameraEntity;

        const gsplatComponent = gsplatEntity.gsplat as GSplatComponent;
        const instance = gsplatComponent.instance;
        const resource = (instance as any).resource;

        const centers: Float32Array = resource.centers;
        this.numSplats = centers.length / 3;

        // pre-transform centers to world space so sorts align with face directions
        const modelMat = gsplatEntity.getWorldTransform();
        this.worldCenters = new Float32Array(centers.length);
        const tmp = new Vec3();
        for (let i = 0; i < this.numSplats; i++) {
            tmp.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]);
            modelMat.transformPoint(tmp, tmp);
            this.worldCenters[i * 3] = tmp.x;
            this.worldCenters[i * 3 + 1] = tmp.y;
            this.worldCenters[i * 3 + 2] = tmp.z;
        }

        // disable the normal async sorter
        this.originalSorter = instance.sorter;
        if (instance.sorter) {
            instance.sorter.destroy();
            instance.sorter = null;
        }

        this.precomputeSortOrders();
        this.createCubemap();
        this.createRenderPasses();

        console.log(`SplatCache: initialized with ${this.numSplats} splats, cubemap ${CUBEMAP_SIZE}x${CUBEMAP_SIZE}`);
    }

    private precomputeSortOrders() {
        const { worldCenters, numSplats } = this;

        for (let axis = 0; axis < 3; axis++) {
            const indices = new Uint32Array(numSplats);
            for (let i = 0; i < numSplats; i++) {
                indices[i] = i;
            }

            indices.sort((a: number, b: number) => {
                return worldCenters[a * 3 + axis] - worldCenters[b * 3 + axis];
            });

            this.sortAsc.push(indices);

            const reversed = new Uint32Array(numSplats);
            for (let i = 0; i < numSplats; i++) {
                reversed[i] = indices[numSplats - 1 - i];
            }
            this.sortDesc.push(reversed);
        }
    }

    private createCubemap() {
        const device = this.app.graphicsDevice;

        this.cubemapTexture = new Texture(device, {
            name: 'SplatCacheCubemap',
            width: CUBEMAP_SIZE,
            height: CUBEMAP_SIZE,
            format: PIXELFORMAT_RGBA8,
            cubemap: true,
            mipmaps: false
        });

        for (let face = 0; face < 6; face++) {
            let faceIndex = FACE_INDICES[face];
            // On WebGL (no flipY), faces are stored upside-down. The composite
            // shader compensates by negating viewDir.y, which also swaps +Y/-Y
            // face selection. Counter that by swapping which face we render into.
            if (!device.isWebGPU) {
                if (faceIndex === CUBEFACE_POSY) faceIndex = CUBEFACE_NEGY;
                else if (faceIndex === CUBEFACE_NEGY) faceIndex = CUBEFACE_POSY;
            }
            const rt = new RenderTarget({
                colorBuffer: this.cubemapTexture,
                face: faceIndex,
                depth: true
            });
            this.faceRenderTargets.push(rt);
        }
    }

    private createRenderPasses() {
        const { app, cameraEntity } = this;
        const device = app.graphicsDevice;
        const scene = app.scene;
        const renderer = (app as any).renderer;
        const composition = scene.layers;
        const cameraComponent = cameraEntity.camera as CameraComponent;
        const worldLayer = composition.getLayerById(LAYERID_WORLD);

        // create 6 face render passes
        for (let face = 0; face < 6; face++) {
            const pass = new RenderPassForward(device, composition, scene, renderer);
            pass.init(this.faceRenderTargets[face]);

            // clear with transparent black for each face
            pass.setClearColor(new Color(0, 0, 0, 0));
            pass.setClearDepth(1.0);

            // store color after rendering
            if (pass.colorArrayOps && pass.colorArrayOps.length > 0) {
                pass.colorArrayOps[0].store = true;
            }

            pass.addLayer(cameraComponent, worldLayer!, false);
            pass.addLayer(cameraComponent, worldLayer!, true);

            pass.enabled = false;

            this.facePasses.push(pass);
        }

        // wrap the face passes' before/after to manage camera state and sort injection
        const cache = this;
        for (let face = 0; face < 6; face++) {
            const origBefore = this.facePasses[face].before.bind(this.facePasses[face]);
            const origAfter = this.facePasses[face].after.bind(this.facePasses[face]);

            this.facePasses[face].before = function () {
                if (face === 0) {
                    cache.saveCamera();
                }
                cache.setupCameraForFace(face);
                cache.writeOrderForFace(face);
                origBefore();

                // re-apply clear settings after origBefore(), since updateClears()
                // overwrites them with the camera's defaults during frame graph construction
                const pass = cache.facePasses[face];
                if (pass.colorArrayOps && pass.colorArrayOps.length > 0) {
                    const colorOps = pass.colorArrayOps[0];
                    colorOps.clear = true;
                    colorOps.clearValue.set(0, 0, 0, 0);
                    colorOps.store = true;
                }
                if ((pass as any).depthStencilOps) {
                    (pass as any).depthStencilOps.clearDepth = true;
                    (pass as any).depthStencilOps.clearDepthValue = 1.0;
                    (pass as any).depthStencilOps.storeDepth = true;
                }
            };

            this.facePasses[face].after = function () {
                origAfter();
                if (face === 5) {
                    cache.restoreCamera();
                }
            };
        }

        // composite pass
        this.compositePass = new RenderPassShaderQuad(device);
        this.compositePass.init(null);
        this.compositePass.setClearColor(new Color(0, 0, 0, 1));
        this.compositePass.setClearDepth(1.0);

        const shader = ShaderUtils.createShader(device, {
            uniqueName: 'SplatCacheComposite',
            attributes: { vertex_position: 'POSITION' },
            vertexGLSL: compositeVsGlsl,
            vertexWGSL: compositeVsWgsl,
            fragmentGLSL: compositeFsGlsl,
            fragmentWGSL: compositeFsWgsl
        });

        this.compositePass.shader = shader;

        const origCompositeBefore = this.compositePass.before.bind(this.compositePass);
        this.compositePass.before = () => {
            cache.updateCompositeUniforms();
            origCompositeBefore();
        };

        // set all passes on the camera
        cameraComponent.renderPasses = [...this.facePasses, this.compositePass];
    }

    private saveCamera() {
        const cam = this.cameraEntity;
        const cc = cam.camera!;
        this.savedPosition.copy(cam.getLocalPosition());
        this.savedRotation.copy(cam.getLocalRotation());
        this.savedFov = cc.fov;
        this.savedNear = cc.nearClip;
        this.savedFar = cc.farClip;
        this.savedHorizontalFov = cc.horizontalFov;
        this.savedAspectRatioMode = cc.aspectRatioMode;
        this.savedAspectRatio = cc.aspectRatio;
    }

    private restoreCamera() {
        const cam = this.cameraEntity;
        const cc = cam.camera!;
        cam.setLocalPosition(this.savedPosition);
        cam.setLocalRotation(this.savedRotation);
        cc.fov = this.savedFov;
        cc.nearClip = this.savedNear;
        cc.farClip = this.savedFar;
        cc.horizontalFov = this.savedHorizontalFov;
        cc.aspectRatioMode = this.savedAspectRatioMode;
        cc.aspectRatio = this.savedAspectRatio;
    }

    private debugFrame = 0;

    private setupCameraForFace(face: number) {
        const cam = this.cameraEntity;
        const cc = cam.camera!;
        const euler = FACE_EULER_ANGLES[face];

        cam.setEulerAngles(euler[0], euler[1], euler[2]);
        cc.fov = 90;
        cc.horizontalFov = false;
        cc.nearClip = 0.01;
        cc.farClip = 10000;
        cc.aspectRatioMode = 1; // ASPECT_MANUAL
        cc.aspectRatio = 1.0;
    }

    private writeOrderForFace(face: number) {
        const gsplatComponent = this.gsplatEntity.gsplat as GSplatComponent;
        const instance = gsplatComponent.instance!;
        const orderTexture = (instance as any).orderTexture;

        const sortInfo = FACE_SORT_MAP[face];
        const order = sortInfo.descending
            ? this.sortDesc[sortInfo.axis]
            : this.sortAsc[sortInfo.axis];

        const count = this.computeCountForFace(face, order);

        const faceNames = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
        const doLog = this.debugFrame < 3;

        if (doLog) {
            const worldEuler = this.cameraEntity.getEulerAngles();
            const worldPos = this.cameraEntity.getPosition();
            const fwd = new Vec3();
            this.cameraEntity.getWorldTransform().getZ(fwd);
            console.log(
                `[F${this.debugFrame}] Face ${face} (${faceNames[face]}):\n` +
                `  euler=(${FACE_EULER_ANGLES[face]})\n` +
                `  worldEuler=(${worldEuler.x.toFixed(1)}, ${worldEuler.y.toFixed(1)}, ${worldEuler.z.toFixed(1)})\n` +
                `  camPos=(${worldPos.x.toFixed(3)}, ${worldPos.y.toFixed(3)}, ${worldPos.z.toFixed(3)})\n` +
                `  camFwd=(${(-fwd.x).toFixed(3)}, ${(-fwd.y).toFixed(3)}, ${(-fwd.z).toFixed(3)})\n` +
                `  sort: axis=${sortInfo.axis} desc=${sortInfo.descending}\n` +
                `  count=${count}/${this.numSplats} (${(100 * count / this.numSplats).toFixed(1)}%)\n` +
                `  instancing=${Math.ceil(count / instanceSize)}`
            );

            if (count > 0) {
                const firstIdx = order[0];
                const lastIdx = order[count - 1];
                const axis = sortInfo.axis;
                console.log(
                    `  order[0]=${firstIdx} worldCenter[${axis}]=${this.worldCenters[firstIdx * 3 + axis].toFixed(3)}\n` +
                    `  order[${count - 1}]=${lastIdx} worldCenter[${axis}]=${this.worldCenters[lastIdx * 3 + axis].toFixed(3)}`
                );
            }
        }

        const data = orderTexture.lock({ mode: TEXTURELOCK_WRITE });
        for (let i = 0; i < count; i++) {
            data[i] = order[i];
        }
        for (let i = count; i < data.length; i++) {
            data[i] = 0;
        }
        orderTexture.unlock();

        (instance as any).meshInstance.instancingCount = Math.ceil(count / instanceSize);
        (instance as any).material.setParameter('numSplats', count);

        if (face === 5) {
            this.debugFrame++;
        }
    }

    private computeCountForFace(face: number, order: Uint32Array): number {
        const { worldCenters, numSplats } = this;

        const worldPos = this.cameraEntity.getPosition();

        const sortInfo = FACE_SORT_MAP[face];
        const axis = sortInfo.axis;
        const camAxisVal = axis === 0 ? worldPos.x : axis === 1 ? worldPos.y : worldPos.z;

        let lo = 0;
        let hi = numSplats;

        if (sortInfo.descending) {
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                const idx = order[mid];
                if (worldCenters[idx * 3 + axis] > camAxisVal) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
        } else {
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                const idx = order[mid];
                if (worldCenters[idx * 3 + axis] < camAxisVal) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
        }

        return lo;
    }

    private updateCompositeUniforms() {
        const cam = this.cameraEntity;
        const cc = cam.camera!;
        const device = this.app.graphicsDevice;

        const viewMat = cc.viewMatrix;
        const projMat = cc.projectionMatrix;

        tmpMat.mul2(projMat, viewMat);
        tmpMat.invert();

        const scope = device.scope;
        scope.resolve('uCubemap').setValue(this.cubemapTexture);
        scope.resolve('uInvViewProj').setValue(tmpMat.data);

        const pos = cam.getPosition();
        scope.resolve('uCameraPos').setValue([pos.x, pos.y, pos.z]);
    }

    frameUpdate(): boolean {
        const cameraPos = this.cameraEntity.getPosition();
        const dist = tmpVec.sub2(cameraPos, this.capturePosition).length();

        if (this.stale || dist > MOVE_THRESHOLD) {
            // enable face passes for this frame
            for (const pass of this.facePasses) {
                pass.enabled = true;
            }
            this.capturePosition.copy(cameraPos);
            this.stale = false;
            return true;
        }

        // cache is valid, disable face passes
        for (const pass of this.facePasses) {
            pass.enabled = false;
        }
        return true;
    }

    destroy() {
        // restore sorter
        const gsplatComponent = this.gsplatEntity.gsplat as GSplatComponent;
        if (gsplatComponent?.instance && this.originalSorter) {
            (gsplatComponent.instance as any).sorter = this.originalSorter;
        }

        for (const rt of this.faceRenderTargets) {
            rt.destroy();
        }
        this.cubemapTexture.destroy();

        for (const pass of this.facePasses) {
            pass.destroy();
        }
        this.compositePass.destroy();
    }
}

export { SplatCache };
