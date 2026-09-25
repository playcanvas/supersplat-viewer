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
// x: 1 when the splat target's rows run the other way to the camera target's
uniform composeParams: vec4f;

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
        let color = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        if (depth >= 1.0) {
            // no sample at this pixel but coverage from its quad: the quad's nearest depth
            let quad = (pix >> vec2u(1u)) << vec2u(1u);
            depth = min(
                min(textureLoad(splatDepth, quad, 0), textureLoad(splatDepth, min(quad + vec2i(1, 0), dims - 1), 0)),
                min(textureLoad(splatDepth, min(quad + vec2i(0, 1), dims - 1), 0), textureLoad(splatDepth, min(quad + vec2i(1, 1), dims - 1), 0))
            );
        }
    #else
        let color = textureLoad(splatColor, pix, 0);
    #endif
    if (color.a <= 0.0 || depth >= 1.0) {
        discard;
    }

    // un-premultiply for the output transform, then premultiply for the blend
    let gamma = color.rgb / color.a;
    let rgb = prepareOutputFromGamma(gamma, 0.0);
    output.color = vec4f(rgb * color.a, color.a);
    output.fragDepth = depth;
    return output;
}
`;

export { composeFragmentWGSL, composeVertexWGSL };
