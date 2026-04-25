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
    PIXELFORMAT_RGBA8,
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

const patchGsplatPickGlsl = (chunk: string) => {
    return chunk
    .replace(
        /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/,
        '#ifdef PICK_PASS\n\t#define GSPLAT_PICK_DEPTH\n\t#include "pickPS"\n#endif'
    )
    .replace(
        'pcFragColor0 = encodePickOutput(vPickId);',
        'pcFragColor0 = getPickOutput();'
    );
};

const patchGsplatPickWgsl = (chunk: string) => {
    return chunk
    .replace(
        /#ifdef PICK_PASS\s*#include "pickPS"\s*#endif/,
        '#ifdef PICK_PASS\n\t#define GSPLAT_PICK_DEPTH\n\t#include "pickPS"\n#endif'
    )
    .replace(
        'output.color = encodePickOutput(vPickId);',
        'output.color = getPickOutput();'
    );
};

const patchedDevices = new WeakSet<object>();
const vec4 = new Vec4();
const viewProjMat = new Mat4();
const clearColor = new Color(0, 0, 0, 1);
const whiteColor = Color.WHITE;

// Shared buffers for pixel decoding.
const float32 = new Float32Array(1);
const int32 = new Int32Array(float32.buffer);
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

const patchPickChunks = (app: AppBase) => {
    const device = app.graphicsDevice;
    if (patchedDevices.has(device)) {
        return;
    }

    const glslChunks = ShaderChunks.get(device, 'glsl');
    const wgslChunks = ShaderChunks.get(device, 'wgsl');

    glslChunks.set('pickPS', pickDepthGlsl);
    wgslChunks.set('pickPS', pickDepthWgsl);

    glslChunks.set('gsplatPS', patchGsplatPickGlsl(glslChunks.get('gsplatPS')));
    wgslChunks.set('gsplatPS', patchGsplatPickWgsl(wgslChunks.get('gsplatPS')));

    patchedDevices.add(device);
};

const getWorldPoint = (camera: Entity, x: number, y: number, width: number, height: number, normalizedDepth: number) => {
    if (!Number.isFinite(normalizedDepth) || normalizedDepth < 0 || normalizedDepth > 1) {
        return null;
    }

    const cam = camera.camera;
    const near = cam.nearClip;
    const far = cam.farClip;
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

const decodeDepth = (pixels: Uint8Array): number | null => {
    const intBits = pixels[0] << 24 | pixels[1] << 16 | pixels[2] << 8 | pixels[3];
    if (intBits === 0xFFFFFFFF) {
        return null;
    }

    int32[0] = intBits;
    const depth = float32[0];
    return Number.isFinite(depth) ? depth : null;
};

class Picker {
    pick: (x: number, y: number) => Promise<Vec3 | null>;

    release: () => void;

    constructor(app: AppBase, camera: Entity) {
        const { graphicsDevice } = app;
        patchPickChunks(app);

        let colorBuffer: Texture;
        let renderTarget: RenderTarget;
        let renderPass: RenderPassPicker;

        let depthColorBuffer: Texture;
        let depthBuffer: Texture;
        let depthRenderTarget: RenderTarget;
        let depthReadRenderTarget: RenderTarget;
        let depthRenderPass: RenderPassPicker;

        const emptyMap = new Map<number, MeshInstance | GSplatComponent>();

        const initDepthAccumulation = (width: number, height: number) => {
            colorBuffer = new Texture(graphicsDevice, {
                format: PIXELFORMAT_RGBA16F,
                width,
                height,
                mipmaps: false,
                minFilter: FILTER_NEAREST,
                magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                name: 'picker'
            });

            renderTarget = new RenderTarget({
                colorBuffer,
                depth: false // not needed - gaussians are rendered back to front
            });

            renderPass = new RenderPassPicker(graphicsDevice, app.renderer);
            // RGB: additive depth accumulation. Alpha: multiplicative transmittance.
            renderPass.blendState = new BlendState(
                true,
                BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA,
                BLENDEQUATION_ADD, BLENDMODE_ZERO, BLENDMODE_ONE_MINUS_SRC_ALPHA
            );
        };

        const initDepthPick = (width: number, height: number) => {
            depthColorBuffer = Texture.createDataTexture2D(graphicsDevice, 'pick', width, height, PIXELFORMAT_RGBA8);
            depthBuffer = Texture.createDataTexture2D(graphicsDevice, 'pick-depth', width, height, PIXELFORMAT_RGBA8);

            depthRenderTarget = new RenderTarget({
                colorBuffers: [depthColorBuffer, depthBuffer],
                depth: true
            });

            depthReadRenderTarget = new RenderTarget({
                colorBuffer: depthBuffer,
                depth: false
            });

            depthRenderPass = new RenderPassPicker(graphicsDevice, app.renderer);
        };

        const readTexture = <T extends Uint8Array | Uint16Array>(
            texture: Texture,
            x: number,
            y: number,
            renderTarget: RenderTarget
        ): Promise<T> => {
            const texY = graphicsDevice.isWebGL2 ? renderTarget.height - y - 1 : y;

            return texture.read(x, texY, 1, 1, {
                renderTarget,
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

            const prevEnableIds = app.scene.gsplat.enableIds;
            app.scene.gsplat.enableIds = true;

            let normalizedDepth: number | null = null;

            try {
                if (app.scene.gsplat.currentRenderer === GSPLAT_RENDERER_COMPUTE) {
                    if (!depthRenderPass) {
                        initDepthPick(width, height);
                    } else {
                        depthRenderTarget.resize(width, height);
                        depthReadRenderTarget.resize(width, height);
                    }

                    depthRenderPass.init(depthRenderTarget);
                    depthRenderPass.setClearColor(whiteColor);
                    depthRenderPass.depthStencilOps.clearDepth = true;
                    depthRenderPass.update(camera.camera, app.scene, [worldLayer], emptyMap, true);
                    depthRenderPass.render();

                    const pixels = await readTexture<Uint8Array>(depthBuffer, screenX, screenY, depthReadRenderTarget);
                    normalizedDepth = decodeDepth(pixels);
                } else {
                    if (!renderPass) {
                        initDepthAccumulation(width, height);
                    } else {
                        renderTarget.resize(width, height);
                    }

                    renderPass.init(renderTarget);
                    renderPass.setClearColor(clearColor);
                    renderPass.update(camera.camera, app.scene, [worldLayer], emptyMap, false);
                    renderPass.render();

                    const pixels = await readTexture<Uint16Array>(colorBuffer, screenX, screenY, renderTarget);

                    const r = half2Float(pixels[0]);
                    const transmittance = half2Float(pixels[3]);
                    const alpha = 1 - transmittance;

                    if (!Number.isFinite(r) || !Number.isFinite(alpha) || alpha < 1e-6) {
                        normalizedDepth = null;
                    } else {
                        normalizedDepth = r / alpha;
                    }
                }
            } finally {
                // Pick is invoked from user dblclick events, so concurrent invocations
                // racing on enableIds are not expected in practice.
                // eslint-disable-next-line require-atomic-updates
                app.scene.gsplat.enableIds = prevEnableIds;
            }

            if (normalizedDepth === null) {
                return null;
            }

            return getWorldPoint(camera, screenX, screenY, width, height, normalizedDepth);
        };

        this.release = () => {
            renderPass?.destroy();
            renderTarget?.destroy();
            colorBuffer?.destroy();
            depthRenderPass?.destroy();
            depthRenderTarget?.destroyTextureBuffers();
            depthRenderTarget?.destroy();
            depthReadRenderTarget?.destroy();
        };
    }
}

export { Picker };
