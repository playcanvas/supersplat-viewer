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
    SEMANTIC_TEXCOORD0,
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
            float yDist = abs(walkWorldPos.y - walk_target.y);

            float nd = xzDist / walk_radius;
            float lightFalloff = 1.0 / (1.0 + nd * nd * 8.0);

            float heightAtten = 1.0 / (1.0 + yDist * yDist * 0.02);

            float pulse = 1.0 + 0.1 * sin(walk_time * 3.0);

            float ringPhase = fract(walk_time * 0.5);
            float ringDist = abs(xzDist / walk_radius - ringPhase);
            float ring = smoothstep(0.1, 0.0, ringDist) * 0.2 * (1.0 - ringPhase);

            float intensity = (lightFalloff * heightAtten * 0.8 + ring) * pulse;

            vec3 litColor = gaussianColor.xyz * (1.0 + intensity * 3.0);
            litColor = mix(litColor, vec3(0.85, 0.92, 1.0), intensity * 0.5);

            gl_FragColor = vec4(litColor * alpha, alpha);
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
        ndc.y * linearDepth / uniform.matrix_projection[1][1],
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
            let yDist = abs(walkWorldPos.y - uniform.walk_target.y);

            let nd = xzDist / uniform.walk_radius;
            let lightFalloff = 1.0 / (1.0 + nd * nd * 8.0);

            let heightAtten = 1.0 / (1.0 + yDist * yDist * 0.02);

            let pulse = 1.0 + 0.1 * sin(uniform.walk_time * 3.0);

            let ringPhase = fract(uniform.walk_time * 0.5);
            let ringDist = abs(xzDist / uniform.walk_radius - ringPhase);
            let ring = smoothstep(0.1, 0.0, ringDist) * 0.2 * (1.0 - ringPhase);

            let intensity = (lightFalloff * heightAtten * 0.8 + ring) * pulse;

            var litColor = gc * (1.0 + intensity * 3.0);
            litColor = mix(litColor, vec3f(0.85, 0.92, 1.0), intensity * 0.5);

            output.color = vec4f(litColor * alpha, alpha);
        } else {
            output.color = vec4f(gc * alpha, alpha);
        }
    #endif

    return output;
}`;

// ── Core billboard shaders ──────────────────────────────────────────────────

const coreVS = /* glsl */`
    attribute vec3 vertex_position;

    uniform mat4 matrix_viewProjection;
    uniform mat4 walk_viewInverse;
    uniform vec3 walk_target;
    uniform vec4 viewport_size;

    varying vec2 vUV;

    void main() {
        vec3 camRight = normalize(vec3(walk_viewInverse[0][0], 0.0, walk_viewInverse[0][2]));
        vec3 up = vec3(0.0, 1.0, 0.0);

        float halfWidth = 0.0075;
        float halfHeight = 20.0;

        vec3 centerWorld = walk_target + up * vertex_position.y * halfHeight;
        vec4 centerClip = matrix_viewProjection * vec4(centerWorld, 1.0);

        float minPixelHalf = 1.0 / viewport_size.x * centerClip.w;
        float effectiveHalfWidth = max(halfWidth, minPixelHalf);

        vec3 worldPos = centerWorld + camRight * vertex_position.x * effectiveHalfWidth;

        gl_Position = matrix_viewProjection * vec4(worldPos, 1.0);
        vUV = vertex_position.xy;
    }
`;

const coreVS_WGSL = /* wgsl */`
    attribute vertex_position: vec3f;
    uniform matrix_viewProjection: mat4x4f;
    uniform walk_viewInverse: mat4x4f;
    uniform walk_target: vec3f;
    uniform viewport_size: vec4f;
    varying vUV: vec2f;

    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;

        let camRight = normalize(vec3f(uniform.walk_viewInverse[0][0], 0.0, uniform.walk_viewInverse[0][2]));
        let up = vec3f(0.0, 1.0, 0.0);

        let halfWidth = 0.0075;
        let halfHeight = 20.0;

        let centerWorld = uniform.walk_target + up * input.vertex_position.y * halfHeight;
        let centerClip = uniform.matrix_viewProjection * vec4f(centerWorld, 1.0);

        let minPixelHalf = 1.0 / uniform.viewport_size.x * centerClip.w;
        let effectiveHalfWidth = max(halfWidth, minPixelHalf);

        let worldPos = centerWorld + camRight * input.vertex_position.x * effectiveHalfWidth;

        output.position = uniform.matrix_viewProjection * vec4f(worldPos, 1.0);
        output.vUV = input.vertex_position.xy;
        return output;
    }
