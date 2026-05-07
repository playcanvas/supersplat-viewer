/**
 * World picking for splat scenes.
 *
 * - **Compute renderer (WebGPU tiled-compute)**: uses engine `Picker` with depth enabled — expected
 *   depth is already provided by the tile-composite path.
 * - **Raster renderers (WebGL, CPU / GPU sort, etc.)**: custom `pickPS` / `gsplatPS` patch plus
 *   `RGBA16F` alpha-weighted depth accumulation, because the stock pick pass encodes splat IDs /
 *   last-fragment depth rather than expected depth.
 */

import {
    type AppBase,
    type Entity,
    type GSplatComponent,
    type Layer,
    type MeshInstance,
    ADDRESS_CLAMP_TO_EDGE,
    BLENDEQUATION_ADD,
    BLENDMODE_ZERO,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    FILTER_NEAREST,
    GSPLAT_RENDERER_COMPUTE,
    PIXELFORMAT_RGBA16F,
    PROJECTION_ORTHOGRAPHIC,
    Picker as EnginePicker,
    Color,
    Mat4,
    RenderPassPicker,
    RenderTarget,
    ShaderChunks,
    Texture,
    Vec3,
    Vec4,
    BlendState
} from 'playcanvas';

// Override global picking to pack alpha-weighted splat depth instead of meshInstance id.
const pickDepthGlsl = /* glsl */ `
vec4 encodePickOutput(uint id) {
    const vec4 inv = vec4(1.0 / 255.0);
    const uvec4 shifts = uvec4(16, 8, 0, 24);
    uvec4 col = (uvec4(id) >> shifts) & uvec4(0xff);
    return vec4(col) * inv;
}

#ifdef GSPLAT_PICK_DEPTH
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform vec4 camera_params; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    vec4 getPickOutput() {
        float normalizedDepth;
        if (camera_params.w > 0.5) {
            normalizedDepth = gl_FragCoord.z;
        } else {
            float linearDepth = 1.0 / gl_FragCoord.w;
            normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
        }

        return vec4(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a);
    }
#else
    #ifndef PICK_CUSTOM_ID
        uniform uint meshInstanceId;

        vec4 getPickOutput() {
            return encodePickOutput(meshInstanceId);
        }
    #endif
#endif

#ifdef DEPTH_PICK_PASS
    #include "floatAsUintPS"
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform vec4 camera_params; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    vec4 getPickDepth() {
        float linearDepth;
        if (camera_params.w > 0.5) {
            linearDepth = gl_FragCoord.z;
        } else {
            float viewDist = 1.0 / gl_FragCoord.w;
            linearDepth = (viewDist - camera_params.z) / (camera_params.y - camera_params.z);
        }
        return float2uint(linearDepth);
    }
#endif
`;

const pickDepthWgsl = /* wgsl */ `
fn encodePickOutput(id: u32) -> vec4f {
    let inv: vec4f = vec4f(1.0 / 255.0);
    let shifts: vec4u = vec4u(16u, 8u, 0u, 24u);
    let col: vec4u = (vec4u(id) >> shifts) & vec4u(0xffu);
    return vec4f(col) * inv;
}

#ifdef GSPLAT_PICK_DEPTH
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform camera_params: vec4f; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    fn getPickOutput() -> vec4f {
        var normalizedDepth: f32;
        if (uniform.camera_params.w > 0.5) {
            normalizedDepth = pcPosition.z;
        } else {
            let linearDepth = 1.0 / pcPosition.w;
            normalizedDepth = (linearDepth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        }

        let a = f32(gaussianColor.a);
        return vec4f(a * normalizedDepth, 0.0, 0.0, a);
    }
#else
    #ifndef PICK_CUSTOM_ID
        uniform meshInstanceId: u32;

        fn getPickOutput() -> vec4f {
            return encodePickOutput(uniform.meshInstanceId);
        }
    #endif
#endif

#ifdef DEPTH_PICK_PASS
    #include "floatAsUintPS"
    #ifndef CAMERAPLANES
        #define CAMERAPLANES
        uniform camera_params: vec4f; // x: 1/far, y: far, z: near, w: isOrtho
    #endif

    fn getPickDepth() -> vec4f {
        var linearDepth: f32;
        if (uniform.camera_params.w > 0.5) {
            linearDepth = pcPosition.z;
        } else {
            let viewDist = 1.0 / pcPosition.w;
            linearDepth = (viewDist - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        }
        return float2uint(linearDepth);
    }
#endif
`;

