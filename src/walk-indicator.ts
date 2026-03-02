import {
    type AppBase,
    BLEND_NONE,
    CULLFACE_NONE,
    Entity,
    Mat4,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD1,
    ShaderChunks,
    ShaderMaterial,
    Vec3
} from 'playcanvas';

// ── gsplat fragment shader overrides (GLSL) ─────────────────────────────────

const gsplatPSGlsl = /* glsl */`

#ifndef DITHER_NONE
    #include "bayerPS"
    #include "opacityDitherPS"
    varying float id;
#endif

#if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
    uniform float alphaClip;
#endif

#ifdef PREPASS_PASS
    varying float vLinearDepth;
    #include "floatAsUintPS"
#endif

varying mediump vec2 gaussianUV;
varying mediump vec4 gaussianColor;

#if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
    flat varying uint vPickId;
#endif

#ifdef PICK_PASS
    #include "pickPS"
#endif

#ifndef PICK_PASS
uniform vec4 camera_params;
#endif
uniform vec4 viewport_size;
uniform mat4 matrix_projection;

uniform mat4 walk_viewInverse;
uniform vec3 walk_target;
uniform float walk_radius;
uniform float walk_time;

float walkLinearizeDepth(float z) {
    if (camera_params.w == 0.0)
        return (camera_params.z * camera_params.y) /
               (camera_params.y + z * (camera_params.z - camera_params.y));
    else
        return camera_params.z + z * (camera_params.y - camera_params.z);
}

vec3 walkReconstructWorldPos() {
    float linearDepth = walkLinearizeDepth(gl_FragCoord.z);
    vec2 ndc = gl_FragCoord.xy * viewport_size.zw * 2.0 - 1.0;
    vec3 viewPos = vec3(
        ndc.x * linearDepth / matrix_projection[0][0],
        ndc.y * linearDepth / matrix_projection[1][1],
        -linearDepth
    );
    return (walk_viewInverse * vec4(viewPos, 1.0)).xyz;
}

const float EXP4 = exp(-4.0);
const float INV_EXP4 = 1.0 / (1.0 - EXP4);

float normExp(float x) {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

void main(void) {
    mediump float A = dot(gaussianUV, gaussianUV);
    if (A > 1.0) {
        discard;
    }

    mediump float alpha = normExp(A) * gaussianColor.a;

    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (alpha < alphaClip) {
            discard;
        }
    #endif

    #ifdef PICK_PASS

        #ifdef GSPLAT_UNIFIED_ID
            pcFragColor0 = encodePickOutput(vPickId);
        #else
            pcFragColor0 = getPickOutput();
        #endif
        #ifdef DEPTH_PICK_PASS
            pcFragColor1 = getPickDepth();
        #endif

    #elif SHADOW_PASS

        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);

    #elif PREPASS_PASS

        gl_FragColor = float2vec4(vLinearDepth);

    #else
        if (alpha < 1.0 / 255.0) {
            discard;
        }

        #ifndef DITHER_NONE
            opacityDither(alpha, id * 0.013);
        #endif

        if (walk_radius > 0.0) {
            vec3 walkWorldPos = walkReconstructWorldPos();
            float xzDist = length(walkWorldPos.xz - walk_target.xz);

            float nd = xzDist / walk_radius;
            float lightFalloff = 1.0 / (1.0 + nd * nd * 8.0);
            float coreBoost = 1.0 / (1.0 + nd * nd * 200.0);

            float pulse = 1.0 + 0.1 * sin(walk_time * 3.0);

            float ringPhase = fract(walk_time * 0.5);
            float ringPos = nd - ringPhase;
            float ringFade = 1.0 - ringPhase;
            float crest = smoothstep(0.1, 0.0, abs(ringPos)) * 1.0 * ringFade * (1.0 + lightFalloff);
            float trough = smoothstep(0.25, 0.0, abs(ringPos + 0.15)) * -1.0 * ringFade;
            float ring = crest + trough;

            float intensity = (lightFalloff * 0.8 + coreBoost * 1.5 + ring) * pulse;

            float lum = dot(gaussianColor.rgb, vec3(0.299, 0.587, 0.114));
            float adaptiveIntensity = intensity * (1.0 - lum * 0.7);
            vec3 litColor = gaussianColor.xyz * (1.0 + vec3(0.85, 0.92, 1.0) * adaptiveIntensity);
            float spatialFalloff = normExp(A);
            float boostedBase = mix(gaussianColor.a, 1.0, min(intensity * 0.3, 1.0));
            float glowAlpha = spatialFalloff * boostedBase;

            gl_FragColor = vec4(litColor * glowAlpha, glowAlpha);
        } else {
            gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);
        }
    #endif
}
`;

// ── gsplat fragment shader overrides (WGSL) ─────────────────────────────────

