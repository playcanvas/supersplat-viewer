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

const CUBEMAP_SIZE = 1024;

const LAYER_CONFIG = [
    { nearDist: 0,  farDist: 5,     moveThreshold: 0.05 },
    { nearDist: 5,  farDist: 25,    moveThreshold: 0.5  },
    { nearDist: 25, farDist: 10000, moveThreshold: 2.5  }
];

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

const FACE_SORT_MAP: { axis: number; descending: boolean }[] = [
    { axis: 0, descending: false },  // +X cubemap: camera looks -X
    { axis: 0, descending: true },   // -X cubemap: camera looks +X
    { axis: 1, descending: true },   // +Y: camera looks +Y
    { axis: 1, descending: false },  // -Y: camera looks -Y
    { axis: 2, descending: true },   // +Z: camera looks +Z
    { axis: 2, descending: false }   // -Z: camera looks -Z
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
uniform samplerCube uCubemapNear;
uniform samplerCube uCubemapMid;
uniform samplerCube uCubemapFar;
uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;

void main() {
    vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec4 world = uInvViewProj * clip;
    vec3 viewDir = normalize(world.xyz / world.w - uCameraPos);
    vec3 dir = vec3(-viewDir.x, -viewDir.y, viewDir.z);

    vec4 result = textureCube(uCubemapFar, dir);
    vec4 mid = textureCube(uCubemapMid, dir);
    result = mid + (1.0 - mid.a) * result;
    vec4 near = textureCube(uCubemapNear, dir);
    result = near + (1.0 - near.a) * result;
    gl_FragColor = result;
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
var uCubemapNear: texture_cube<f32>;
var uCubemapNear_sampler: sampler;
var uCubemapMid: texture_cube<f32>;
var uCubemapMid_sampler: sampler;
var uCubemapFar: texture_cube<f32>;
var uCubemapFar_sampler: sampler;
uniform uInvViewProj: mat4x4f;
uniform uCameraPos: vec3f;

@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    let clip = vec4f(input.vUv * 2.0 - 1.0, 1.0, 1.0);
    let world = uniform.uInvViewProj * clip;
    let viewDir = normalize(world.xyz / world.w - uniform.uCameraPos);
    let dir = vec3f(-viewDir.x, viewDir.y, viewDir.z);

    var result = textureSampleLevel(uCubemapFar, uCubemapFar_sampler, dir, 0.0);
    let mid = textureSampleLevel(uCubemapMid, uCubemapMid_sampler, dir, 0.0);
    result = mid + (1.0 - mid.a) * result;
    let near = textureSampleLevel(uCubemapNear, uCubemapNear_sampler, dir, 0.0);
    result = near + (1.0 - near.a) * result;
    var output: FragmentOutput;
    output.color = result;
    return output;
}
`;

const tmpVec = new Vec3();
const tmpMat = new Mat4();
const instanceSize = 128;

interface CacheLayer {
    cubemapTexture: Texture;
    faceRenderTargets: RenderTarget[];
    facePasses: RenderPassForward[];
    capturePosition: Vec3;
    stale: boolean;
    nearDist: number;
    farDist: number;
    moveThreshold: number;
}

class SplatCache {
    private app: AppBase;
    private gsplatEntity: Entity;
    private cameraEntity: Entity;

    private layers: CacheLayer[] = [];
    private compositePass: RenderPassShaderQuad;

    private sortAsc: Uint32Array[] = [];
    private sortDesc: Uint32Array[] = [];
    private worldCenters: Float32Array;
    private numSplats: number;

    private savedPosition = new Vec3();
    private savedRotation = new Quat();
    private savedFov = 0;
    private savedNear = 0;
    private savedFar = 0;
    private savedHorizontalFov = false;
    private savedAspectRatioMode = 0;
    private savedAspectRatio = 1;

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

        this.originalSorter = instance.sorter;
        if (instance.sorter) {
            instance.sorter.destroy();
            instance.sorter = null;
        }

        this.precomputeSortOrders();

        for (let i = 0; i < LAYER_CONFIG.length; i++) {
            this.layers.push(this.createLayer(LAYER_CONFIG[i], i));
        }

        this.createCompositePass();
        this.wireRenderPasses();

        console.log(`SplatCache: ${this.numSplats} splats, ${LAYER_CONFIG.length} layers, cubemap ${CUBEMAP_SIZE}x${CUBEMAP_SIZE}`);
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

    private createLayer(config: typeof LAYER_CONFIG[number], layerIndex: number): CacheLayer {
        const device = this.app.graphicsDevice;
        const scene = this.app.scene;
        const renderer = (this.app as any).renderer;
        const composition = scene.layers;
        const cameraComponent = this.cameraEntity.camera as CameraComponent;
        const worldLayer = composition.getLayerById(LAYERID_WORLD);

        const cubemapTexture = new Texture(device, {
            name: `SplatCacheLayer${layerIndex}`,
            width: CUBEMAP_SIZE,
            height: CUBEMAP_SIZE,
            format: PIXELFORMAT_RGBA8,
            cubemap: true,
            mipmaps: false
        });

        const faceRenderTargets: RenderTarget[] = [];
        for (let face = 0; face < 6; face++) {
            let faceIndex = FACE_INDICES[face];
            if (!device.isWebGPU) {
                if (faceIndex === CUBEFACE_POSY) faceIndex = CUBEFACE_NEGY;
                else if (faceIndex === CUBEFACE_NEGY) faceIndex = CUBEFACE_POSY;
            }
            faceRenderTargets.push(new RenderTarget({
                colorBuffer: cubemapTexture,
                face: faceIndex,
                depth: true
            }));
        }

        const facePasses: RenderPassForward[] = [];
        for (let face = 0; face < 6; face++) {
            const pass = new RenderPassForward(device, composition, scene, renderer);
            pass.init(faceRenderTargets[face]);
            pass.setClearColor(new Color(0, 0, 0, 0));
            pass.setClearDepth(1.0);
            if (pass.colorArrayOps && pass.colorArrayOps.length > 0) {
                pass.colorArrayOps[0].store = true;
            }
            pass.addLayer(cameraComponent, worldLayer!, false);
            pass.addLayer(cameraComponent, worldLayer!, true);
            pass.enabled = false;
            facePasses.push(pass);
        }

        const cache = this;
        for (let face = 0; face < 6; face++) {
            const origBefore = facePasses[face].before.bind(facePasses[face]);
            const origAfter = facePasses[face].after.bind(facePasses[face]);

            facePasses[face].before = function () {
                cache.saveCamera();
                cache.setupCameraForFace(face);
                cache.writeOrderForFace(face, config.nearDist, config.farDist);
                origBefore();

                const pass = facePasses[face];
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

            facePasses[face].after = function () {
                origAfter();
                cache.restoreCamera();
            };
        }

        return {
            cubemapTexture,
            faceRenderTargets,
            facePasses,
            capturePosition: new Vec3(),
            stale: true,
            nearDist: config.nearDist,
            farDist: config.farDist,
            moveThreshold: config.moveThreshold
        };
    }

    private createCompositePass() {
        const device = this.app.graphicsDevice;

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

        const cache = this;
        const origBefore = this.compositePass.before.bind(this.compositePass);
        this.compositePass.before = () => {
            cache.updateCompositeUniforms();
            origBefore();
        };
    }

    private wireRenderPasses() {
        const cameraComponent = this.cameraEntity.camera as CameraComponent;
        const allPasses: any[] = [];
        for (const layer of this.layers) {
            allPasses.push(...layer.facePasses);
        }
        allPasses.push(this.compositePass);
        cameraComponent.renderPasses = allPasses;
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

    private setupCameraForFace(face: number) {
        const cam = this.cameraEntity;
        const cc = cam.camera!;
        const euler = FACE_EULER_ANGLES[face];

        cam.setEulerAngles(euler[0], euler[1], euler[2]);
        cc.fov = 90;
        cc.horizontalFov = false;
        cc.nearClip = 0.01;
        cc.farClip = 10000;
        cc.aspectRatioMode = 1;
        cc.aspectRatio = 1.0;
    }

    private writeOrderForFace(face: number, nearDist: number, farDist: number) {
        const gsplatComponent = this.gsplatEntity.gsplat as GSplatComponent;
        const instance = gsplatComponent.instance!;
        const orderTexture = (instance as any).orderTexture;

        const sortInfo = FACE_SORT_MAP[face];
        const order = sortInfo.descending
            ? this.sortDesc[sortInfo.axis]
            : this.sortAsc[sortInfo.axis];

        const { startIdx, endIdx } = this.computeShellRange(face, order, nearDist, farDist);
        const count = endIdx - startIdx;

        const data = orderTexture.lock({ mode: TEXTURELOCK_WRITE });
        for (let i = 0; i < count; i++) {
            data[i] = order[startIdx + i];
        }
        for (let i = count; i < data.length; i++) {
            data[i] = 0;
        }
        orderTexture.unlock();

        (instance as any).meshInstance.instancingCount = Math.ceil(count / instanceSize);
        (instance as any).material.setParameter('numSplats', count);
    }

    private computeShellRange(
        face: number,
        order: Uint32Array,
        nearDist: number,
        farDist: number
    ): { startIdx: number; endIdx: number } {
        const { worldCenters, numSplats } = this;
        const worldPos = this.cameraEntity.getPosition();
        const sortInfo = FACE_SORT_MAP[face];
        const axis = sortInfo.axis;
        const camVal = axis === 0 ? worldPos.x : axis === 1 ? worldPos.y : worldPos.z;

        let startIdx: number;
        let endIdx: number;

        if (sortInfo.descending) {
            // Descending order (highest first). Splats in front have value > camVal.
            // Shell: camVal + nearDist <= value <= camVal + farDist
            // startIdx: first index where value <= camVal + farDist
            startIdx = this.bsFirstLE(order, axis, camVal + farDist);
            // endIdx: first index where value < camVal + nearDist
            endIdx = this.bsFirstLT(order, axis, camVal + nearDist);
        } else {
            // Ascending order (lowest first). Splats in front have value < camVal.
            // Shell: camVal - farDist <= value <= camVal - nearDist
            // startIdx: first index where value >= camVal - farDist
            startIdx = this.bsFirstGE(order, axis, camVal - farDist);
            // endIdx: first index where value > camVal - nearDist
            endIdx = this.bsFirstGT(order, axis, camVal - nearDist);
        }

        return { startIdx, endIdx };
    }

    private bsFirstLE(order: Uint32Array, axis: number, thresh: number): number {
        const { worldCenters, numSplats } = this;
        let lo = 0, hi = numSplats;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (worldCenters[order[mid] * 3 + axis] > thresh) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    private bsFirstLT(order: Uint32Array, axis: number, thresh: number): number {
        const { worldCenters, numSplats } = this;
        let lo = 0, hi = numSplats;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (worldCenters[order[mid] * 3 + axis] >= thresh) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    private bsFirstGE(order: Uint32Array, axis: number, thresh: number): number {
        const { worldCenters, numSplats } = this;
        let lo = 0, hi = numSplats;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (worldCenters[order[mid] * 3 + axis] < thresh) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    private bsFirstGT(order: Uint32Array, axis: number, thresh: number): number {
        const { worldCenters, numSplats } = this;
        let lo = 0, hi = numSplats;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (worldCenters[order[mid] * 3 + axis] <= thresh) {
                lo = mid + 1;
            } else {
                hi = mid;
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
        scope.resolve('uCubemapNear').setValue(this.layers[0].cubemapTexture);
        scope.resolve('uCubemapMid').setValue(this.layers[1].cubemapTexture);
        scope.resolve('uCubemapFar').setValue(this.layers[2].cubemapTexture);
        scope.resolve('uInvViewProj').setValue(tmpMat.data);

        const pos = cam.getPosition();
        scope.resolve('uCameraPos').setValue([pos.x, pos.y, pos.z]);
    }

    frameUpdate(): boolean {
        const cameraPos = this.cameraEntity.getPosition();

        for (const layer of this.layers) {
            const dist = tmpVec.sub2(cameraPos, layer.capturePosition).length();
            const needsUpdate = layer.stale || dist > layer.moveThreshold;

            for (const pass of layer.facePasses) {
                pass.enabled = needsUpdate;
            }

            if (needsUpdate) {
                layer.capturePosition.copy(cameraPos);
                layer.stale = false;
            }
        }

        return true;
    }

    destroy() {
        const gsplatComponent = this.gsplatEntity.gsplat as GSplatComponent;
        if (gsplatComponent?.instance && this.originalSorter) {
            (gsplatComponent.instance as any).sorter = this.originalSorter;
        }

        for (const layer of this.layers) {
            for (const rt of layer.faceRenderTargets) {
                rt.destroy();
            }
            layer.cubemapTexture.destroy();
            for (const pass of layer.facePasses) {
                pass.destroy();
            }
        }
        this.compositePass.destroy();
    }
}

export { SplatCache };