const pickPassChunkInjected = [
    '#ifdef PICK_PASS',
    '    #define GSPLAT_PICK_DEPTH',
    '    #include "pickPS"',
    '#endif'
].join('\n');

const safeChunkReplace = (s: string, find: string | RegExp, repl: string) => {
    const out = s.replace(find, repl);
    if (out === s) {
        throw new Error('picker: engine gsplat/pick chunk patch failed (engine version mismatch?)');
    }
    return out;
};

const patchGsplatPickGlsl = (chunk: string) => {
    return safeChunkReplace(
        safeChunkReplace(
            chunk,
            /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/,
            pickPassChunkInjected
        ),
        'pcFragColor0 = encodePickOutput(vPickId);',
        'pcFragColor0 = getPickOutput();'
    );
};

const patchGsplatPickWgsl = (chunk: string) => {
    return safeChunkReplace(
        safeChunkReplace(
            chunk,
            /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/,
            pickPassChunkInjected
        ),
        'output.color = encodePickOutput(vPickId);',
        'output.color = getPickOutput();'
    );
};

type PickerShaderPatchState = {
    glslPickPS: string;
    glslGsplatPS: string;
    wgslPickPS: string;
    wgslGsplatPS: string;
    refCount: number;
};

/** Per-device original chunk strings + refcount so we can restore after the last Picker releases. */
const pickerShaderPatchState = new WeakMap<object, PickerShaderPatchState>();

const vec4 = new Vec4();
const viewProjMat = new Mat4();
const clearColor = new Color(0, 0, 0, 1);
const NORMAL_EPSILON = 1e-12;
const NORMAL_DEGENERATE_EPSILON = 1e-20;
// Sampling for the surface-normal estimator runs on a circular footprint of
// fixed *world* radius, projected to pixels at the picked-point's depth.
// Keeping the world area constant means adjacent cursor positions sample
// almost the same world cluster, which stabilises the plane fit. The pixel
// radius is clamped so distant picks still get enough samples and very-close
// picks don't blow the block read.
const NORMAL_SAMPLE_WORLD_RADIUS = 0.2;
const NORMAL_SAMPLE_MIN_PX = 6;
const NORMAL_SAMPLE_MAX_PX = 48;
const NORMAL_RING_FRACTIONS = [0.3, 0.55, 0.8, 1.0];
const NORMAL_OUTLIER_THRESHOLD = 2.5;
const NORMAL_SAMPLE_DIRECTIONS = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1]
] as const;

type PickSurface = {
    position: Vec3;
    normal: Vec3;
};

type PickCameraSnapshot = {
    position: Vec3;
    viewMatrix: Mat4;
    projectionMatrix: Mat4;
    nearClip: number;
    farClip: number;
    projection: number;
};

type PickPosition = {
    position: Vec3;
    camera: PickCameraSnapshot;
    screenX: number;
    screenY: number;
    width: number;
    height: number;
    isComputeRenderer: boolean;
};

// Shared buffer for half-to-float conversion
const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);

// Convert 16-bit half-float to 32-bit float using bit manipulation.
const half2Float = (h: number): number => {
    const sign = (h & 0x8000) << 16;
    const exponent = (h & 0x7C00) >> 10;
    const mantissa = h & 0x03FF;

    if (exponent === 0) {
        if (mantissa === 0) {
            uint32[0] = sign;
        } else {
            let e = -1;
            let m = mantissa;
            do {
                e++;
                m <<= 1;
            } while ((m & 0x0400) === 0);
            uint32[0] = sign | ((127 - 15 - e) << 23) | ((m & 0x03FF) << 13);
        }
    } else if (exponent === 31) {
        uint32[0] = sign | 0x7F800000 | (mantissa << 13);
    } else {
        uint32[0] = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13);
    }

    return float32[0];
};