`;

const coreFS = /* glsl */`
    precision highp float;

    uniform float walk_time;

    varying vec2 vUV;

    void main() {
        if (abs(vUV.y) > 0.95) discard;

        float pulse = 1.0 + 0.08 * sin(walk_time * 3.0);
        vec3 color = vec3(0.85, 0.92, 1.0) * pulse;

        gl_FragColor = vec4(color, 1.0);
    }
`;

const coreFS_WGSL = /* wgsl */`
    uniform walk_time: f32;
    varying vUV: vec2f;

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;

        if (abs(input.vUV.y) > 0.95) {
            discard;
            return output;
        }

        let pulse = 1.0 + 0.08 * sin(uniform.walk_time * 3.0);
        let color = vec3f(0.85, 0.92, 1.0) * pulse;

        output.color = vec4f(color, 1.0);
        return output;
    }
`;

// ── Particle shaders ────────────────────────────────────────────────────────

const particleVS = /* glsl */`
    attribute vec3 vertex_position;
    attribute vec4 aRandomData;
    attribute vec2 aQuadCorner;

    uniform mat4 matrix_viewProjection;
    uniform mat4 walk_viewInverse;
    uniform vec3 walk_target;
    uniform float walk_time;

    varying vec2 vUV;
    varying float vBrightness;

    void main() {
        float seed = aRandomData.x;
        float speed = aRandomData.y;
        float amp = aRandomData.z;
        float phase = aRandomData.w;

        float t = walk_time;

        float dx = amp * (sin(t * 0.7 * speed + seed * 6.283)
                 + 0.5 * sin(t * 1.3 * speed + phase * 2.0));
        float dy = amp * 0.3 * sin(t * 0.5 * speed + seed * 9.42 + phase);
        float dz = amp * (sin(t * 0.9 * speed + seed * 4.189 + phase * 1.3)
                 + 0.5 * cos(t * 1.1 * speed + phase * 3.0));

        vec3 center = walk_target + vertex_position + vec3(dx, dy, dz);

        float dist = length(vertex_position.xz);
        vBrightness = 1.0 - dist / 1.5 * 0.8;

        vec3 camRight = walk_viewInverse[0].xyz;
        vec3 camUp = walk_viewInverse[1].xyz;
        float halfSize = 0.005;

        vec3 worldPos = center
                      + camRight * aQuadCorner.x * halfSize
                      + camUp * aQuadCorner.y * halfSize;

        gl_Position = matrix_viewProjection * vec4(worldPos, 1.0);
        vUV = aQuadCorner;
    }
`;

const particleVS_WGSL = /* wgsl */`
    attribute vertex_position: vec3f;
    attribute aRandomData: vec4f;
    attribute aQuadCorner: vec2f;

    uniform matrix_viewProjection: mat4x4f;
    uniform walk_viewInverse: mat4x4f;
    uniform walk_target: vec3f;
    uniform walk_time: f32;

    varying vUV: vec2f;
    varying vBrightness: f32;

    @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;

        let seed = input.aRandomData.x;
        let speed = input.aRandomData.y;
        let amp = input.aRandomData.z;
        let phase = input.aRandomData.w;

        let t = uniform.walk_time;

        let dx = amp * (sin(t * 0.7 * speed + seed * 6.283)
                 + 0.5 * sin(t * 1.3 * speed + phase * 2.0));
        let dy = amp * 0.3 * sin(t * 0.5 * speed + seed * 9.42 + phase);
        let dz = amp * (sin(t * 0.9 * speed + seed * 4.189 + phase * 1.3)
                 + 0.5 * cos(t * 1.1 * speed + phase * 3.0));

        let center = uniform.walk_target + input.vertex_position + vec3f(dx, dy, dz);

        let dist = length(input.vertex_position.xz);
        output.vBrightness = 1.0 - dist / 1.5 * 0.8;

        let camRight = uniform.walk_viewInverse[0].xyz;
        let camUp = uniform.walk_viewInverse[1].xyz;
        let halfSize = 0.005;

        let worldPos = center
                     + camRight * input.aQuadCorner.x * halfSize
                     + camUp * input.aQuadCorner.y * halfSize;

        output.position = uniform.matrix_viewProjection * vec4f(worldPos, 1.0);
        output.vUV = input.aQuadCorner;
        return output;
    }
`;

const particleFS = /* glsl */`
    precision highp float;

    varying vec2 vUV;
    varying float vBrightness;

    void main() {
        if (dot(vUV, vUV) > 1.0) discard;
        gl_FragColor = vec4(vec3(0.85, 0.92, 1.0) * vBrightness, 1.0);
    }
`;

const particleFS_WGSL = /* wgsl */`
    varying vUV: vec2f;
    varying vBrightness: f32;

    @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;

        if (dot(input.vUV, input.vUV) > 1.0) {
            discard;
            return output;
        }
        output.color = vec4f(vec3f(0.85, 0.92, 1.0) * input.vBrightness, 1.0);
        return output;
    }
