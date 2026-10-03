// Variant coverage:interleaved: the four pixel sets' targets, each the full target's pixels of
// one position in the 2x2 quad, copied back into the full target texel for texel, colour and
// depth, so the compose and the occlusion grid read one ordinary frame. Only without taa: the
// accumulation reads the sets itself and writes their depth (shaders/taa.ts).
const interleaveFragmentWGSL = /* wgsl */ `
var setColor0: texture_2d<f32>;
var setColor1: texture_2d<f32>;
var setColor2: texture_2d<f32>;
var setColor3: texture_2d<f32>;
var setDepth0: texture_depth_2d;
var setDepth1: texture_depth_2d;
var setDepth2: texture_depth_2d;
var setDepth3: texture_depth_2d;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let pix = vec2i(pcPosition.xy);
    let texel = pix >> vec2u(1u);
    let index = (pix.x & 1) + (pix.y & 1) * 2;
    var color: vec4f;
    var depth: f32;
    if (index == 0) {
        color = textureLoad(setColor0, texel, 0);
        depth = textureLoad(setDepth0, texel, 0);
    } else if (index == 1) {
        color = textureLoad(setColor1, texel, 0);
        depth = textureLoad(setDepth1, texel, 0);
    } else if (index == 2) {
        color = textureLoad(setColor2, texel, 0);
        depth = textureLoad(setDepth2, texel, 0);
    } else {
        color = textureLoad(setColor3, texel, 0);
        depth = textureLoad(setDepth3, texel, 0);
    }
    output.color = color;
    output.fragDepth = depth;
    return output;
}
`;

export { interleaveFragmentWGSL };