const registerPickerShaderPatches = (app: AppBase) => {
    const device = app.graphicsDevice;
    const existing = pickerShaderPatchState.get(device);
    if (existing) {
        existing.refCount++;
        return;
    }

    const glslChunks = ShaderChunks.get(device, 'glsl');
    const wgslChunks = ShaderChunks.get(device, 'wgsl');

    const glslPickPS = glslChunks.get('pickPS');
    const glslGsplatPS = glslChunks.get('gsplatPS');
    const wgslPickPS = wgslChunks.get('pickPS');
    const wgslGsplatPS = wgslChunks.get('gsplatPS');

    // Patch strings before mutating ShaderChunks so engine mismatches leave globals untouched.
    const patchedGlslGsplatPS = patchGsplatPickGlsl(glslGsplatPS);
    const patchedWgslGsplatPS = patchGsplatPickWgsl(wgslGsplatPS);

    const state: PickerShaderPatchState = {
        glslPickPS,
        glslGsplatPS,
        wgslPickPS,
        wgslGsplatPS,
        refCount: 1
    };
    pickerShaderPatchState.set(device, state);

    glslChunks.set('pickPS', pickDepthGlsl);
    wgslChunks.set('pickPS', pickDepthWgsl);
    glslChunks.set('gsplatPS', patchedGlslGsplatPS);
    wgslChunks.set('gsplatPS', patchedWgslGsplatPS);
};

const unregisterPickerShaderPatches = (app: AppBase) => {
    const device = app.graphicsDevice;
    const state = pickerShaderPatchState.get(device);
    if (!state) {
        return;
    }
    state.refCount--;
    if (state.refCount > 0) {
        return;
    }

    const glslChunks = ShaderChunks.get(device, 'glsl');
    const wgslChunks = ShaderChunks.get(device, 'wgsl');
    glslChunks.set('pickPS', state.glslPickPS);
    glslChunks.set('gsplatPS', state.glslGsplatPS);
    wgslChunks.set('pickPS', state.wgslPickPS);
    wgslChunks.set('gsplatPS', state.wgslGsplatPS);
    pickerShaderPatchState.delete(device);
};

const createPickCameraSnapshot = (): PickCameraSnapshot => ({
    position: new Vec3(),
    viewMatrix: new Mat4(),
    projectionMatrix: new Mat4(),
    nearClip: 0,
    farClip: 0,
    projection: 0
});

const captureCameraSnapshot = (camera: Entity, out: PickCameraSnapshot) => {
    const cam = camera.camera;
    out.position.copy(camera.getPosition());
    out.viewMatrix.copy(cam.viewMatrix);
    out.projectionMatrix.copy(cam.projectionMatrix);
    out.nearClip = cam.nearClip;
    out.farClip = cam.farClip;
    out.projection = cam.projection;
};

const getWorldPoint = (camera: PickCameraSnapshot, x: number, y: number, width: number, height: number, normalizedDepth: number, out?: Vec3) => {
    if (!Number.isFinite(normalizedDepth) || normalizedDepth < 0 || normalizedDepth > 1) {
        return null;
    }

    const { farClip: far, nearClip: near } = camera;
    const ndcDepth = camera.projection === PROJECTION_ORTHOGRAPHIC ?
        normalizedDepth :
        far * normalizedDepth / (normalizedDepth * (far - near) + near);

    viewProjMat.mul2(camera.projectionMatrix, camera.viewMatrix).invert();
    vec4.set(x / width * 2 - 1, (1 - y / height) * 2 - 1, ndcDepth * 2 - 1, 1);
    viewProjMat.transformVec4(vec4, vec4);
    if (!Number.isFinite(vec4.w) || Math.abs(vec4.w) < 1e-8) {
        return null;
    }

    vec4.mulScalar(1 / vec4.w);
    if (!Number.isFinite(vec4.x) || !Number.isFinite(vec4.y) || !Number.isFinite(vec4.z)) {
        return null;
    }

    return (out ?? new Vec3()).set(vec4.x, vec4.y, vec4.z);
};

const setCameraFacingNormal = (cameraPosition: Vec3, position: Vec3, normal: Vec3) => {
    normal.sub2(cameraPosition, position);
    const len = normal.length();
    if (len > 1e-6) {
        normal.mulScalar(1 / len);
    } else {
        normal.set(0, 1, 0);
    }

    return normal;
};

type PlaneFit = {
    cx: number; cy: number; cz: number;
    vx: number; vy: number; vz: number;
};

