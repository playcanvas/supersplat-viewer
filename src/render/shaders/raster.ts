// The raster pass: an indirect instanced draw of 128-quad meshes over the projector's
// survivors, into the renderer's own colour + depth target. Fragments keep themselves with
// probability alpha (StochasticSplats, Listing 1) and write opaque colour with hardware depth,
// so no sort is needed and the depth buffer holds the nearest surviving sample per pixel.
import { CACHE_WORDS, DRAW_BITS } from './projector';

/** Quads per draw instance; the mesh holds this many quads. */
const QUADS_PER_INSTANCE = 128;

/** The raster's far clamp in normalised depth: just inside 1, which the compose reads as empty. */
const FAR_CLIP_Z = 0.999999;

// the raster's varyings, shared by both stages: the opacity sits in packedAlpha's low 8 bits
// and the splat's seed, hashed once per vertex, in the high 24, so no splat id needs to reach
// the fragment
const varyingsWGSL = /* wgsl */ `
varying @interpolate(linear) gaussianUV: vec2f;
varying @interpolate(flat, either) packedColor: u32;
varying @interpolate(flat, either) packedAlpha: u32;
#ifdef SSE_JITTER
    // variant jitter, as floats so the fragment converts nothing: x the stratum's base
    // threshold, y the entry's key for the jitter pattern, z the opacity
    varying @interpolate(flat, either) jitterVary: vec4f;
#endif
`;

// integer hash (Wellons' prospector mix)
const hashWGSL = /* wgsl */ `
fn hashU32(x: u32) -> u32 {
    var v = x;
    v ^= v >> 16u;
    v *= 0x7feb352du;
    v ^= v >> 15u;
    v *= 0x846ca68bu;
    v ^= v >> 16u;
    return v;
}
`;