`;

// ── Constants & helpers ─────────────────────────────────────────────────────

const CORE_HALF_HEIGHT = 20.0;
const PARTICLE_COUNT = 4000;
const PARTICLE_RADIUS = 1.5;

const QUAD_CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

const viewMat = new Mat4();
const invViewMat = new Mat4();

const mulberry32 = (seed: number) => {
    return () => {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
};

// ── WalkIndicator ───────────────────────────────────────────────────────────

class WalkIndicator {
    private app: AppBase;

    private target: Vec3 | null = null;

    private startTime = 0;

    private origGlsl: string;

    private origWgsl: string;

    private coreEntity: Entity;

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

        this.coreEntity = this.createCoreEntity();
        this.particleEntity = this.createParticleEntity();

        app.on('framerender', () => {
            if (this.target) {
                app.renderNextFrame = true;
            }
        });
    }

    private createCoreEntity(): Entity {
        const device = this.app.graphicsDevice;

        const mesh = new Mesh(device);
        mesh.setPositions([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3);
        mesh.setIndices([0, 1, 2, 0, 2, 3]);
        mesh.update(PRIMITIVE_TRIANGLES);

        const material = new ShaderMaterial({
            uniqueName: 'walkCoreMaterial',
            vertexGLSL: coreVS,
            fragmentGLSL: coreFS,
            vertexWGSL: coreVS_WGSL,
            fragmentWGSL: coreFS_WGSL,
            attributes: {
                vertex_position: SEMANTIC_POSITION
            }
        });
        material.blendType = BLEND_NONE;
        material.depthWrite = true;
        material.depthTest = true;
        material.cull = CULLFACE_NONE;
        material.update();

        const mi = new MeshInstance(mesh, material);
        mi.cull = false;

        const entity = new Entity('walkCore');
        entity.addComponent('render', {
            meshInstances: [mi]
        });
        entity.enabled = false;

        this.app.root.addChild(entity);
        return entity;
    }

    private createParticleEntity(): Entity {
        const device = this.app.graphicsDevice;
        const rng = mulberry32(42);

        const totalVerts = PARTICLE_COUNT * 4;
        const totalIndices = PARTICLE_COUNT * 6;

        const positions = new Float32Array(totalVerts * 3);
        const randomData = new Float32Array(totalVerts * 4);
        const corners = new Float32Array(totalVerts * 2);
        const indices = new Uint16Array(totalIndices);

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            const u = rng();
            const r = PARTICLE_RADIUS * u * u * u * u * u;
            const theta = rng() * Math.PI * 2;

            const px = r * Math.cos(theta);
            const py = (rng() * 2 - 1) * CORE_HALF_HEIGHT;
            const pz = r * Math.sin(theta);

            const proximity = 1.0 - u * u * u * u * u;
            const seed = rng();
            const speed = (0.3 + rng() * 0.7) * (1.0 + proximity * 3.0);
            const amp = (0.01 + rng() * 0.04) * (1.0 + proximity * 4.0);
            const phase = rng() * Math.PI * 2;

            const base = i * 4;
            for (let j = 0; j < 4; j++) {
                const vi = base + j;

                positions[vi * 3] = px;
                positions[vi * 3 + 1] = py;
                positions[vi * 3 + 2] = pz;

                randomData[vi * 4] = seed;
                randomData[vi * 4 + 1] = speed;
                randomData[vi * 4 + 2] = amp;
                randomData[vi * 4 + 3] = phase;

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
        mesh.setPositions(positions, 3);
        mesh.setVertexStream(SEMANTIC_TEXCOORD0, randomData, 4);
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
                aRandomData: SEMANTIC_TEXCOORD0,
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
        if (pos) {
            this.startTime = performance.now() / 1000;
        }
        this.coreEntity.enabled = !!pos;
        this.particleEntity.enabled = !!pos;
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
            const elapsed = performance.now() / 1000 - this.startTime;
            scope.resolve('walk_target').setValue([this.target.x, this.target.y, this.target.z]);
            scope.resolve('walk_radius').setValue(1.5);
            scope.resolve('walk_time').setValue(elapsed);
        } else {
            scope.resolve('walk_target').setValue([0, 0, 0]);
            scope.resolve('walk_radius').setValue(0);
            scope.resolve('walk_time').setValue(0);
        }
    }

    destroy() {
        const device = this.app.graphicsDevice;
        ShaderChunks.get(device, 'glsl').set('gsplatPS', this.origGlsl);
        ShaderChunks.get(device, 'wgsl').set('gsplatPS', this.origWgsl);
        this.coreEntity.destroy();
        this.particleEntity.destroy();
    }
}

export { WalkIndicator };