// Project a world-space radius around `pos` to its on-screen pixel radius for
// the given camera. Uses the projection matrix's [1][1] entry (= 1/tan(fov/2)
// for perspective, = 1/orthoHeight for orthographic) so we don't need fov or
// orthoHeight on the snapshot.
const worldRadiusToPixelRadius = (cam: PickCameraSnapshot, pos: Vec3, canvasHeight: number, worldRadius: number): number => {
    const projY = cam.projectionMatrix.data[5];
    if (cam.projection === PROJECTION_ORTHOGRAPHIC) {
        return worldRadius * projY * canvasHeight / 2;
    }
    const dx = pos.x - cam.position.x;
    const dy = pos.y - cam.position.y;
    const dz = pos.z - cam.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1e-6) return Infinity;
    return worldRadius * projY * canvasHeight / (2 * distance);
};

// Single least-squares plane fit through a cluster of 3D points. The normal
// is the eigenvector of the smallest eigenvalue of the points' 3x3 covariance
// matrix, computed in closed form (analytic eigendecomposition for 3x3
// symmetric, Smith 1961). Returns null on degenerate input.
const fitPlaneOnce = (points: Vec3[]): PlaneFit | null => {
    const n = points.length;
    if (n < 3) return null;

    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
        cx += points[i].x; cy += points[i].y; cz += points[i].z;
    }
    cx /= n; cy /= n; cz /= n;

    let cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    for (let i = 0; i < n; i++) {
        const dx = points[i].x - cx;
        const dy = points[i].y - cy;
        const dz = points[i].z - cz;
        cxx += dx * dx; cxy += dx * dy; cxz += dx * dz;
        cyy += dy * dy; cyz += dy * dz; czz += dz * dz;
    }

    const q = (cxx + cyy + czz) / 3;
    const a = cxx - q, b = cyy - q, c = czz - q;
    const p2 = a * a + b * b + c * c + 2 * (cxy * cxy + cxz * cxz + cyz * cyz);
    if (p2 < NORMAL_DEGENERATE_EPSILON) return null;
    const p = Math.sqrt(p2 / 6);
    const inv = 1 / p;
    const Bxx = a * inv, Bxy = cxy * inv, Bxz = cxz * inv;
    const Byy = b * inv, Byz = cyz * inv, Bzz = c * inv;
    const detB = Bxx * (Byy * Bzz - Byz * Byz) -
                 Bxy * (Bxy * Bzz - Byz * Bxz) +
                 Bxz * (Bxy * Byz - Byy * Bxz);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const lambdaMin = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);

    const Mxx = cxx - lambdaMin, Myy = cyy - lambdaMin, Mzz = czz - lambdaMin;
    const v1x = cxy * cyz - cxz * Myy;
    const v1y = cxz * cxy - Mxx * cyz;
    const v1z = Mxx * Myy - cxy * cxy;
    const v2x = cxy * Mzz - cxz * cyz;
    const v2y = cxz * cxz - Mxx * Mzz;
    const v2z = Mxx * cyz - cxy * cxz;
    const v3x = Myy * Mzz - cyz * cyz;
    const v3y = cyz * cxz - cxy * Mzz;
    const v3z = cxy * cyz - Myy * cxz;
    const l1 = v1x * v1x + v1y * v1y + v1z * v1z;
    const l2 = v2x * v2x + v2y * v2y + v2z * v2z;
    const l3 = v3x * v3x + v3y * v3y + v3z * v3z;
    let vx: number, vy: number, vz: number, lSq: number;
    if (l1 >= l2 && l1 >= l3) {
        vx = v1x; vy = v1y; vz = v1z; lSq = l1;
    } else if (l2 >= l3) {
        vx = v2x; vy = v2y; vz = v2z; lSq = l2;
    } else {
        vx = v3x; vy = v3y; vz = v3z; lSq = l3;
    }
    if (lSq < NORMAL_EPSILON) return null;
    const invLen = 1 / Math.sqrt(lSq);
    return { cx, cy, cz, vx: vx * invLen, vy: vy * invLen, vz: vz * invLen };
};