const rasterVertexWGSL = /* wgsl */ `
attribute vertex_position: vec3f;

// width, height, 2 / width, 2 / height
uniform viewportSize: vec4f;
// clip z = a * viewDepth + b (x, y); z = 1 for an orthographic camera
uniform clipZParams: vec4f;
// set by the engine's forward renderer for the target being rendered
uniform projectionFlipY: f32;
// focal length in pixels (x, y), for the popless corner depths
uniform focalParams: vec4f;
// the fragment shader's alpha clip, which also bounds the quad
uniform sseAlphaClip: f32;

var<storage, read> splatCache: array<u32>;
var<storage, read> splatCount: array<u32>;
// cache slots in draw order (shaders/order.ts)
var<storage, read> orderedSlots: array<u32>;
#ifdef SSE_INTERLEAVED
    // variant coverage:interleaved: the draw group this draw renders (0-3 the pixel sets, 4 the
    // full target's small splats), its range of the ordered list, and the map from the full
    // target's clip x and y (over w) into the group's target
    uniform setIndex: u32;
    uniform setMap: vec4f;
    var<storage, read> setRanges: array<vec2u>;
#endif
#ifdef SSE_COVERAGE_SPLAT
    // x: the sub-strata a stratum splits into (variant jitter; 0: no jitter), y: the strata this
    // draw's thresholds come from, z: 1 / (strata * sub-strata), the width of a pixel's jitter,
    // w: the square's circumradius over the ellipse's (area matched, or containing it with jitter)
    uniform jitterParams: vec4f;
#endif

// screen-linear: the corners share one screen footprint whatever depth they carry
${varyingsWGSL}
// the splat's share of the coverage hash, once per vertex rather than per fragment
uniform frameSeed: u32;
${hashWGSL}

const discardPosition = vec4f(0.0, 0.0, 2.0, 1.0);

#ifdef SSE_COVERAGE_SPLAT
    // the radius, in units of the quad's half extent, where alpha = opacity * falloff(r^2) falls
    // to a threshold (the projector's radiusAt)
    fn radiusAt(threshold: f32, opacity: f32) -> f32 {
        let e4 = exp(-4.0);
        return sqrt(max(-log(threshold / opacity * (1.0 - e4) + e4) * 0.25, 0.0));
    }
#endif

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    #ifdef SSE_INTERLEAVED
        let range = setRanges[uniform.setIndex];
        let order = range.x + pcInstanceIndex * ${QUADS_PER_INSTANCE}u + u32(vertex_position.z);
        if (order >= range.y) {
            output.position = discardPosition;
            return output;
        }
    #else
        let order = pcInstanceIndex * ${QUADS_PER_INSTANCE}u + u32(vertex_position.z);
        // the indirect instance count rounds up to whole instances; the tail is discarded here
        if (order >= splatCount[0]) {
            output.position = discardPosition;
            return output;
        }
    #endif
    let base = orderedSlots[order] * ${CACHE_WORDS}u;
    let maxRadius = min(1024.0, min(uniform.viewportSize.x, uniform.viewportSize.y));
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / uniform.viewportSize.xy;
    let ndc = unpack2x16snorm(splatCache[base]) * ndcRange;
    let depth = bitcast<f32>(splatCache[base + 1u]);
    let ortho = uniform.clipZParams.z != 0.0;

    let axis1 = unpack2x16float(splatCache[base + 2u]);
    let word3 = splatCache[base + 3u];
    let len2 = unpack2x16float(word3).x;
    let axis2 = len2 * normalize(vec2f(axis1.y, -axis1.x));

    #ifdef SSE_COVERAGE_SPLAT
        // Coverage other than pixel: the projector kept only the splats with pixels to keep this
        // frame and stored the full quad's axes; the square of the pixels this draw keeps is
        // sized here from its threshold, rebuilt from cache word 6 as the projector built it
        // (shaders/projector.ts): the splat's 15-bit draw, and a nibble per draw group holding
        // the stratum and sub-stratum of the jittered modes
        let word6 = splatCache[base + 6u];
        let opacityS = f32((word3 >> 16u) & 0xffu) / 255.0;
        let drawn = f32(word6 & ${(1 << DRAW_BITS) - 1}u) * (1.0 / ${(1 << DRAW_BITS) - 1}.0);
        #ifdef SSE_INTERLEAVED
            let group = uniform.setIndex;
            let fullGroup = group == 4u;
            let nibble = (word6 >> (16u + 4u * select(group, 0u, fullGroup))) & 0xfu;
            // the sets' thresholds are the four quarters from the draw; the full target's is the draw
            let plain = select(fract(drawn + f32(group) * 0.25), drawn, fullGroup);
        #else
            let nibble = (word6 >> 16u) & 0xfu;
            let plain = drawn;
        #endif
        let subs = uniform.jitterParams.x;
        // jittered: the base of the stratum (and sub-stratum) the nibble names; its index goes to
        // the fragment, which adds the pixel's own jitter within it
        let strataIndex = f32((nibble >> 1u) & 3u) * subs + f32(nibble >> 3u);
        let threshold = max(select(plain, strataIndex * uniform.jitterParams.z, subs > 0.0), uniform.sseAlphaClip);
        let polygonRadius = radiusAt(threshold, opacityS) * uniform.jitterParams.w;
        #ifdef SSE_POLYGON_ROTATE
            // without jitter the square is turned by a fresh angle every frame, so over frames
            // the kept region averages to the ellipse rather than to the square's corners
            let turn = f32(hashU32(order ^ uniform.frameSeed)) * (6.2831853 / 4294967296.0);
            let cs = vec2f(cos(turn), sin(turn));
            let unit = vec2f(
                vertex_position.x * cs.x - vertex_position.y * cs.y,
                vertex_position.x * cs.y + vertex_position.y * cs.x
            );
        #else
            let unit = vertex_position.xy;
        #endif
        let corner = unit * polygonRadius;
    #else
        // shrink the quad to where alpha falls below the clip, as the engine's clipCorner does:
        // the fragment shader discards everything outside it anyway, but still pays to shade it
        let opacity = f32((word3 >> 16u) & 0xffu) / 255.0;
        let corner = vertex_position.xy * min(1.0, sqrt(max(0.0, log(opacity / uniform.sseAlphaClip))) * 0.5);
    #endif
    let pixelOffset = corner.x * axis1 + corner.y * axis2;
    #ifdef SSE_POPLESS
        // the corner's depth on the splat's plane (see the projector): its view-space offset
        // at the centre's depth, times the stored gradient
        let g = unpack2x16float(splatCache[base + 5u]);
        let shift = dot(g, pixelOffset * select(depth, 1.0, ortho) / uniform.focalParams.xy);
        let cornerDepth = select(depth / (1.0 + shift), depth + shift, ortho);
    #else
        let cornerDepth = depth;
    #endif
    let w = select(cornerDepth, 1.0, ortho);
    let ndcCorner = ndc + pixelOffset * uniform.viewportSize.zw;
    // clip z clamped into range like the engine's splat shader, so splats beyond the far plane
    // still draw; just inside it, since the compose and the accumulation read depth 1 as empty
    let pos = vec4f(ndcCorner * w, clamp(uniform.clipZParams.x * cornerDepth + uniform.clipZParams.y, 0.0, w * ${FAR_CLIP_Z}), w);
    output.position = vec4f(pos.x, pos.y * uniform.projectionFlipY, pos.z, pos.w);
    #ifdef SSE_INTERLEAVED
        // into the set's own target, in framebuffer space: the full target's pixel (2i + x, 2j + y)
        // for set (x, y) is the set's pixel (i, j), so the interleave can copy texel for texel
        output.position = vec4f(
            uniform.setMap.x * output.position.x + uniform.setMap.y * w,
            uniform.setMap.z * output.position.y + uniform.setMap.w * w,
            output.position.z,
            w
        );
    #endif
    output.gaussianUV = corner;
    output.packedColor = splatCache[base + 4u];
    #ifdef SSE_JITTER
        // the stratum's base threshold for the fragment's test, and a per-entry key that rotates
        // its jitter pattern, so overlapping splats' jitters are independent
        let entryKey = hashU32(order ^ uniform.frameSeed);
        output.jitterVary = vec4f(strataIndex * uniform.jitterParams.z, f32(entryKey >> 8u) * (1.0 / 16777216.0), opacityS, 0.0);
        output.packedAlpha = word3 >> 16u;
    #else
        let seed = hashU32(((splatCache[base + 6u] + 1u) * 26699u) ^ uniform.frameSeed);
        output.packedAlpha = ((word3 >> 16u) & 0xffu) | (seed & 0xffffff00u);
    #endif
    return output;
}
`;

