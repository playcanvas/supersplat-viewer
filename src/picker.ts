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
const NORMAL_OUTLIER_MIN_DOT = 0.35;
const NORMAL_SAMPLE_RADII = [1, 2, 4, 8];
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

const getWorldPoint = (camera: PickCameraSnapshot, x: number, y: number, width: number, height: number, normalizedDepth: number) => {
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

    return new Vec3(vec4.x, vec4.y, vec4.z);
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
        const cacheCamera: PickCameraSnapshot = {
            position: new Vec3(),
            viewMatrix: new Mat4(),
            projectionMatrix: new Mat4(),
            nearClip: 0,
            farClip: 0,
            projection: 0
        };

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
            const cam = camera.camera;
            cacheCamera.position.copy(camera.getPosition());
            cacheCamera.viewMatrix.copy(cam.viewMatrix);
            cacheCamera.projectionMatrix.copy(cam.projectionMatrix);
            cacheCamera.nearClip = cam.nearClip;
            cacheCamera.farClip = cam.farClip;
            cacheCamera.projection = cam.projection;
            cacheWidth = width;
            cacheHeight = height;
        };

        const cameraMatches = (width: number, height: number) => {
            const cam = camera.camera;
            return cacheValid &&
                cacheWidth === width &&
                cacheHeight === height &&
                cacheCamera.position.equals(camera.getPosition()) &&
                cacheCamera.viewMatrix.equals(cam.viewMatrix) &&
                cacheCamera.projectionMatrix.equals(cam.projectionMatrix) &&
                cacheCamera.nearClip === cam.nearClip &&
                cacheCamera.farClip === cam.farClip &&
                cacheCamera.projection === cam.projection;
        };

        const getCacheCameraSnapshot = (): PickCameraSnapshot => {
            return {
                position: cacheCamera.position.clone(),
                viewMatrix: cacheCamera.viewMatrix.clone(),
                projectionMatrix: cacheCamera.projectionMatrix.clone(),
                nearClip: cacheCamera.nearClip,
                farClip: cacheCamera.farClip,
                projection: cacheCamera.projection
            };
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

        const pickPosition = async (x: number, y: number): Promise<PickPosition | null> => {
            const width = Math.floor(graphicsDevice.width);
            const height = Math.floor(graphicsDevice.height);

            // bail out if the device hasn't been sized yet
            if (width <= 0 || height <= 0) {
                return null;
            }

            const screenX = Math.min(width - 1, Math.max(0, Math.floor(x * width)));
            const screenY = Math.min(height - 1, Math.max(0, Math.floor(y * height)));
            const worldLayer = app.scene.layers.getLayerByName('World');
            if (!worldLayer) {
                return null;
            }
            const isComputeRenderer = app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_COMPUTE;

            ensureRendered(width, height, isComputeRenderer, worldLayer);
            const pickCamera = getCacheCameraSnapshot();

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
            const width = Math.floor(graphicsDevice.width);
            const height = Math.floor(graphicsDevice.height);

            if (width <= 0 || height <= 0) {
                return null;
            }

            const screenX = Math.min(width - 1, Math.max(0, Math.floor(x * width)));
            const screenY = Math.min(height - 1, Math.max(0, Math.floor(y * height)));
            const worldLayer = app.scene.layers.getLayerByName('World');
            if (!worldLayer) {
                return null;
            }
            const isComputeRenderer = app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_COMPUTE;

            ensureRendered(width, height, isComputeRenderer, worldLayer);
            const pickCamera = getCacheCameraSnapshot();

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
                    normal: setCameraFacingNormal(pickCamera.position, position, new Vec3())
                };
            }

            // Single block read serves both depth (center pixel) and normal samples (ring).
            const maxRadius = NORMAL_SAMPLE_RADII[NORMAL_SAMPLE_RADII.length - 1];
            const blockX = Math.max(0, screenX - maxRadius);
            const blockY = Math.max(0, screenY - maxRadius);
            const blockWidth = Math.min(width - 1, screenX + maxRadius) - blockX + 1;
            const blockHeight = Math.min(height - 1, screenY + maxRadius) - blockY + 1;
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

            const sampleRings = NORMAL_SAMPLE_RADII.map((radius) => {
                return NORMAL_SAMPLE_DIRECTIONS.map(([dx, dy]) => {
                    return samplePixel(screenX + dx * radius, screenY + dy * radius);
                });
            });

            const toCamera = setCameraFacingNormal(pickCamera.position, position, new Vec3());
            const candidates: Vec3[] = [];
            const va = new Vec3();
            const vb = new Vec3();
            const sampleNormal = new Vec3();

            sampleRings.forEach((points) => {
                for (let i = 0; i < NORMAL_SAMPLE_DIRECTIONS.length; i++) {
                    const pointA = points[i];
                    const pointB = points[(i + 1) % NORMAL_SAMPLE_DIRECTIONS.length];
                    if (!pointA || !pointB) {
                        continue;
                    }

                    va.sub2(pointA, position);
                    vb.sub2(pointB, position);
                    if (va.lengthSq() <= NORMAL_EPSILON || vb.lengthSq() <= NORMAL_EPSILON) {
                        continue;
                    }

                    // Direction order is clockwise in screen space. Screen Y points
                    // down, so crossing next by current gives a camera-facing normal.
                    sampleNormal.cross(vb, va);
                    if (sampleNormal.lengthSq() <= NORMAL_EPSILON) {
                        continue;
                    }

                    const candidate = sampleNormal.clone().normalize();
                    if (candidate.dot(toCamera) < 0) {
                        candidate.mulScalar(-1);
                    }
                    candidates.push(candidate);
                }
            });

            const normal = new Vec3();
            candidates.forEach((candidate) => {
                normal.add(candidate);
            });

            if (normal.lengthSq() > NORMAL_EPSILON) {
                normal.normalize();

                const refined = new Vec3();
                candidates.forEach((candidate) => {
                    if (candidate.dot(normal) >= NORMAL_OUTLIER_MIN_DOT) {
                        refined.add(candidate);
                    }
                });

                if (refined.lengthSq() > NORMAL_EPSILON) {
                    normal.copy(refined).normalize();
                }
            } else {
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
export { Picker, getWorldPoint };