const gsplatPSWgsl = /* wgsl */`

#ifndef DITHER_NONE
    #include "bayerPS"
    #include "opacityDitherPS"
    varying id: f32;
#endif

#if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
    uniform alphaClip: f32;
#endif

#ifdef PREPASS_PASS
    varying vLinearDepth: f32;
    #include "floatAsUintPS"
#endif

const EXP4_F: f32 = exp(-4.0);
const INV_EXP4_F: f32 = 1.0 / (1.0 - EXP4_F);

fn normExp(x: f32) -> f32 {
    return (exp(x * -4.0) - EXP4_F) * INV_EXP4_F;
}

varying gaussianUV: vec2f;
varying gaussianColor: vec4f;

#if defined(GSPLAT_UNIFIED_ID) && defined(PICK_PASS)
    varying @interpolate(flat) vPickId: u32;
#endif

#ifdef PICK_PASS
    #include "pickPS"
#endif

uniform walk_viewInverse: mat4x4f;
uniform walk_target: vec3f;
uniform walk_radius: f32;
uniform walk_time: f32;

fn walkLinearizeDepth(z: f32) -> f32 {
    if (uniform.camera_params.w == 0.0) {
        return (uniform.camera_params.z * uniform.camera_params.y) /
               (uniform.camera_params.y + z * (uniform.camera_params.z - uniform.camera_params.y));
    } else {
        return uniform.camera_params.z + z * (uniform.camera_params.y - uniform.camera_params.z);
    }
}

fn walkReconstructWorldPos(fragCoord: vec4f) -> vec3f {
    let linearDepth = walkLinearizeDepth(fragCoord.z);
    let ndc = fragCoord.xy * uniform.viewport_size.zw * 2.0 - 1.0;
    let viewPos = vec3f(
        ndc.x * linearDepth / uniform.matrix_projection[0][0],
        -ndc.y * linearDepth / uniform.matrix_projection[1][1],
        -linearDepth
    );
    return (uniform.walk_viewInverse * vec4f(viewPos, 1.0)).xyz;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;

    let A: f32 = f32(dot(gaussianUV, gaussianUV));
    if (A > 1.0) {
        discard;
        return output;
    }

    var alpha: f32 = normExp(A) * f32(gaussianColor.a);

    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (alpha < uniform.alphaClip) {
            discard;
            return output;
        }
    #endif

    #ifdef PICK_PASS

        #ifdef GSPLAT_UNIFIED_ID
            output.color = encodePickOutput(vPickId);
        #else
            output.color = getPickOutput();
        #endif
        #ifdef DEPTH_PICK_PASS
            output.color1 = getPickDepth();
        #endif

    #elif SHADOW_PASS

        output.color = vec4f(0.0, 0.0, 0.0, 1.0);

    #elif PREPASS_PASS

        output.color = float2vec4(vLinearDepth);

    #else

        if (alpha < 1.0 / 255.0) {
            discard;
            return output;
        }

        #ifndef DITHER_NONE
            opacityDither(alpha, id * 0.013);
        #endif

        let gc = vec3f(gaussianColor.xyz);

        if (uniform.walk_radius > 0.0) {
            let walkWorldPos = walkReconstructWorldPos(pcPosition);
            let xzDist = length(walkWorldPos.xz - uniform.walk_target.xz);

            let nd = xzDist / uniform.walk_radius;
            let lightFalloff = 1.0 / (1.0 + nd * nd * 8.0);
            let coreBoost = 1.0 / (1.0 + nd * nd * 200.0);

            let pulse = 1.0 + 0.1 * sin(uniform.walk_time * 3.0);

            let ringPhase = fract(uniform.walk_time * 0.5);
            let ringPos = nd - ringPhase;
            let ringFade = 1.0 - ringPhase;
            let crest = smoothstep(0.1, 0.0, abs(ringPos)) * 1.0 * ringFade * (1.0 + lightFalloff);
            let trough = smoothstep(0.25, 0.0, abs(ringPos + 0.15)) * -1.0 * ringFade;
            let ring = crest + trough;

            let intensity = (lightFalloff * 0.8 + coreBoost * 1.5 + ring) * pulse;

            let lum = dot(gc, vec3f(0.299, 0.587, 0.114));
            let adaptiveIntensity = intensity * (1.0 - lum * 0.7);
            let litColor = gc * (1.0 + vec3f(0.85, 0.92, 1.0) * adaptiveIntensity);
            let spatialFalloff = normExp(A);
            let boostedBase = mix(f32(gaussianColor.a), 1.0, min(intensity * 0.3, 1.0));
            let glowAlpha = spatialFalloff * boostedBase;

            output.color = vec4f(litColor * glowAlpha, glowAlpha);
        } else {
            output.color = vec4f(gc * alpha, alpha);
        }
    #endif

    return output;
}`;

// ── Particle shaders ────────────────────────────────────────────────────────