// Two-pass plane fit: first pass on all points, then drop points whose
// distance from the fitted plane exceeds NORMAL_OUTLIER_THRESHOLD * the mean
// residual, refit on the inliers. Sign-flips the result toward toCamera so
// the cursor's tangent basis stays consistent. Returns false on degenerate
// input (fewer than 3 points, collinear/coincident samples).
const fitPlaneNormal = (points: Vec3[], toCamera: Vec3, outNormal: Vec3): boolean => {
    const first = fitPlaneOnce(points);
    if (!first) return false;

    let residualSum = 0;
    for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - first.cx;
        const dy = points[i].y - first.cy;
        const dz = points[i].z - first.cz;
        residualSum += Math.abs(dx * first.vx + dy * first.vy + dz * first.vz);
    }
    const threshold = (residualSum / points.length) * NORMAL_OUTLIER_THRESHOLD;

    const inliers: Vec3[] = [];
    for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - first.cx;
        const dy = points[i].y - first.cy;
        const dz = points[i].z - first.cz;
        if (Math.abs(dx * first.vx + dy * first.vy + dz * first.vz) <= threshold) {
            inliers.push(points[i]);
        }
    }

    let result = first;
    if (inliers.length >= 3 && inliers.length < points.length) {
        const refined = fitPlaneOnce(inliers);
        if (refined) result = refined;
    }

    let { vx, vy, vz } = result;
    if (vx * toCamera.x + vy * toCamera.y + vz * toCamera.z < 0) {
        vx = -vx; vy = -vy; vz = -vz;
    }
    outNormal.set(vx, vy, vz);
    return true;
};

class Picker {
    pick: (x: number, y: number) => Promise<Vec3 | null>;

    pickSurface: (x: number, y: number) => Promise<PickSurface | null>;

    release: () => void;

