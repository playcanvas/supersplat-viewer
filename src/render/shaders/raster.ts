// The raster pass: an indirect instanced draw of 128-quad meshes over the projector's
// survivors, into the renderer's own colour + depth target. Fragments keep themselves with
// probability alpha (StochasticSplats, Listing 1) and write opaque colour with hardware depth,
// so no sort is needed and the depth buffer holds the nearest surviving sample per pixel.
import { CACHE_WORDS } from './projector';

/** Quads per draw instance; the mesh holds this many quads. */
const QUADS_PER_INSTANCE = 128;

/** The raster's far clamp in normalised depth: just inside 1, which the compose reads as empty. */
const FAR_CLIP_Z = 0.999999;

// the raster's varyings, shared by both stages: the opacity sits in packedAlpha's low 8 bits,
// and with the seed hashed per vertex (variant hash other than full) the splat's seed takes
// the high 24, so no splat id needs to reach the fragment
const varyingsWGSL = /* wgsl */ `
#ifdef SSE_UV_HALF
    varying @interpolate(linear) gaussianUV: half2;
#else
    varying @interpolate(linear) gaussianUV: vec2f;
#endif
varying @interpolate(flat, either) packedColor: u32;
varying @interpolate(flat, either) packedAlpha: u32;
#ifndef SSE_SEED_VERTEX
    varying @interpolate(flat, either) splatId: u32;
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
// the fragment shader's alpha clip, which also bounds the quad (variant quadClip)
uniform sseAlphaClip: f32;
#ifdef SSE_CORE
    // variant prefill:core: the alpha a splat's depth-only core covers
    uniform sseCoreAlpha: f32;
#endif

var<storage, read> splatCache: array<u32>;
var<storage, read> splatCount: array<u32>;
#if defined(SSE_ORDERED) || defined(SSE_INTERLEAVED)
    // cache slots in draw order (variant order:bucket)
    var<storage, read> orderedSlots: array<u32>;
#endif
#ifdef SSE_HYBRID
    // variant pipeline:hybrid: the opacity byte from which the raster draws a splat
    uniform hybridLimit: u32;
#endif
#ifdef SSE_INTERLEAVED
    // variant coverage:interleaved: the pixel set this draw renders, its range of the ordered
    // list, and the map from the full target's clip x and y (over w) into the set's target
    uniform setIndex: u32;
    uniform setMap: vec4f;
    var<storage, read> setRanges: array<vec2u>;
#endif

// screen-linear: the corners share one screen footprint whatever depth they carry
${varyingsWGSL}
#ifdef SSE_SEED_VERTEX
    // the splat's share of the coverage hash, once per vertex rather than per fragment
    uniform frameSeed: u32;
    ${hashWGSL}
#endif

const discardPosition = vec4f(0.0, 0.0, 2.0, 1.0);

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
        let base = orderedSlots[order] * ${CACHE_WORDS}u;
    #else
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
    #endif
    let maxRadius = min(1024.0, min(uniform.viewportSize.x, uniform.viewportSize.y));
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / uniform.viewportSize.xy;
    let ndc = unpack2x16snorm(splatCache[base]) * ndcRange;
    let depth = bitcast<f32>(splatCache[base + 1u]);
    let ortho = uniform.clipZParams.z != 0.0;

    let axis1 = unpack2x16float(splatCache[base + 2u]);
    let word3 = splatCache[base + 3u];
    #ifdef SSE_HYBRID
        // variant pipeline:hybrid: the faint splats are the compute sampler's (shaders/samples.ts)
        if (((word3 >> 16u) & 0xffu) < uniform.hybridLimit) {
            output.position = discardPosition;
            return output;
        }
    #endif
    let len2 = unpack2x16float(word3).x;
    let axis2 = len2 * normalize(vec2f(axis1.y, -axis1.x));

    #ifdef SSE_COVERAGE_SPLAT
        // variant coverage:splat: the projector kept only the splats with pixels to keep this
        // frame, and scaled their axes to the polygon of those pixels (shaders/projector.ts);
        // with interleaved pixel sets, to the largest set's, with each set's fraction in word 6
        #ifdef SSE_INTERLEAVED
            let corner = vertex_position.xy * (f32((splatCache[base + 6u] >> (8u * uniform.setIndex)) & 0xffu) * (1.0 / 255.0));
        #else
            let corner = vertex_position.xy;
        #endif
    #elif defined(SSE_CORE)
        // variant prefill:core: the square inscribed in the region where alpha is at least
        // sseCoreAlpha, so every pixel it covers is that opaque (alpha = opacity * falloff(r^2)
        // with falloff(x) = (exp(-4 x) - exp(-4)) / (1 - exp(-4))); splats fainter have none
        let opacityC = f32((word3 >> 16u) & 0xffu) / 255.0;
        let ratio = uniform.sseCoreAlpha / opacityC;
        if (ratio >= 1.0) {
            output.position = discardPosition;
            return output;
        }
        let e4 = exp(-4.0);
        let corner = vertex_position.xy * sqrt(-log(ratio * (1.0 - e4) + e4) * 0.25) * 0.70710678;
    #elif defined(SSE_QUAD_CLIP)
        // shrink the quad to where alpha falls below the clip, as the engine's clipCorner does:
        // the fragment shader discards everything outside it anyway, but still pays to shade it
        let opacity = f32((word3 >> 16u) & 0xffu) / 255.0;
        let corner = vertex_position.xy * min(1.0, sqrt(max(0.0, log(opacity / uniform.sseAlphaClip))) * 0.5);
    #else
        let corner = vertex_position.xy;
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
    #ifdef SSE_RASTER_EMPTY
        // every corner at the centre: the vertex work without the area (variant raster:empty)
        let ndcCorner = ndc;
    #else
        let ndcCorner = ndc + pixelOffset * uniform.viewportSize.zw;
    #endif
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
    #ifdef SSE_UV_HALF
        output.gaussianUV = half2(corner);
    #else
        output.gaussianUV = corner;
    #endif
    output.packedColor = splatCache[base + 4u];
    #ifdef SSE_SEED_VERTEX
        let seed = hashU32(((splatCache[base + 6u] + 1u) * 26699u) ^ uniform.frameSeed);
        output.packedAlpha = ((word3 >> 16u) & 0xffu) | (seed & 0xffffff00u);
    #else
        output.packedAlpha = word3 >> 16u;
        output.splatId = splatCache[base + 6u];
    #endif
    return output;
}
`;

