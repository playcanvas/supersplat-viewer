// The raster pass: an indirect instanced draw of 128-quad meshes over the projector's
// survivors, into the renderer's own colour + depth target. Fragments keep themselves with
// probability alpha (StochasticSplats, Listing 1) and write opaque colour with hardware depth,
// so no sort is needed and the depth buffer holds the nearest surviving sample per pixel.
import { CACHE_WORDS } from './projector';

/** Quads per draw instance; the mesh holds this many quads. */
const QUADS_PER_INSTANCE = 128;

const rasterVertexWGSL = /* wgsl */ `
attribute vertex_position: vec3f;

// width, height, 2 / width, 2 / height
uniform viewportSize: vec4f;
// clip z = a * viewDepth + b (x, y); z = 1 for an orthographic camera
uniform clipZParams: vec4f;
// set by the engine's forward renderer for the target being rendered
uniform projectionFlipY: f32;

var<storage, read> splatCache: array<u32>;
var<storage, read> splatCount: array<u32>;
#ifdef SSE_ORDERED
    // cache slots in draw order (variant order:bucket)
    var<storage, read> orderedSlots: array<u32>;
#endif

varying gaussianUV: vec2f;
varying @interpolate(flat, either) packedColor: u32;
varying @interpolate(flat, either) packedAlpha: u32;
varying @interpolate(flat, either) splatId: u32;

const discardPosition = vec4f(0.0, 0.0, 2.0, 1.0);

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let order = pcInstanceIndex * ${QUADS_PER_INSTANCE}u + u32(vertex_position.z);
    // the indirect instance count rounds up to whole instances; the tail is discarded here
    if (order >= splatCount[0]) {
        output.position = discardPosition;
        return output;
    }

    #ifdef SSE_ORDERED
        let base = orderedSlots[order] * ${CACHE_WORDS}u;
    #else
        let base = order * ${CACHE_WORDS}u;
    #endif
    let maxRadius = min(1024.0, min(uniform.viewportSize.x, uniform.viewportSize.y));
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / uniform.viewportSize.xy;
    let ndc = unpack2x16snorm(splatCache[base]) * ndcRange;
    let depth = bitcast<f32>(splatCache[base + 1u]);
    let w = select(depth, 1.0, uniform.clipZParams.z != 0.0);
    let clip = vec4f(ndc * w, clamp(uniform.clipZParams.x * depth + uniform.clipZParams.y, 0.0, w), w);

    let axis1 = unpack2x16float(splatCache[base + 2u]);
    let word3 = splatCache[base + 3u];
    let len2 = unpack2x16float(word3).x;
    let axis2 = len2 * normalize(vec2f(axis1.y, -axis1.x));

    let corner = vertex_position.xy;
    let pixelOffset = corner.x * axis1 + corner.y * axis2;
    let pos = clip + vec4f(pixelOffset * clip.w * uniform.viewportSize.zw, 0.0, 0.0);
    output.position = vec4f(pos.x, pos.y * uniform.projectionFlipY, pos.z, pos.w);
    output.gaussianUV = corner;
    output.packedColor = splatCache[base + 4u];
    output.packedAlpha = word3 >> 16u;
    output.splatId = splatCache[base + 6u];
    return output;
}
`;

const rasterFragmentWGSL = /* wgsl */ `
varying gaussianUV: vec2f;
varying @interpolate(flat, either) packedColor: u32;
varying @interpolate(flat, either) packedAlpha: u32;
varying @interpolate(flat, either) splatId: u32;

uniform sseAlphaClip: f32;
// 0 while the camera rests, so a still frame reproduces itself; the frame index once TAA
// accumulates
uniform frameSeed: u32;

const EXP4 = exp(-4.0);
const INV_EXP4 = 1.0 / (1.0 - EXP4);

// the engine's falloff: zero at the quad edge, which sits at 2 sqrt(2) sigma
fn normExp(x: f32) -> f32 {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

// integer hash (Wellons' prospector mix)
fn hashU32(x: u32) -> u32 {
    var v = x;
    v ^= v >> 16u;
    v *= 0x7feb352du;
    v ^= v >> 15u;
    v *= 0x846ca68bu;
    v ^= v >> 16u;
    return v;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let radius = dot(gaussianUV, gaussianUV);
    if (radius > 1.0) {
        discard;
    }
    let opacity = f32(packedAlpha & 0xffu) / 255.0;
    let alpha = normExp(radius) * opacity;
    if (alpha < uniform.sseAlphaClip) {
        discard;
    }

    let pix = vec2u(pcPosition.xy);
    #ifdef SSE_SPP_QUAD
        // one sample per pixel, thresholds stratified over each 2x2 pixel quad: the quad's four
        // pixels take the four strata of [0, 1) in a per-(quad, splat) scrambled order, so a
        // splat with alpha a covers 4a +- 1 of its quad and the compose's quad mean is nearly
        // exact. Hashing quad and splat keeps overlapping splats decorrelated
        let quad = pix >> vec2u(1u);
        let h = hashU32((quad.x * 1973u) ^ (quad.y * 9277u) ^ ((splatId + 1u) * 26699u) ^ uniform.frameSeed);
        let stratum = ((pix.y & 1u) * 2u + (pix.x & 1u)) ^ (h & 3u);
        let rnd = (f32(stratum) + f32(h >> 8u) * (1.0 / 16777216.0)) * 0.25;
    #else
        let h = hashU32((pix.x * 1973u) ^ (pix.y * 9277u) ^ ((splatId + 1u) * 26699u) ^ uniform.frameSeed);
        let rnd = f32(h >> 8u) * (1.0 / 16777216.0);
    #endif
    if (rnd >= alpha) {
        discard;
    }

    let bits = packedColor;
    let color = vec3f(vec3u(bits, bits >> 10u, bits >> 20u) & vec3u(1023u)) * (f32(1u << (bits >> 30u)) / 1023.0);
    // opaque coverage: the compose reads alpha 1 as "a sample landed here"
    output.color = vec4f(color, 1.0);
    return output;
}
`;

export { QUADS_PER_INSTANCE, rasterFragmentWGSL, rasterVertexWGSL };
