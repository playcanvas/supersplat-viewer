// The compose: a fullscreen quad in the World layer's transparent sublayer that blends the
// stochastic target over the camera's target (after the skybox and opaque meshes) and writes
// its depth, so everything drawn later depth-tests against the splats. The colour transform
// the engine's own splat shader applies (gsplatOutputVS: tonemap and gamma, or the viewer's
// pass-through patch under CameraFrame) runs here, once per pixel instead of once per splat.
const composeVertexWGSL = /* wgsl */ `
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(vertex_position, 0.0, 1.0);
    return output;
}
`;

const composeFragmentWGSL = /* wgsl */ `
#include "gsplatOutputVS"

var splatColor: texture_2d<f32>;
var splatColorSampler: sampler;
var splatDepth: texture_depth_2d;
// the temporally accumulated frame (premultiplied colour, coverage), when taa ran this frame
var taaColor: texture_2d<uff>;
// x: 1 when the splat target's rows run the other way to the camera target's; y: 1 for an
// orthographic camera; z: 1 to read the taa history instead of the raw frame
uniform composeParams: vec4f;
// clip z = a * viewDepth + b over w = viewDepth (x, y), near and far (z, w): the depth view
uniform depthViewParams: vec4f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let dims = vec2i(textureDimensions(splatColor));
    var pix = vec2i(pcPosition.xy);
    if (uniform.composeParams.x > 0.5) {
        pix.y = dims.y - 1 - pix.y;
    }
    pix = clamp(pix, vec2i(0), dims - vec2i(1));

    var depth = textureLoad(splatDepth, pix, 0);
    var color: vec4f;
    if (uniform.composeParams.z > 0.5) {
        // the accumulated history: coverage in alpha, colour premultiplied by it
        color = textureLoad(taaColor, pix, 0);
        if (depth >= 1.0 && color.a > 0.001) {
            // covered by the history but no sample this frame: the depth of the nearest
            // sampled neighbour, so the pixel still occludes what is behind the splats
            depth = 1.0;
            for (var dy = -1; dy <= 1; dy++) {
                for (var dx = -1; dx <= 1; dx++) {
                    depth = min(depth, textureLoad(splatDepth, clamp(pix + vec2i(dx, dy), vec2i(0), dims - vec2i(1)), 0));
                }
            }
        }
    } else {
        #ifdef SSE_SPP_QUAD
            // the mean of each 2x2 quad, bilinearly interpolated between quad centres: the four
            // strata of the raster's thresholds average out to the splat's coverage. Empty texels
            // are transparent black, so the result is premultiplied coverage
            let size = vec2f(dims);
            let u = (vec2f(pix) - vec2f(0.5)) * 0.5;
            let q0 = floor(u);
            let f = u - q0;
            let uv = (q0 * 2.0 + vec2f(1.0)) / size;
            let step = vec2f(2.0) / size;
            let a = textureSampleLevel(splatColor, splatColorSampler, uv, 0.0);
            let b = textureSampleLevel(splatColor, splatColorSampler, uv + vec2f(step.x, 0.0), 0.0);
            let c = textureSampleLevel(splatColor, splatColorSampler, uv + vec2f(0.0, step.y), 0.0);
            let d = textureSampleLevel(splatColor, splatColorSampler, uv + step, 0.0);
            color = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            if (depth >= 1.0) {
                // no sample at this pixel but coverage from its quad: the quad's nearest depth
                let quad = (pix >> vec2u(1u)) << vec2u(1u);
                depth = min(
                    min(textureLoad(splatDepth, quad, 0), textureLoad(splatDepth, min(quad + vec2i(1, 0), dims - 1), 0)),
                    min(textureLoad(splatDepth, min(quad + vec2i(0, 1), dims - 1), 0), textureLoad(splatDepth, min(quad + vec2i(1, 1), dims - 1), 0))
                );
            }
        #else
            color = textureLoad(splatColor, pix, 0);
        #endif
    }
    if (color.a <= 0.001 || depth >= 1.0) {
        discard;
    }

    #ifdef SSE_SHOW_DEPTH
        // the nearest sample's view depth, log-spaced between near and far, as grey
        let p = uniform.depthViewParams;
        let dz = depth - p.x;
        let safeDz = select(dz, sign(dz) * 1e-9 + 1e-12, abs(dz) < 1e-9);
        let viewDepth = select(p.y / safeDz, (depth - p.y) / p.x, uniform.composeParams.y > 0.5);
        let t = clamp(log(max(viewDepth, p.z) / p.z) / log(p.w / p.z), 0.0, 1.0);
        // 24-bit fixed point across rgb (high byte in red), so a capture can read it precisely
        let fixed = floor(t * 16777215.0);
        let hi = floor(fixed / 65536.0);
        let mid = floor((fixed - hi * 65536.0) / 256.0);
        let lo = fixed - hi * 65536.0 - mid * 256.0;
        output.color = vec4f(vec3f(hi, mid, lo) / 255.0, 1.0);
        output.fragDepth = depth;
        return output;
    #endif

    // un-premultiply for the output transform, then premultiply for the blend
    let gamma = color.rgb / color.a;
    let rgb = prepareOutputFromGamma(gamma, 0.0);
    output.color = vec4f(rgb * color.a, color.a);
    output.fragDepth = depth;
    return output;
}
`;

export { composeFragmentWGSL, composeVertexWGSL };
