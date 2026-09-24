/**
 * World picking for splat scenes.
 *
 * Uses a custom `pickPS` / `gsplatPS` patch for a stochastic pick pass, because the stock pick
 * pass encodes splat IDs rather than depth. Each splat fragment survives with probability equal
 * to its opacity, and a MIN blend keeps each pixel's nearest survivor, so a pixel is nearer than
 * a depth with probability equal to the scene's opacity in front of that depth, whatever order
 * the splats draw in. Surfaces are then the depth where that opacity reaches one half: faint haze
 * does not count, while enough of it layered together does.
 */

import {
    ADDRESS_CLAMP_TO_EDGE,
    BLENDEQUATION_MIN,
    BLENDMODE_ONE,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA16F,
    PROJECTION_ORTHOGRAPHIC,
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
import type { AppBase, CameraComponent, Entity, GSplatComponent, Layer, MeshInstance } from 'playcanvas';

// Override global picking to output stochastic splat depth instead of meshInstance id.
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

    uint pickHash(uint v) {
        v ^= v >> 16u;
        v *= 0x7feb352du;
        v ^= v >> 15u;
        v *= 0x846ca68bu;
        v ^= v >> 16u;
        return v;
    }

    // Four independent trials, one per channel: each keeps the fragment with probability alpha,
    // the splat's opacity at this fragment with its falloff included, writing its depth there,
    // and the far plane where it does not. A splat's depth is the same across its quad, so
    // hashing it with the pixel decorrelates the splats covering one pixel.
    vec4 getSplatPickOutput(float alpha) {
        float normalizedDepth;
        if (camera_params.w > 0.5) {
            normalizedDepth = gl_FragCoord.z;
        } else {
            float linearDepth = 1.0 / gl_FragCoord.w;
            normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
        }

        uvec2 p = uvec2(gl_FragCoord.xy);
        uint h = pickHash(p.x ^ pickHash(p.y ^ pickHash(floatBitsToUint(normalizedDepth))));
        uvec4 trials = uvec4(pickHash(h), pickHash(h ^ 0x9e3779b9u), pickHash(h ^ 0x7f4a7c15u), pickHash(h ^ 0x2545f491u));
        bvec4 keep = lessThan(vec4(trials >> 8u) * (1.0 / 16777216.0), vec4(alpha));
        if (!any(keep)) {
            discard;
        }
        return mix(vec4(1.0), vec4(normalizedDepth), vec4(keep));
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

    fn pickHash(value: u32) -> u32 {
        var v = value;
        v ^= v >> 16u;
        v *= 0x7feb352du;
        v ^= v >> 15u;
        v *= 0x846ca68bu;
        v ^= v >> 16u;
        return v;
    }

    // Four independent trials, one per channel: each keeps the fragment with probability alpha,
    // the splat's opacity at this fragment with its falloff included, writing its depth there,
    // and the far plane where it does not. A splat's depth is the same across its quad, so
    // hashing it with the pixel decorrelates the splats covering one pixel.
    fn getSplatPickOutput(alpha: f32) -> vec4f {
        var normalizedDepth: f32;
        if (uniform.camera_params.w > 0.5) {
            normalizedDepth = pcPosition.z;
        } else {
            let linearDepth = 1.0 / pcPosition.w;
            normalizedDepth = (linearDepth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        }

        let p = vec2u(pcPosition.xy);
        let h = pickHash(p.x ^ pickHash(p.y ^ pickHash(bitcast<u32>(normalizedDepth))));
        let trials = vec4u(pickHash(h), pickHash(h ^ 0x9e3779b9u), pickHash(h ^ 0x7f4a7c15u), pickHash(h ^ 0x2545f491u));
        let keep = vec4f(trials >> vec4u(8u)) * (1.0 / 16777216.0) < vec4f(alpha);
        if (!any(keep)) {
            discard;
        }
        return select(vec4f(1.0), vec4f(normalizedDepth), keep);
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

// Both pick-output calls (with and without unified ids) take the fragment's alpha, which
// `main` computes locally: the varying holds only the splat's peak opacity.
const patchGsplatPickGlsl = (chunk: string) => {
    return safeChunkReplace(
        safeChunkReplace(chunk, /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/, pickPassChunkInjected),
        /pcFragColor0 = (encodePickOutput\(vPickId\)|getPickOutput\(\));/g,
        'pcFragColor0 = getSplatPickOutput(alpha);'
    );
};

const patchGsplatPickWgsl = (chunk: string) => {
    return safeChunkReplace(
        safeChunkReplace(chunk, /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/, pickPassChunkInjected),
        /output\.color = (encodePickOutput\(vPickId\)|getPickOutput\(\));/g,
        'output.color = getSplatPickOutput(f32(alpha));'
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
// the pick pass keeps the nearest surviving depth, so it starts at the far plane
const farColor = new Color(1, 1, 1, 1);
// independent survival trials per pixel, one per channel of the pick render
const PICK_TRIALS = 4;
// A surface's depth is taken over a disc of this radius around each pick pixel (a css pixel,
// see prepareSample): each pixel is one random sample, so a single one says little. Small,
// since it also blurs edges
const SURFACE_RADIUS_PX = 2;
// A surface is where the opacity in front first reaches this. Well under one half: captured
// surfaces seen at a glancing angle, a deck or a floor, can be little more than half opaque,
// and a pick must not pass through them to whatever lies beneath
const SURFACE_OPACITY = 0.3;
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

// Shared buffer for half-to-float conversion
const float32 = new Float32Array(1);
const uint32 = new Uint32Array(float32.buffer);

// Convert 16-bit half-float to 32-bit float using bit manipulation.
const half2Float = (h: number): number => {
    const sign = (h & 0x8000) << 16;
    const exponent = (h & 0x7c00) >> 10;
    const mantissa = h & 0x03ff;

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
            uint32[0] = sign | ((127 - 15 - e) << 23) | ((m & 0x03ff) << 13);
        }
    } else if (exponent === 31) {
        uint32[0] = sign | 0x7f800000 | (mantissa << 13);
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

const getWorldPoint = (
    camera: PickCameraSnapshot,
    x: number,
    y: number,
    width: number,
    height: number,
    normalizedDepth: number,
    out?: Vec3
) => {
    if (!Number.isFinite(normalizedDepth) || normalizedDepth < 0 || normalizedDepth > 1) {
        return null;
    }

    const { farClip: far, nearClip: near } = camera;
    const ndcDepth =
        camera.projection === PROJECTION_ORTHOGRAPHIC
            ? normalizedDepth
            : (far * normalizedDepth) / (normalizedDepth * (far - near) + near);

    viewProjMat.mul2(camera.projectionMatrix, camera.viewMatrix).invert();
    vec4.set((x / width) * 2 - 1, (1 - y / height) * 2 - 1, ndcDepth * 2 - 1, 1);
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
    cx: number;
    cy: number;
    cz: number;
    vx: number;
    vy: number;
    vz: number;
};

// Project a world-space radius around `pos` to its on-screen pixel radius for
// the given camera. Uses the projection matrix's [1][1] entry (= 1/tan(fov/2)
// for perspective, = 1/orthoHeight for orthographic) so we don't need fov or
// orthoHeight on the snapshot.
const worldRadiusToPixelRadius = (
    cam: PickCameraSnapshot,
    pos: Vec3,
    canvasHeight: number,
    worldRadius: number
): number => {
    const projY = cam.projectionMatrix.data[5];
    if (cam.projection === PROJECTION_ORTHOGRAPHIC) {
        return (worldRadius * projY * canvasHeight) / 2;
    }
    const dx = pos.x - cam.position.x;
    const dy = pos.y - cam.position.y;
    const dz = pos.z - cam.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1e-6) return Infinity;
    return (worldRadius * projY * canvasHeight) / (2 * distance);
};

// Single least-squares plane fit through a cluster of 3D points. The normal
// is the eigenvector of the smallest eigenvalue of the points' 3x3 covariance
// matrix, computed in closed form (analytic eigendecomposition for 3x3
// symmetric, Smith 1961). Returns null on degenerate input.
const fitPlaneOnce = (points: Vec3[]): PlaneFit | null => {
    const n = points.length;
    if (n < 3) return null;

    let cx = 0,
        cy = 0,
        cz = 0;
    for (let i = 0; i < n; i++) {
        cx += points[i].x;
        cy += points[i].y;
        cz += points[i].z;
    }
    cx /= n;
    cy /= n;
    cz /= n;

    let cxx = 0,
        cxy = 0,
        cxz = 0,
        cyy = 0,
        cyz = 0,
        czz = 0;
    for (let i = 0; i < n; i++) {
        const dx = points[i].x - cx;
        const dy = points[i].y - cy;
        const dz = points[i].z - cz;
        cxx += dx * dx;
        cxy += dx * dy;
        cxz += dx * dz;
        cyy += dy * dy;
        cyz += dy * dz;
        czz += dz * dz;
    }

    const q = (cxx + cyy + czz) / 3;
    const a = cxx - q,
        b = cyy - q,
        c = czz - q;
    const p2 = a * a + b * b + c * c + 2 * (cxy * cxy + cxz * cxz + cyz * cyz);
    if (p2 < NORMAL_DEGENERATE_EPSILON) return null;
    const p = Math.sqrt(p2 / 6);
    const inv = 1 / p;
    const Bxx = a * inv,
        Bxy = cxy * inv,
        Bxz = cxz * inv;
    const Byy = b * inv,
        Byz = cyz * inv,
        Bzz = c * inv;
    const detB = Bxx * (Byy * Bzz - Byz * Byz) - Bxy * (Bxy * Bzz - Byz * Bxz) + Bxz * (Bxy * Byz - Byy * Bxz);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const lambdaMin = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);

    const Mxx = cxx - lambdaMin,
        Myy = cyy - lambdaMin,
        Mzz = czz - lambdaMin;
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
        vx = v1x;
        vy = v1y;
        vz = v1z;
        lSq = l1;
    } else if (l2 >= l3) {
        vx = v2x;
        vy = v2y;
        vz = v2z;
        lSq = l2;
    } else {
        vx = v3x;
        vy = v3y;
        vz = v3z;
        lSq = l3;
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
        vx = -vx;
        vy = -vy;
        vz = -vz;
    }
    outNormal.set(vx, vy, vz);
    return true;
};

class Picker {
    pick: (x: number, y: number) => Promise<Vec3 | null>;

    pickSurface: (x: number, y: number) => Promise<PickSurface | null>;

    /**
     * Estimate how opaque the scene is in front of several points, for testing many at once
     * (the annotation occlusion test): the share of the pick render's pixels, over a disc of
     * `radius` around each point, whose nearest survivor is nearer than the point's `depth`.
     * Coordinates and radius are normalised like `pick`'s (the radius to the height); `depth`
     * is the view depth to test against. Each result is 0 (nothing in front) to 1 (opaque), or
     * null where the disc is off the render.
     */
    pickVisibility: (
        points: readonly { x: number; y: number; depth: number }[],
        radius: number
    ) => Promise<(number | null)[]>;

    /**
     * Bring the pick render up to date for the current camera and return its texture, for a view
     * that reads it on the GPU (the debug panel's pick depth). Each channel is one trial's
     * nearest surviving normalised depth, 1 where nothing survived. Null before the device is
     * sized or after release.
     */
    renderView: () => Texture | null;

    release: () => void;

    constructor(app: AppBase, camera: Entity) {
        const { graphicsDevice } = app;

        let pickBuffer: Texture;
        let pickTarget: RenderTarget;
        let pickPass: RenderPassPicker;
        let chunksPatched = false;
        // set by release: queued and in-flight picks then resolve to nothing, rather than render
        // with released resources or reach an app that is being destroyed
        let released = false;
        let pickQueue = Promise.resolve();
        let cacheValid = false;
        let cacheWidth = 0;
        let cacheHeight = 0;
        const cacheCamera: PickCameraSnapshot = createPickCameraSnapshot();

        const initPickTarget = (width: number, height: number) => {
            pickBuffer = new Texture(graphicsDevice, {
                format: PIXELFORMAT_RGBA16F,
                width,
                height,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                name: 'picker-stochastic'
            });

            pickTarget = new RenderTarget({
                colorBuffer: pickBuffer,
                depth: false // not needed: the blend keeps the nearest depth
            });

            pickPass = new RenderPassPicker(graphicsDevice, app.renderer);
            // the nearest surviving depth wins, whatever order the splats draw in
            pickPass.blendState = new BlendState(
                true,
                BLENDEQUATION_MIN,
                BLENDMODE_ONE,
                BLENDMODE_ONE,
                BLENDEQUATION_MIN,
                BLENDMODE_ONE,
                BLENDMODE_ONE
            );
        };

        const updateCache = (width: number, height: number) => {
            captureCameraSnapshot(camera, cacheCamera);
            cacheWidth = width;
            cacheHeight = height;
        };

        const cameraMatches = (width: number, height: number) => {
            const cam = camera.camera;
            return (
                cacheValid &&
                cacheWidth === width &&
                cacheHeight === height &&
                cacheCamera.viewMatrix.equals(cam.viewMatrix) &&
                cacheCamera.projectionMatrix.equals(cam.projectionMatrix) &&
                cacheCamera.nearClip === cam.nearClip &&
                cacheCamera.farClip === cam.farClip &&
                cacheCamera.projection === cam.projection
            );
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

        // Read the pick render around a pixel, `margin` pixels each way, clamped to the render.
        // The accessor returns a pixel's nearest surviving normalised depth in one of its
        // PICK_TRIALS trials, 1 where no fragment survived, or null outside the block.
        const readAround = async (screenX: number, screenY: number, margin: number, width: number, height: number) => {
            const blockX = Math.max(0, screenX - margin);
            const blockY = Math.max(0, screenY - margin);
            const blockWidth = Math.min(width - 1, screenX + margin) - blockX + 1;
            const blockHeight = Math.min(height - 1, screenY + margin) - blockY + 1;
            const texY = graphicsDevice.isWebGL2 ? pickTarget.height - blockY - blockHeight : blockY;

            const pixels = (await pickBuffer.read(blockX, texY, blockWidth, blockHeight, {
                renderTarget: pickTarget,
                immediate: true
            })) as Uint16Array;

            return (x: number, y: number, trial: number) => {
                const localX = x - blockX;
                const localY = y - blockY;
                if (localX < 0 || localX >= blockWidth || localY < 0 || localY >= blockHeight) {
                    return null;
                }

                const row = graphicsDevice.isWebGL2 ? blockHeight - localY - 1 : localY;
                return half2Float(pixels[(row * blockWidth + localX) * 4 + trial]);
            };
        };

        // The surface at a pixel: the SURFACE_OPACITY quantile of the nearest survivors over a
        // small disc, which is the depth where the opacity in front reaches that. Null where it
        // never does.
        const surfaceDepth = (
            depthAt: (x: number, y: number, trial: number) => number | null,
            x: number,
            y: number
        ) => {
            const samples: number[] = [];
            for (let dy = -SURFACE_RADIUS_PX; dy <= SURFACE_RADIUS_PX; dy++) {
                for (let dx = -SURFACE_RADIUS_PX; dx <= SURFACE_RADIUS_PX; dx++) {
                    if (dx * dx + dy * dy > SURFACE_RADIUS_PX * SURFACE_RADIUS_PX) continue;
                    for (let trial = 0; trial < PICK_TRIALS; trial++) {
                        const depth = depthAt(x + dx, y + dy, trial);
                        if (depth !== null) samples.push(depth);
                    }
                }
            }
            if (samples.length === 0) {
                return null;
            }
            samples.sort((a, b) => a - b);
            const depth = samples[Math.max(0, Math.ceil(samples.length * SURFACE_OPACITY) - 1)];
            return Number.isFinite(depth) && depth < 1 ? depth : null;
        };

        const ensureRendered = (width: number, height: number, worldLayer: Layer) => {
            if (cameraMatches(width, height)) {
                return;
            }

            // Enable gsplat IDs only while rendering the pick target so we
            // don't pay the memory/perf cost between pick passes.
            const prevEnableIds = app.scene.gsplat.enableIds;
            app.scene.gsplat.enableIds = true;
            try {
                if (!chunksPatched) {
                    registerPickerShaderPatches(app);
                    chunksPatched = true;
                }

                if (!pickPass) {
                    initPickTarget(width, height);
                } else if (cacheWidth !== width || cacheHeight !== height) {
                    cacheValid = false;
                    pickTarget.resize(width, height);
                }

                pickPass.init(pickTarget);
                pickPass.setClearColor(farColor);
                pickPass.update(
                    camera.camera,
                    app.scene,
                    [worldLayer],
                    new Map<number, MeshInstance | GSplatComponent>(),
                    false
                );
                pickPass.render();

                updateCache(width, height);
                cacheValid = true;
            } finally {
                app.scene.gsplat.enableIds = prevEnableIds;
            }
        };

        const prepareSample = (x: number, y: number) => {
            if (released) {
                return null;
            }

            // One pick pixel per css pixel, never more than the backbuffer has: picking then
            // behaves the same in performance mode and at any device pixel ratio, since the
            // pixel sizes above are css pixels, and a high-density display does not multiply
            // the pass's cost
            const canvas = graphicsDevice.canvas as HTMLCanvasElement;
            const width = Math.min(Math.floor(graphicsDevice.width), Math.round(canvas.clientWidth));
            const height = Math.min(Math.floor(graphicsDevice.height), Math.round(canvas.clientHeight));

            // bail out if the device or the canvas hasn't been sized yet
            if (width <= 0 || height <= 0) {
                return null;
            }

            const worldLayer = app.scene.layers.getLayerByName('World');
            if (!worldLayer) {
                return null;
            }

            const screenX = Math.min(width - 1, Math.max(0, Math.floor(x * width)));
            const screenY = Math.min(height - 1, Math.max(0, Math.floor(y * height)));

            ensureRendered(width, height, worldLayer);
            const pickCamera = getCacheCameraSnapshot();

            return { width, height, screenX, screenY, pickCamera };
        };

        // `fallback` is the result for a pick that release overtakes: one queued behind another
        // pick, or one whose read-back is cut short as the device goes
        const serializePick = <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
            const guarded = (): Promise<T> => {
                if (released) {
                    return Promise.resolve(fallback);
                }
                return operation().catch((error: unknown) => {
                    if (released) {
                        return fallback;
                    }
                    throw error;
                });
            };
            // The render target is shared by all picks on this instance.
            const result = pickQueue.then(guarded, guarded);
            pickQueue = result.then(
                (): void => undefined,
                (): void => undefined
            );
            return result;
        };

        const pick = async (x: number, y: number) => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, pickCamera } = sample;

            const depthAt = await readAround(screenX, screenY, SURFACE_RADIUS_PX, width, height);
            const depth = surfaceDepth(depthAt, screenX, screenY);
            return depth === null ? null : getWorldPoint(pickCamera, screenX, screenY, width, height, depth);
        };

        const pickSurface = async (x: number, y: number) => {
            const sample = prepareSample(x, y);
            if (!sample) {
                return null;
            }
            const { width, height, screenX, screenY, pickCamera } = sample;

            // Single block read serves both the depth (center pixel) and the normal samples.
            // Sized to the maximum possible ring pixel-radius, plus the surface disc around each
            // sample, so the dynamic ring offsets always lie inside the buffer we read.
            const depthAt = await readAround(screenX, screenY, NORMAL_SAMPLE_MAX_PX + SURFACE_RADIUS_PX, width, height);
            const surfacePoint = (px: number, py: number) => {
                const depth = surfaceDepth(depthAt, px, py);
                return depth === null ? null : getWorldPoint(pickCamera, px, py, width, height, depth);
            };

            const position = surfacePoint(screenX, screenY);
            if (!position) {
                return null;
            }

            const samplePixel = (px: number, py: number) => {
                if (px < 0 || px >= width || py < 0 || py >= height) {
                    return null;
                }
                return surfacePoint(px, py);
            };

            // Pixel radius corresponding to a fixed world radius at the
            // picked-point's depth. Clamped so distant picks still sample
            // enough pixels and very-close picks stay inside the block read.
            const pixelRadius = Math.max(
                NORMAL_SAMPLE_MIN_PX,
                Math.min(
                    NORMAL_SAMPLE_MAX_PX,
                    worldRadiusToPixelRadius(pickCamera, position, height, NORMAL_SAMPLE_WORLD_RADIUS)
                )
            );
            const ringPixelRadii = NORMAL_RING_FRACTIONS.map((f) => Math.max(1, Math.round(f * pixelRadius)));
            const sampleRings = ringPixelRadii.map((radius) => {
                return NORMAL_SAMPLE_DIRECTIONS.map(([dx, dy]) => {
                    return samplePixel(screenX + dx * radius, screenY + dy * radius);
                });
            });

            const toCamera = setCameraFacingNormal(pickCamera.position, position, new Vec3());

            // Collect every valid 3D sample: the picked position plus all ring
            // samples that didn't fall off-screen or find no surface.
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

        const pickVisibility = async (points: readonly { x: number; y: number; depth: number }[], radius: number) => {
            if (points.length === 0) {
                return [];
            }
            // every point renders from the same cached pass, since the camera cannot change
            // between these synchronous calls; the reads then run in parallel
            return Promise.all(
                points.map(async ({ x, y, depth }) => {
                    const sample = prepareSample(x, y);
                    if (!sample) {
                        return null;
                    }
                    const { width, height, screenX, screenY, pickCamera } = sample;

                    const r = Math.max(1, Math.round(radius * height));
                    const depthAt = await readAround(screenX, screenY, r, width, height);
                    const threshold = (depth - pickCamera.nearClip) / (pickCamera.farClip - pickCamera.nearClip);

                    let total = 0;
                    let inFront = 0;
                    for (let dy = -r; dy <= r; dy++) {
                        for (let dx = -r; dx <= r; dx++) {
                            if (dx * dx + dy * dy > r * r) continue;
                            for (let trial = 0; trial < PICK_TRIALS; trial++) {
                                const nearest = depthAt(screenX + dx, screenY + dy, trial);
                                if (nearest === null) continue;
                                total++;
                                if (nearest < threshold) inFront++;
                            }
                        }
                    }
                    return total > 0 ? inFront / total : null;
                })
            );
        };

        this.pick = (x: number, y: number) => serializePick(() => pick(x, y), null);

        this.pickSurface = (x: number, y: number) => serializePick(() => pickSurface(x, y), null);

        this.pickVisibility = (points, radius) =>
            serializePick(
                () => pickVisibility(points, radius),
                points.map((): null => null)
            );

        this.renderView = () => (prepareSample(0, 0) ? pickBuffer : null);

        // The scene can change under a still camera, which the camera-based cache cannot see:
        // finer detail streams in after the reveal and after every move. The engine reports each
        // frame whether all the detail it wants is resident, so the cached render is stale on
        // every frame it is not, and once more when it becomes so. Nothing re-renders until a
        // pick needs it.
        const gsplatSystem = app.systems.gsplat;
        let contentReady = false;
        const onFrameReady = (frameCamera: CameraComponent, _layer: unknown, ready: boolean) => {
            if (frameCamera !== camera.camera) return;
            if (!ready || !contentReady) {
                cacheValid = false;
            }
            contentReady = ready;
        };
        gsplatSystem.on('frame:ready', onFrameReady);

        this.release = () => {
            released = true;
            gsplatSystem.off('frame:ready', onFrameReady);
            if (chunksPatched) {
                unregisterPickerShaderPatches(app);
                chunksPatched = false;
            }
            pickPass?.destroy();
            pickTarget?.destroy();
            pickBuffer?.destroy();
            cacheValid = false;
        };
    }
}

export type { PickSurface, PickCameraSnapshot };
export { Picker, getWorldPoint, captureCameraSnapshot, PICK_TRIALS, SURFACE_RADIUS_PX, SURFACE_OPACITY };