const particleVS = /* glsl */`
    attribute vec3 vertex_position;
    attribute vec2 aQuadCorner;

    uniform mat4 matrix_viewProjection;
    uniform mat4 walk_viewInverse;
    uniform vec3 walk_target;
    uniform float walk_time;

    varying vec2 vUV;
    varying float vFade;

    void main() {
        float rand0 = vertex_position.x;
        float rand1 = vertex_position.y;
        float rand2 = vertex_position.z;

        float baseAngle = rand0 * 6.28318530718;
        float rBase = sqrt(rand2) * 0.4;
        float r = rBase * smoothstep(0.0, 0.5, walk_time);

        float riseSpeed = 0.3 + rand2 * 0.4;
        float t = fract(max(walk_time - rand1 * 2.0, 0.0) * riseSpeed);
        float y = t * t * 1.5 - 0.1;

        float swirl = baseAngle + t * (0.5 + rand1);
        float swirlR = r + 0.01;
        vec3 center = walk_target + vec3(swirlR * cos(swirl), y, swirlR * sin(swirl));

        vec3 camRight = walk_viewInverse[0].xyz;
        vec3 camUp = walk_viewInverse[1].xyz;
        float halfSize = 0.00625;

        vec3 worldPos = center
                      + camRight * aQuadCorner.x * halfSize
                      + camUp * aQuadCorner.y * halfSize;

        gl_Position = matrix_viewProjection * vec4(worldPos, 1.0);
        vUV = aQuadCorner;
        float maxT = 1.0 - rBase;
        vFade = smoothstep(0.0, 0.1, t) * smoothstep(maxT, maxT - 0.15, t);
    }
`;

const particleVS_WGSL = /* wgsl */`
    attribute vertex_position: vec3f;
    attribute aQuadCorner: vec2f;

    uniform matrix_viewProjection: mat4x4f;
    uniform walk_viewInverse: mat4x4f;
    uniform walk_target: vec3f;
    uniform walk_time: f32;

    varying vUV: vec2f;
    varying vFade: f32;

    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;

        let rand0 = input.vertex_position.x;
        let rand1 = input.vertex_position.y;
        let rand2 = input.vertex_position.z;

        let baseAngle = rand0 * 6.28318530718;
        let rBase = sqrt(rand2) * 0.4;
        let r = rBase * smoothstep(0.0, 0.5, uniform.walk_time);

        let riseSpeed = 0.3 + rand2 * 0.4;
        let t = fract(max(uniform.walk_time - rand1 * 2.0, 0.0) * riseSpeed);
        let y = t * t * 1.5 - 0.1;

        let swirl = baseAngle + t * (0.5 + rand1);
        let swirlR = r + 0.01;
        let center = uniform.walk_target + vec3f(swirlR * cos(swirl), y, swirlR * sin(swirl));

        let camRight = uniform.walk_viewInverse[0].xyz;
        let camUp = uniform.walk_viewInverse[1].xyz;
        let halfSize = 0.00625;

        let worldPos = center
                     + camRight * input.aQuadCorner.x * halfSize
                     + camUp * input.aQuadCorner.y * halfSize;

        output.position = uniform.matrix_viewProjection * vec4f(worldPos, 1.0);
        output.vUV = input.aQuadCorner;
        let maxT = 1.0 - rBase;
        output.vFade = smoothstep(0.0, 0.1, t) * smoothstep(maxT, maxT - 0.15, t);
        return output;
    }
`;

const particleFS = /* glsl */`
    precision highp float;

    varying vec2 vUV;
    varying float vFade;

    void main() {
        float r = length(vUV);
        if (r > 1.0 || vFade < 0.5) discard;
        gl_FragColor = vec4(2.55, 2.76, 3.0, 1.0);
    }
`;

const particleFS_WGSL = /* wgsl */`
    varying vUV: vec2f;
    varying vFade: f32;

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;

        let r = length(input.vUV);
        if (r > 1.0 || input.vFade < 0.5) {
            discard;
            return output;
        }
        output.color = vec4f(2.55, 2.76, 3.0, 1.0);
        return output;
    }
`;

// ── Constants & helpers ─────────────────────────────────────────────────────

const PARTICLE_COUNT = 250;

const QUAD_CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

const viewMat = new Mat4();
const invViewMat = new Mat4();
const targetVec = new Float32Array(3);