const rasterFragmentWGSL = /* wgsl */ `
${varyingsWGSL}

uniform sseAlphaClip: f32;
#ifdef SSE_JITTER
    // z: the width of a pixel's jitter, 1 / (strata * sub-strata) (see the vertex stage)
    uniform jitterParams: vec4f;
#endif

const EXP4 = exp(-4.0);
const INV_EXP4 = 1.0 / (1.0 - EXP4);

// the engine's falloff: zero at the quad edge, which sits at 2 sqrt(2) sigma
fn falloff(x: f32) -> f32 {
    return (exp(x * -4.0) - EXP4) * INV_EXP4;
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    #ifdef SSE_COVERAGE_SPLAT
        #ifdef SSE_JITTER
            // Variant jitter: the square contains the stratum's ellipse, and the fragment keeps
            // itself where alpha exceeds the stratum's base plus its own jitter within the
            // stratum: interleaved gradient noise rotated by the entry's key, as the per-pixel
            // raster's. The test discards the square's corners too (alpha is negative past the
            // quad's edge), so the kept region is the exact ellipse with a dithered rim
            let alphaJ = falloff(dot(gaussianUV, gaussianUV)) * jitterVary.z;
            let ignJ = fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))));
            let thresholdJ = jitterVary.x + fract(ignJ + jitterVary.y) * uniform.jitterParams.z;
            if (alphaJ <= max(thresholdJ, uniform.sseAlphaClip)) {
                discard;
            }
        #endif
        // the square is the kept coverage, so every fragment is kept
        let bits = packedColor;
    #else
        let radius = dot(gaussianUV, gaussianUV);
        if (radius > 1.0) {
            discard;
        }
        let opacity = f32(packedAlpha & 0xffu) / 255.0;
        let alpha = falloff(radius) * opacity;
        if (alpha < uniform.sseAlphaClip) {
            discard;
        }

        // the coverage threshold: interleaved gradient noise (Jimenez 2014) rotated by the
        // splat's seed, float only, with no integer multiplies, which mobile gpus run at a
        // fraction of the float rate; the rotation changes every frame with the seed
        let ign = fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))));
        let rnd = fract(ign + f32(packedAlpha >> 8u) * (1.0 / 16777216.0));
        if (rnd >= alpha) {
            discard;
        }
        let bits = packedColor;
    #endif

    let color = vec3f(vec3u(bits, bits >> 10u, bits >> 20u) & vec3u(1023u)) * (f32(1u << (bits >> 30u)) / 1023.0);
    // opaque coverage: the compose reads alpha 1 as "a sample landed here"
    output.color = vec4f(color, 1.0);
    return output;
}
`;

export { FAR_CLIP_Z, QUADS_PER_INSTANCE, rasterFragmentWGSL, rasterVertexWGSL };