const rasterFragmentWGSL = /* wgsl */ `
${varyingsWGSL}

uniform sseAlphaClip: f32;
// 0 while the camera rests, so a still frame reproduces itself; the frame index once TAA
// accumulates
uniform frameSeed: u32;

const EXP4 = exp(-4.0);
const INV_EXP4 = 1.0 / (1.0 - EXP4);

// the engine's falloff: zero at the quad edge, which sits at 2 sqrt(2) sigma
fn falloff(x: f32) -> f32 {
    #ifdef SSE_FALLOFF_POLY
        // (1 - x)^3 (1 - 1.285 x + 2.64 x^2): within 0.0096 of the exp form over [0, 1]
        let t = 1.0 - x;
        return t * t * t * (1.0 + x * (-1.285 + 2.64 * x));
    #else
        return (exp(x * -4.0) - EXP4) * INV_EXP4;
    #endif
}

${hashWGSL}

#ifdef SSE_MSAA
    // variant msaa:half4: the coverage bit of one sample of a 4x pixel, at its offset from the
    // pixel centre (the standard 4x pattern), against its own threshold
    fn sampleBit(uv: vec2f, ddx: vec2f, ddy: vec2f, offset: vec2f, opacity: f32, threshold: f32, bit: u32) -> u32 {
        let uvS = uv + ddx * offset.x + ddy * offset.y;
        let r = dot(uvS, uvS);
        let a = falloff(r) * opacity;
        return select(0u, bit, r <= 1.0 && a >= uniform.sseAlphaClip && threshold < a);
    }
#endif

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    #ifdef SSE_COVERAGE_SPLAT
        // variant coverage:splat: the polygon is the kept coverage, so every fragment is kept
        let bitsS = packedColor;
        let colorS = vec3f(vec3u(bitsS, bitsS >> 10u, bitsS >> 20u) & vec3u(1023u)) * (f32(1u << (bitsS >> 30u)) / 1023.0);
        output.color = vec4f(colorS, 1.0);
        return output;
    #endif
    #ifdef SSE_RASTER_DISCARD
        discard;
    #endif
    #ifdef SSE_RASTER_SOLID
        // diagnostic: no discard anywhere, every quad an opaque square (raster:solid)
        output.color = vec4f(1.0);
        return output;
    #endif
    #ifdef SSE_RASTER_BLEND
        // diagnostic (raster:blend): what the sorted renderer does per fragment, premultiplied
        // over blending of the falloff, no discard and no depth write (the order is not sorted)
        let uvB = vec2f(gaussianUV);
        let rB = dot(uvB, uvB);
        let alphaB = select(0.0, falloff(rB) * (f32(packedAlpha & 0xffu) / 255.0), rB <= 1.0);
        let bitsB = packedColor;
        let colorB = vec3f(vec3u(bitsB, bitsB >> 10u, bitsB >> 20u) & vec3u(1023u)) * (f32(1u << (bitsB >> 30u)) / 1023.0);
        output.color = vec4f(colorB * alphaB, alphaB);
        return output;
    #endif
    #ifdef SSE_RASTER_NODISCARD
        // diagnostic (raster:nodiscard): the stochastic test without a discard; a rejected
        // fragment outputs zero coverage, and an under blend lets the first kept fragment in draw
        // order claim the pixel, with no depth write
        let uvN = vec2f(gaussianUV);
        let rN = dot(uvN, uvN);
        let alphaN = falloff(rN) * (f32(packedAlpha & 0xffu) / 255.0);
        let ignN = fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))));
        let rndN = fract(ignN + f32(packedAlpha >> 8u) * (1.0 / 16777216.0));
        let keepN = select(0.0, 1.0, rN <= 1.0 && alphaN >= uniform.sseAlphaClip && rndN < alphaN);
        let bitsN = packedColor;
        let colorN = vec3f(vec3u(bitsN, bitsN >> 10u, bitsN >> 20u) & vec3u(1023u)) * (f32(1u << (bitsN >> 30u)) / 1023.0);
        output.color = vec4f(colorN, 1.0) * keepN;
        return output;
    #endif
    #ifdef SSE_RASTER_MASK
        // diagnostic (raster:mask): the stochastic test as a coverage mask on the single
        // sample instead of a discard
        let uvK = vec2f(gaussianUV);
        let rK = dot(uvK, uvK);
        let alphaK = falloff(rK) * (f32(packedAlpha & 0xffu) / 255.0);
        let ignK = fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))));
        let rndK = fract(ignK + f32(packedAlpha >> 8u) * (1.0 / 16777216.0));
        output.sampleMask = select(0u, 1u, rK <= 1.0 && alphaK >= uniform.sseAlphaClip && rndK < alphaK);
        let bitsK = packedColor;
        let colorK = vec3f(vec3u(bitsK, bitsK >> 10u, bitsK >> 20u) & vec3u(1023u)) * (f32(1u << (bitsK >> 30u)) / 1023.0);
        output.color = vec4f(colorK, 1.0);
        return output;
    #endif
    #ifdef SSE_MSAA
        // one invocation per pixel of a half-resolution 4x target: each sample is kept with
        // probability alpha at its own position, with IGN thresholds rotated by the splat's
        // seed and stratified over the four samples. The derivatives come first, while the
        // control flow is uniform
        let uvPix = vec2f(gaussianUV);
        let ddx = dpdx(uvPix);
        let ddy = dpdy(uvPix);
        let opacityM = f32(packedAlpha & 0xffu) / 255.0;
        let ignM = fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))));
        let base = fract(ignM + f32(packedAlpha >> 8u) * (1.0 / 16777216.0));
        let mask = sampleBit(uvPix, ddx, ddy, vec2f(-0.125, -0.375), opacityM, base, 1u) |
            sampleBit(uvPix, ddx, ddy, vec2f(0.375, -0.125), opacityM, fract(base + 0.25), 2u) |
            sampleBit(uvPix, ddx, ddy, vec2f(-0.375, 0.125), opacityM, fract(base + 0.5), 4u) |
            sampleBit(uvPix, ddx, ddy, vec2f(0.125, 0.375), opacityM, fract(base + 0.75), 8u);
        if (mask == 0u) {
            discard;
        }
        output.sampleMask = mask;
        let bitsM = packedColor;
        let colorM = vec3f(vec3u(bitsM, bitsM >> 10u, bitsM >> 20u) & vec3u(1023u)) * (f32(1u << (bitsM >> 30u)) / 1023.0);
        output.color = vec4f(colorM, 1.0);
        return output;
    #endif
    let uv = vec2f(gaussianUV);
    let radius = dot(uv, uv);
    if (radius > 1.0) {
        discard;
    }
    let opacity = f32(packedAlpha & 0xffu) / 255.0;
    #ifndef SSE_EARLY_REJECT
        let alpha = falloff(radius) * opacity;
        if (alpha < uniform.sseAlphaClip) {
            discard;
        }
    #endif

    let pix = vec2u(pcPosition.xy);
    #ifdef SSE_SEED_VERTEX
        let seed = packedAlpha & 0xffffff00u;
        let key = seed >> 8u;
    #else
        let key = splatId;
    #endif
    #ifdef SSE_HASH_IGN
        // interleaved gradient noise (Jimenez 2014) rotated by the splat's seed: float only,
        // no integer multiplies; the rotation changes every frame with the seed
        let ign = fract(52.9829189 * fract(dot(pcPosition.xy, vec2f(0.06711056, 0.00583715))));
        let rnd = fract(ign + f32(key) * (1.0 / 16777216.0));
    #else
        #ifdef SSE_SPP_QUAD
            // one sample per pixel, thresholds stratified over each 2x2 pixel quad: the quad's
            // four pixels take the four strata of [0, 1) in a per-(quad, splat) scrambled
            // order, so a splat with alpha a covers 4a +- 1 of its quad and the compose's quad
            // mean is nearly exact. Hashing quad and splat keeps overlapping splats decorrelated
            let cell = pix >> vec2u(1u);
        #else
            let cell = pix;
        #endif
        #if defined(SSE_HASH_LITE)
            // one multiply: the seed is already mixed, the cell only needs spreading
            var h = ((cell.x | (cell.y << 16u)) ^ seed) * 0x9e3779b1u;
            h ^= h >> 16u;
        #elif defined(SSE_SEED_VERTEX)
            let h = hashU32((cell.x | (cell.y << 16u)) ^ seed);
        #else
            let h = hashU32((cell.x * 1973u) ^ (cell.y * 9277u) ^ ((splatId + 1u) * 26699u) ^ uniform.frameSeed);
        #endif
        #ifdef SSE_SPP_QUAD
            let stratum = ((pix.y & 1u) * 2u + (pix.x & 1u)) ^ (h & 3u);
            let rnd = (f32(stratum) + f32(h >> 8u) * (1.0 / 16777216.0)) * 0.25;
        #else
            let rnd = f32(h >> 8u) * (1.0 / 16777216.0);
        #endif
    #endif

    #ifdef SSE_EARLY_REJECT
        // alpha never exceeds the opacity: a threshold above it discards before the falloff
        if (rnd >= opacity) {
            discard;
        }
        let alpha = falloff(radius) * opacity;
        if (alpha < uniform.sseAlphaClip) {
            discard;
        }
    #endif

    #ifdef SSE_RASTER_NOHASH
        // diagnostic: a multiply-free threshold in place of the hash (raster:nohash)
        let cheap = f32((pix.x ^ (pix.y << 5u) ^ key ^ (key >> 7u)) & 0xffffu) * (1.0 / 65536.0);
        if (cheap >= alpha) {
            discard;
        }
    #elif !defined(SSE_RASTER_OPAQUE)
        if (rnd >= alpha) {
            discard;
        }
    #endif

    let bits = packedColor;
    let color = vec3f(vec3u(bits, bits >> 10u, bits >> 20u) & vec3u(1023u)) * (f32(1u << (bits >> 30u)) / 1023.0);
    // opaque coverage: the compose reads alpha 1 as "a sample landed here"
    output.color = vec4f(color, 1.0);
    return output;
}
`;

export { FAR_CLIP_Z, QUADS_PER_INSTANCE, rasterFragmentWGSL, rasterVertexWGSL };