const mulberry32 = (seed: number) => {
    return () => {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
};

// ── WalkIndicator ───────────────────────────────────────────────────────────

class WalkIndicator {
    private app: AppBase;

    private target: Vec3 | null = null;

    private startTime = 0;

    private visible = false;

    private origGlsl: string;

    private origWgsl: string;

    private particleEntity: Entity;

    constructor(app: AppBase) {
        this.app = app;
        const device = app.graphicsDevice;

        const glsl = ShaderChunks.get(device, 'glsl');
        const wgsl = ShaderChunks.get(device, 'wgsl');

        this.origGlsl = glsl.get('gsplatPS');
        this.origWgsl = wgsl.get('gsplatPS');

        glsl.set('gsplatPS', gsplatPSGlsl);
        wgsl.set('gsplatPS', gsplatPSWgsl);

        this.particleEntity = this.createParticleEntity();

        app.on('framerender', () => {
            if (this.target && this.visible) {
                app.renderNextFrame = true;
            }
        });
    }

    private createParticleEntity(): Entity {
        const device = this.app.graphicsDevice;
        const rng = mulberry32(42);

        const totalVerts = PARTICLE_COUNT * 4;
        const totalIndices = PARTICLE_COUNT * 6;

        const particleData = new Float32Array(totalVerts * 3);
        const corners = new Float32Array(totalVerts * 2);
        const indices = new Uint16Array(totalIndices);

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const rand0 = i / PARTICLE_COUNT;
            const rand1 = rng();
            const rand2 = rng();

            const base = i * 4;
            for (let j = 0; j < 4; j++) {
                const vi = base + j;

                particleData[vi * 3] = rand0;
                particleData[vi * 3 + 1] = rand1;
                particleData[vi * 3 + 2] = rand2;

                corners[vi * 2] = QUAD_CORNERS[j * 2];
                corners[vi * 2 + 1] = QUAD_CORNERS[j * 2 + 1];
            }

            const ii = i * 6;
            indices[ii] = base;
            indices[ii + 1] = base + 1;
            indices[ii + 2] = base + 2;
            indices[ii + 3] = base;
            indices[ii + 4] = base + 2;
            indices[ii + 5] = base + 3;
        }

        const mesh = new Mesh(device);
        mesh.setPositions(particleData, 3);
        mesh.setVertexStream(SEMANTIC_TEXCOORD1, corners, 2);
        mesh.setIndices(indices);
        mesh.update(PRIMITIVE_TRIANGLES);

        const material = new ShaderMaterial({
            uniqueName: 'walkParticleMaterial',
            vertexGLSL: particleVS,
            fragmentGLSL: particleFS,
            vertexWGSL: particleVS_WGSL,
            fragmentWGSL: particleFS_WGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                aQuadCorner: SEMANTIC_TEXCOORD1
            }
        });
        material.blendType = BLEND_NONE;
        material.depthWrite = true;
        material.depthTest = true;
        material.cull = CULLFACE_NONE;
        material.update();

        const mi = new MeshInstance(mesh, material);
        mi.cull = false;

        const entity = new Entity('walkParticles');
        entity.addComponent('render', {
            meshInstances: [mi]
        });
        entity.enabled = false;

        this.app.root.addChild(entity);
        return entity;
    }

    /**
     * Set or clear the walk target position.
     *
     * @param pos - World-space target position, or null to clear.
     */
    setTarget(pos: Vec3 | null) {
        this.target = pos ? pos.clone() : null;
        this.visible = !!pos;
        if (pos) {
            this.startTime = performance.now() / 1000;
        }
        this.particleEntity.enabled = this.visible;
        this.app.renderNextFrame = true;
    }

    /**
     * Update uniforms for the walk highlight effect. Call from a prerender hook.
     *
     * @param camera - The camera entity used for rendering.
     */
    update(camera: Entity) {
        const device = this.app.graphicsDevice;
        const scope = device.scope;
        const cam = camera.camera;

        viewMat.copy(cam.viewMatrix);
        invViewMat.copy(viewMat).invert();

        scope.resolve('walk_viewInverse').setValue(invViewMat.data);

        if (this.target) {
            const camPos = camera.getPosition();
            const dist = camPos.distance(this.target);
            this.visible = dist > 2.0;

            this.particleEntity.enabled = this.visible;

            const elapsed = performance.now() / 1000 - this.startTime;
            targetVec[0] = this.target.x;
            targetVec[1] = this.target.y;
            targetVec[2] = this.target.z;
            scope.resolve('walk_target').setValue(targetVec);
            scope.resolve('walk_radius').setValue(this.visible ? 1.5 : 0);
            scope.resolve('walk_time').setValue(elapsed);
        } else {
            targetVec[0] = 0;
            targetVec[1] = 0;
            targetVec[2] = 0;
            scope.resolve('walk_target').setValue(targetVec);
            scope.resolve('walk_radius').setValue(0);
            scope.resolve('walk_time').setValue(0);
        }
    }

    destroy() {
        const device = this.app.graphicsDevice;
        ShaderChunks.get(device, 'glsl').set('gsplatPS', this.origGlsl);
        ShaderChunks.get(device, 'wgsl').set('gsplatPS', this.origWgsl);
        this.particleEntity.destroy();
    }
}

export { WalkIndicator };