    constructor(app: AppBase, camera: Entity) {
        const { graphicsDevice } = app;

        let enginePicker: EnginePicker | undefined;
        let accumBuffer: Texture;
        let accumTarget: RenderTarget;
        let accumPass: RenderPassPicker;
        let chunksPatched = false;
        let pickQueue = Promise.resolve();
        let cacheValid = false;
        let cacheWidth = 0;
        let cacheHeight = 0;
        const cacheCamera: PickCameraSnapshot = createPickCameraSnapshot();

        const initRasterAccum = (width: number, height: number) => {
            accumBuffer = new Texture(graphicsDevice, {
                format: PIXELFORMAT_RGBA16F,
                width,
                height,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                name: 'picker-accum'
            });

            accumTarget = new RenderTarget({
                colorBuffer: accumBuffer,
                depth: false // not needed — gaussians are rendered back to front
            });

            accumPass = new RenderPassPicker(graphicsDevice, app.renderer);
            // RGB: additive depth accumulation. Alpha: multiplicative transmittance.
            accumPass.blendState = new BlendState(
                true,
                BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA,
                BLENDEQUATION_ADD, BLENDMODE_ZERO, BLENDMODE_ONE_MINUS_SRC_ALPHA
            );
        };

        const readTexture = <T extends Uint8Array | Uint16Array>(
            texture: Texture,
            x: number,
            y: number,
            target: RenderTarget
        ): Promise<T> => {
            const texY = graphicsDevice.isWebGL2 ? target.height - y - 1 : y;

            return texture.read(x, texY, 1, 1, {
                renderTarget: target,
                immediate: true
            }) as Promise<T>;
        };

        const updateCache = (width: number, height: number) => {
            captureCameraSnapshot(camera, cacheCamera);
            cacheWidth = width;
            cacheHeight = height;
        };

        const cameraMatches = (width: number, height: number) => {
            const cam = camera.camera;
            return cacheValid &&
                cacheWidth === width &&
                cacheHeight === height &&
                cacheCamera.viewMatrix.equals(cam.viewMatrix) &&
                cacheCamera.projectionMatrix.equals(cam.projectionMatrix) &&
                cacheCamera.nearClip === cam.nearClip &&
                cacheCamera.farClip === cam.farClip &&
                cacheCamera.projection === cam.projection;
        };

        const getCacheCameraSnapshot = (): PickCameraSnapshot => {
            const snapshot = createPickCameraSnapshot();
            snapshot.position.copy(cacheCamera.position);
            snapshot.viewMatrix.copy(cacheCamera.viewMatrix);
            snapshot.projectionMatrix.copy(cacheCamera.projectionMatrix);
            snapshot.nearClip = cacheCamera.nearClip;
            snapshot.farClip = cacheCamera.farClip;
            snapshot.projection = cacheCamera.projection;
            return snapshot;
        };

        const readRasterBlock = async (
            blockX: number,
            blockY: number,
            blockWidth: number,
            blockHeight: number,
            viewportWidth: number,
            viewportHeight: number,
            pickCamera: PickCameraSnapshot
        ) => {
            const texY = graphicsDevice.isWebGL2 ? accumTarget.height - blockY - blockHeight : blockY;

            const pixels = await accumBuffer.read(blockX, texY, blockWidth, blockHeight, {
                renderTarget: accumTarget,
                immediate: true
            }) as Uint16Array;

            return (x: number, y: number) => {
                const localX = x - blockX;
                const localY = y - blockY;
                if (localX < 0 || localX >= blockWidth || localY < 0 || localY >= blockHeight) {
                    return null;
                }

                const row = graphicsDevice.isWebGL2 ? blockHeight - localY - 1 : localY;
                const index = (row * blockWidth + localX) * 4;
                const r = half2Float(pixels[index]);
                const transmittance = half2Float(pixels[index + 3]);
                const alpha = 1 - transmittance;

                if (!Number.isFinite(r) || !Number.isFinite(alpha) || alpha < 1e-6) {
                    return null;
                }

                const normalizedDepth = r / alpha;
                return getWorldPoint(pickCamera, x, y, viewportWidth, viewportHeight, normalizedDepth);
            };
        };

        const ensureRendered = (
            width: number,
            height: number,
            isComputeRenderer: boolean,
            worldLayer: Layer
        ) => {
            if (cameraMatches(width, height)) {
                return;
            }

            // Enable gsplat IDs only while rendering the pick target so we
            // don't pay the memory/perf cost between pick passes.
            const prevEnableIds = app.scene.gsplat.enableIds;
            app.scene.gsplat.enableIds = true;
            try {
                if (isComputeRenderer) {
                    enginePicker ??= new EnginePicker(app, 1, 1, true);
                    enginePicker.resize(width, height);
                    enginePicker.prepare(camera.camera, app.scene, [worldLayer]);
                } else {
                    if (!chunksPatched) {
                        registerPickerShaderPatches(app);
                        chunksPatched = true;
                    }

                    if (!accumPass) {
                        initRasterAccum(width, height);
                    } else if (cacheWidth !== width || cacheHeight !== height) {
                        cacheValid = false;
                        accumTarget.resize(width, height);
                    }

                    accumPass.init(accumTarget);
                    accumPass.setClearColor(clearColor);
                    accumPass.update(
                        camera.camera,
                        app.scene,
                        [worldLayer],
                        new Map<number, MeshInstance | GSplatComponent>(),
                        false
                    );
                    accumPass.render();
                }

                updateCache(width, height);
                cacheValid = true;
            } finally {
                app.scene.gsplat.enableIds = prevEnableIds;
            }
        };

        const prepareSample = (x: number, y: number) => {
            const width = Math.floor(graphicsDevice.width);
            const height = Math.floor(graphicsDevice.height);

            // bail out if the device hasn't been sized yet
            if (width <= 0 || height <= 0) {
                return null;
            }

            const worldLayer = app.scene.layers.getLayerByName('World');
            if (!worldLayer) {
                return null;
            }

            const screenX = Math.min(width - 1, Math.max(0, Math.floor(x * width)));
            const screenY = Math.min(height - 1, Math.max(0, Math.floor(y * height)));
            const isComputeRenderer = app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_COMPUTE;

            ensureRendered(width, height, isComputeRenderer, worldLayer);
            const pickCamera = getCacheCameraSnapshot();

            return { width, height, screenX, screenY, isComputeRenderer, pickCamera };
        };

        const pickPosition = async (x: number, y: number): Promise<PickPosition | null> => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, isComputeRenderer, pickCamera } = sample;

            if (isComputeRenderer) {
                const normalizedDepth = await enginePicker!.getPointDepthAsync(screenX, screenY);
                const position = normalizedDepth !== null ?
                    getWorldPoint(pickCamera, screenX, screenY, width, height, normalizedDepth) :
                    null;
                return position ? { position, camera: pickCamera, screenX, screenY, width, height, isComputeRenderer } : null;
            }

            const pixels = await readTexture<Uint16Array>(accumBuffer, screenX, screenY, accumTarget);

            const r = half2Float(pixels[0]);
            const transmittance = half2Float(pixels[3]);
            const alpha = 1 - transmittance;

            if (!Number.isFinite(r) || !Number.isFinite(alpha) || alpha < 1e-6) {
                return null;
            }

