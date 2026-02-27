import {
    type AppBase,
    type Entity,
    Mat4,
    ShaderChunks,
    Vec3
} from 'playcanvas';

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

            float columnFade = 1.0 - smoothstep(walk_radius * 0.6, walk_radius, xzDist);

            float ringPhase = fract(walk_time * 0.5);
            float ringDist = abs(xzDist / walk_radius - ringPhase);
            float ring = smoothstep(0.12, 0.0, ringDist) * 0.4;

            float glow = (columnFade * 0.3 + ring) * alpha;

            vec3 glowColor = mix(vec3(0.2, 0.6, 1.0), vec3(1.0), 0.3);
            gl_FragColor = vec4(gaussianColor.xyz * alpha + glowColor * glow, alpha);
        } else {
            gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);
        }
    #endif
}
`;

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

            let columnFade = 1.0 - smoothstep(uniform.walk_radius * 0.6, uniform.walk_radius, xzDist);

            let ringPhase = fract(uniform.walk_time * 0.5);
            let ringDist = abs(xzDist / uniform.walk_radius - ringPhase);
            let ring = smoothstep(0.12, 0.0, ringDist) * 0.4;

            let glow = (columnFade * 0.3 + ring) * alpha;

            let glowColor = mix(vec3f(0.2, 0.6, 1.0), vec3f(1.0), 0.3);
            output.color = vec4f(gc * alpha + glowColor * glow, alpha);
        } else {
            output.color = vec4f(gc * alpha, alpha);
        }
    #endif

    return output;
}`;

const viewMat = new Mat4();
const invViewMat = new Mat4();

class WalkIndicator {
    private app: AppBase;

    private target: Vec3 | null = null;

    private startTime = 0;

    private origGlsl: string;

    private origWgsl: string;

    constructor(app: AppBase) {
        this.app = app;
        const device = app.graphicsDevice;

        const glsl = ShaderChunks.get(device, 'glsl');
        const wgsl = ShaderChunks.get(device, 'wgsl');

        this.origGlsl = glsl.get('gsplatPS');
        this.origWgsl = wgsl.get('gsplatPS');

        glsl.set('gsplatPS', gsplatPSGlsl);
        wgsl.set('gsplatPS', gsplatPSWgsl);
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
            this.app.renderNextFrame = true;
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
    }
}

export { WalkIndicator };
