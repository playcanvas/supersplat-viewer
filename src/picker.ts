/**
 * Double-click world picking for splat scenes.
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

const getWorldPoint = (camera: Entity, x: number, y: number, width: number, height: number, normalizedDepth: number) => {
    if (!Number.isFinite(normalizedDepth) || normalizedDepth < 0 || normalizedDepth > 1) {
        return null;
    }

    const cam = camera.camera;
    const far = cam.farClip;
    const near = cam.nearClip;
    const ndcDepth = cam.projection === PROJECTION_ORTHOGRAPHIC ?
        normalizedDepth :
        far * normalizedDepth / (normalizedDepth * (far - near) + near);

    viewProjMat.mul2(cam.projectionMatrix, cam.viewMatrix).invert();
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

class Picker {
    pick: (x: number, y: number) => Promise<Vec3 | null>;

    release: () => void;

    constructor(app: AppBase, camera: Entity) {
        const { graphicsDevice } = app;

        let enginePicker: EnginePicker | undefined;
        let accumBuffer: Texture;
        let accumTarget: RenderTarget;
        let accumPass: RenderPassPicker;

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

        this.pick = async (x: number, y: number) => {
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

            // enable gsplat IDs only for the duration of the pick so we don't pay the
            // memory/perf cost between picks (picker instances are typically long-lived).
            const prevEnableIds = app.scene.gsplat.enableIds;
            app.scene.gsplat.enableIds = true;

            try {
                if (app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_COMPUTE) {
                    enginePicker ??= new EnginePicker(app, 1, 1, true);
                    enginePicker.resize(width, height);
                    enginePicker.prepare(camera.camera, app.scene, [worldLayer]);
                    return await enginePicker.getWorldPointAsync(screenX, screenY);
                }

                registerPickerShaderPatches(app);

                if (!accumPass) {
                    initRasterAccum(width, height);
                } else {
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

                const pixels = await readTexture<Uint16Array>(accumBuffer, screenX, screenY, accumTarget);

                const r = half2Float(pixels[0]);
                const transmittance = half2Float(pixels[3]);
                const alpha = 1 - transmittance;

                if (!Number.isFinite(r) || !Number.isFinite(alpha) || alpha < 1e-6) {
                    return null;
                }

                const normalizedDepth = r / alpha;
                return getWorldPoint(camera, screenX, screenY, width, height, normalizedDepth);
            } finally {
                // Pick is only invoked from user dblclick events, so concurrent invocations
                // (which would race on enableIds) aren't a concern in practice.
                // eslint-disable-next-line require-atomic-updates
                app.scene.gsplat.enableIds = prevEnableIds;
            }
        };

        this.release = () => {
            unregisterPickerShaderPatches(app);
            enginePicker?.destroy();
            accumPass?.destroy();
            accumTarget?.destroy();
            accumBuffer?.destroy();
        };
    }
}

export { Picker };