            const normalizedDepth = r / alpha;
            const position = getWorldPoint(pickCamera, screenX, screenY, width, height, normalizedDepth);
            return position ? { position, camera: pickCamera, screenX, screenY, width, height, isComputeRenderer } : null;
        };

        const serializePick = <T>(operation: () => Promise<T>): Promise<T> => {
            // The render targets are shared by all picks on this instance.
            const result = pickQueue.then(operation, operation);
            pickQueue = result.then((): void => undefined, (): void => undefined);
            return result;
        };

        const pick = async (x: number, y: number) => {
            const result = await pickPosition(x, y);
            return result?.position ?? null;
        };

        const pickSurface = async (x: number, y: number) => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, isComputeRenderer, pickCamera } = sample;

            if (isComputeRenderer) {
                const normalizedDepth = await enginePicker!.getPointDepthAsync(screenX, screenY);
                const position = normalizedDepth !== null ?
                    getWorldPoint(pickCamera, screenX, screenY, width, height, normalizedDepth) :
                    null;
                if (!position) {
                    return null;
                }
                return {
                    position,
                    normal: new Vec3(0, 1, 0)
                };
            }

            // Single block read serves both depth (center pixel) and normal
            // samples. Sized to the maximum possible ring pixel-radius so the
            // dynamic ring offsets always lie inside the buffer we read.
            const blockX = Math.max(0, screenX - NORMAL_SAMPLE_MAX_PX);
            const blockY = Math.max(0, screenY - NORMAL_SAMPLE_MAX_PX);
            const blockWidth = Math.min(width - 1, screenX + NORMAL_SAMPLE_MAX_PX) - blockX + 1;
            const blockHeight = Math.min(height - 1, screenY + NORMAL_SAMPLE_MAX_PX) - blockY + 1;
            const rasterBlock = await readRasterBlock(
                blockX,
                blockY,
                blockWidth,
                blockHeight,
                width,
                height,
                pickCamera
            );

            const position = rasterBlock(screenX, screenY);
            if (!position) {
                return null;
            }

            const samplePixel = (px: number, py: number) => {
                if (px < 0 || px >= width || py < 0 || py >= height) {
                    return null;
                }
                return rasterBlock(px, py);
            };

            // Pixel radius corresponding to a fixed world radius at the
            // picked-point's depth. Clamped so distant picks still sample
            // enough pixels and very-close picks stay inside the block read.
            const pixelRadius = Math.max(NORMAL_SAMPLE_MIN_PX,
                Math.min(NORMAL_SAMPLE_MAX_PX,
                    worldRadiusToPixelRadius(pickCamera, position, height, NORMAL_SAMPLE_WORLD_RADIUS)));
            const ringPixelRadii = NORMAL_RING_FRACTIONS.map(f => Math.max(1, Math.round(f * pixelRadius)));
            const sampleRings = ringPixelRadii.map((radius) => {
                return NORMAL_SAMPLE_DIRECTIONS.map(([dx, dy]) => {
                    return samplePixel(screenX + dx * radius, screenY + dy * radius);
                });
            });

            const toCamera = setCameraFacingNormal(pickCamera.position, position, new Vec3());

            // Collect every valid 3D sample: the picked position plus all ring
            // samples that didn't fall off-screen or fail the depth read.
            const fitPoints: Vec3[] = [position];
            for (let i = 0; i < sampleRings.length; i++) {
                const ring = sampleRings[i];
                for (let j = 0; j < ring.length; j++) {
                    const pt = ring[j];
                    if (pt) fitPoints.push(pt);
                }
            }

            const normal = new Vec3();
            if (!fitPlaneNormal(fitPoints, toCamera, normal)) {
                normal.copy(toCamera);
            }

            return {
                position,
                normal
            };
        };

        this.pick = (x: number, y: number) => serializePick(() => pick(x, y));

        this.pickSurface = (x: number, y: number) => serializePick(() => pickSurface(x, y));

        this.release = () => {
            if (chunksPatched) {
                unregisterPickerShaderPatches(app);
                chunksPatched = false;
            }
            enginePicker?.destroy();
            accumPass?.destroy();
            accumTarget?.destroy();
            accumBuffer?.destroy();
            cacheValid = false;
        };
    }
}

export type { PickSurface, PickCameraSnapshot };
export { Picker, getWorldPoint, captureCameraSnapshot };
