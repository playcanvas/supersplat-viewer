// The sampled stochastic renderer (variants pipeline:sample and pipeline:hybrid): the stochastic
// raster's frame, the nearest kept sample per pixel, made in compute without testing the pixels a
// splat does not keep. The raster tests every pixel of a splat's quad against a threshold and
// keeps it with probability alpha; at an overdraw-heavy view 93% of those tests fail. Here a splat
// scatters a Poisson process of points with density lambda = -ln(1 - alpha) per pixel, so a pixel
// receives at least one with probability 1 - exp(-lambda) = alpha, independently per pixel and
// per splat: the raster's statistics (its pixels area-averaged rather than point-sampled).
//
// A small splat (few points expected) scatters them itself, radius from a per-opacity table of
// the falloff's radial profile and a uniform angle. A larger one is handed out by screen tile:
// it emits one work item per on-screen 16x16 tile its ellipse reaches (its rows over its subgroup,
// as the binning does, shaders/tiles.ts), so no point lands off screen and a tile's points stay in
// a tile's pixels. An item takes the tile's densest lambda: where it is at most 1 it draws a
// Poisson number of candidates at that density, uniform over the tile, and keeps each with
// probability lambda / its maximum (thinning, so the kept points have the exact density); where it
// is denser it tests every pixel of the tile against a threshold, as the raster would.
//
// Each kept sample takes the depth of the splat's popless plane there and claims its pixel with
// one 32-bit atomicMax of a key packing the inverted depth's top 20 bits (0.05 % precision) over
// the colour at 4 bits a channel, dithered so the accumulation converges to the exact colour.
// Splats come in the projector's front-to-back bucket order and a sample behind its pixel's key
// skips the atomic, so most never issue one. A fullscreen resolve then writes the keys into the
// raster target's colour and depth, so the accumulation, the compose, the occlusion grid and the
// picker read an ordinary frame. With pipeline:hybrid the raster draws the solid splats (opacity
// of at least hybridOpacity) first, and the resolve merges the sampled pixels in by depth.
import { CACHE_WORDS } from './projector';
import { TILE_SIZE, splatGeometryWGSL } from './tiles';

/** Radius steps per opacity in the inverse-CDF table. */
const SAMPLE_TABLE_STEPS = 32;

/** A splat expecting at most this many points scatters them itself; a larger one goes by tile. */
const SAMPLE_DIRECT_POINTS = 16;

/**
 * The per-opacity tables: the falloff's radial profile as a Poisson density, its integral over
 * the unit disk (points per unit of uv area, before the axes' scale) and its inverse radial CDF.
 *
 * @param alphaClip - Alpha below which nothing is kept.
 * @param maxAlpha - Alpha's ceiling: lambda is infinite at 1, and grows as -ln(1 - alpha) near it.
 * @returns totals[256] and radii[256 * (SAMPLE_TABLE_STEPS + 1)].
 */
const buildSampleTables = (alphaClip: number, maxAlpha: number) => {
    const totals = new Float32Array(256);
    const radii = new Float32Array(256 * (SAMPLE_TABLE_STEPS + 1));
    const e4 = Math.exp(-4);
    const steps = 2048;
    const cdf = new Float64Array(steps + 1);
    for (let o = 0; o < 256; o++) {
        const opacity = o / 255;
        cdf[0] = 0;
        for (let i = 1; i <= steps; i++) {
            const r = (i - 0.5) / steps;
            const alpha = Math.min(maxAlpha, (opacity * (Math.exp(-4 * r * r) - e4)) / (1 - e4));
            const lambda = alpha >= alphaClip && alpha > 0 ? -Math.log(1 - alpha) : 0;
            cdf[i] = cdf[i - 1] + lambda * 2 * Math.PI * r * (1 / steps);
        }
        const total = cdf[steps];
        totals[o] = total;
        let i = 0;
        for (let j = 0; j <= SAMPLE_TABLE_STEPS; j++) {
            const target = (j / SAMPLE_TABLE_STEPS) * total;
            while (i < steps && cdf[i + 1] < target) i++;
            const span = cdf[i + 1] - cdf[i];
            const f = total > 0 && span > 0 ? (target - cdf[i]) / span : 0;
            radii[o * (SAMPLE_TABLE_STEPS + 1) + j] = total > 0 ? Math.min(1, (i + f) / steps) : 0;
        }
    }
    return { totals, radii };
};

const sampleCommonWGSL = /* wgsl */ `
diagnostic(off, subgroup_uniformity);
struct SampleUniforms {
    viewportW: f32,
    viewportH: f32,
    tilesX: u32,
    tilesY: u32,
    focalX: f32,
    focalY: f32,
    flip: f32,
    alphaClip: f32,
    isOrtho: u32,
    frameSeed: u32,
    itemCapacity: u32,
    // splats with an opacity byte at least this are left to the raster (variant pipeline:hybrid;
    // 256 samples every splat)
    opacityLimit: u32,
    // alpha's ceiling in the point density
    maxAlpha: f32,
    // bench diagnostics (wrong images): 1 claims nothing, 2 scatters no direct points
    debugFlags: u32
}

@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read> cache: array<u32>;
@group(0) @binding(2) var<storage, read> orderedSlots: array<u32>;
@group(0) @binding(3) var<storage, read> totals: array<f32>;
@group(0) @binding(4) var<storage, read> radii: array<f32>;
@group(0) @binding(5) var<storage, read_write> pixels: array<atomic<u32>>;
// survivor slot, tile
@group(0) @binding(6) var<storage, read_write> items: array<vec2u>;
// [0] items this frame, [1] points scattered directly (for the bench)
@group(0) @binding(7) var<storage, read_write> itemCount: array<atomic<u32>>;
@group(0) @binding(8) var<uniform> uniforms: SampleUniforms;

${splatGeometryWGSL}

fn hashU32(x: u32) -> u32 {
    var v = x;
    v ^= v >> 16u;
    v *= 0x7feb352du;
    v ^= v >> 15u;
    v *= 0x846ca68bu;
    v ^= v >> 16u;
    return v;
}

// a uniform in (0, 1]
fn nextUniform(state: ptr<function, u32>) -> f32 {
    *state = *state * 747796405u + 2891336453u;
    let word = hashU32(*state);
    return (f32(word >> 8u) + 1.0) * (1.0 / 16777216.0);
}

// Poisson by inversion while the mean is small, by its normal approximation past it
fn poisson(mean: f32, state: ptr<function, u32>) -> u32 {
    if (mean < 24.0) {
        let limit = exp(-mean);
        var product = nextUniform(state);
        var n = 0u;
        while (product > limit && n < 96u) {
            product *= nextUniform(state);
            n++;
        }
        return n;
    }
    let z = sqrt(-2.0 * log(nextUniform(state))) * cos(6.2831853 * nextUniform(state));
    return u32(max(round(mean + sqrt(mean) * z), 0.0));
}

// the splat's seed this frame, as the raster's coverage hash takes it
fn seedOf(slot: u32) -> u32 {
    return hashU32(((cache[slot * ${CACHE_WORDS}u + 6u] + 1u) * 26699u) ^ uniforms.frameSeed);
}

fn colorOf(bits: u32) -> vec3f {
    return min(vec3f(vec3u(bits, bits >> 10u, bits >> 20u) & vec3u(1023u)) * (f32(1u << (bits >> 30u)) / 1023.0), vec3f(1.0));
}

// a kept sample at offset d from the centre: the popless plane's depth there, the colour at 4
// bits a channel dithered by the noise word, and the pixel claimed if nearer than what holds it
fn claim(g: Geometry, color: vec3f, d: vec2f, noise: u32) {
    let p = g.center + d;
    if (p.x < 0.0 || p.y < 0.0 || p.x >= uniforms.viewportW || p.y >= uniforms.viewportH) {
        return;
    }
    let shift = dot(g.gradient, d);
    let depth = select(g.depth / (1.0 + clamp(shift, -0.5, 0.5)), g.depth + shift, uniforms.isOrtho != 0u);
    let dither = vec3f(vec3u(noise, noise >> 8u, noise >> 16u) & vec3u(255u)) * (1.0 / 256.0);
    let q = min(vec3u(color * 15.0 + dither), vec3u(15u));
    let key = (~bitcast<u32>(max(depth, 0.0)) & 0xfffff000u) | (q.r << 8u) | (q.g << 4u) | q.b;
    let index = u32(p.y) * u32(uniforms.viewportW) + u32(p.x);
    if ((uniforms.debugFlags & 1u) != 0u) {
        return;
    }
    if (atomicLoad(&pixels[index]) < key) {
        atomicMax(&pixels[index], key);
    }
}

// alpha at offset d
fn alphaAt(g: Geometry, d: vec2f) -> f32 {
    let r2 = g.q.x * d.x * d.x + 2.0 * g.q.y * d.x * d.y + g.q.z * d.y * d.y;
    return g.opacity * (exp(-4.0 * r2) - EXP_M4) / (1.0 - EXP_M4);
}
`;

// One thread per survivor, front to back: the splat's expected point count; a small one scatters
// its points, a larger one emits a work item per tile its ellipse reaches, its rows spread over
// its subgroup
const sampleSplatsWGSL = /* wgsl */ `
${sampleCommonWGSL}

@compute @workgroup_size(256)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32,
    @builtin(subgroup_invocation_id) lane: u32,
    @builtin(subgroup_size) lanes: u32
) {
    // no early returns: the subgroup hands out its large splats together
    let order = (wg.x + wg.y * numWorkgroups.x) * 256u + local;
    let live = order < counter[0];
    let slot = select(0u, orderedSlots[min(order, max(counter[0], 1u) - 1u)], live);
    var g = geometryOf(slot);
    let base = slot * ${CACHE_WORDS}u;
    let opacityByte = (cache[base + 3u] >> 16u) & 0xffu;
    g.valid = g.valid && live && opacityByte < uniforms.opacityLimit;
    let axis1 = unpack2x16float(cache[base + 2u]);
    let len1 = length(axis1);
    let len2 = unpack2x16float(cache[base + 3u]).x;
    // by the expected count, not a drawn one: a count conditioned on its own size is biased
    let expected = totals[opacityByte] * len1 * len2;
    let large = g.valid && expected > ${SAMPLE_DIRECT_POINTS}.0;
    if (g.valid && !large && (uniforms.debugFlags & 2u) == 0u) {
        var state = seedOf(slot);
        let points = poisson(expected, &state);
        atomicAdd(&itemCount[1], points);
        // the axes in framebuffer pixels (y down)
        let f = uniforms.flip;
        let dir = axis1 / max(len1, 1e-12);
        let a1 = vec2f(axis1.x, -f * axis1.y);
        let a2 = len2 * vec2f(dir.y, f * dir.x);
        let color = colorOf(g.color);
        let row = opacityByte * ${SAMPLE_TABLE_STEPS + 1}u;
        for (var k = 0u; k < points; k++) {
            let h = hashU32(state ^ (k * 0x9e3779b9u));
            let t = f32(h & 0xffffu) * (${SAMPLE_TABLE_STEPS}.0 / 65536.0);
            let step = u32(t);
            let r = mix(radii[row + step], radii[row + step + 1u], t - f32(step));
            let angle = f32(h >> 16u) * (6.2831853 / 65536.0);
            let uv = r * vec2f(cos(angle), sin(angle));
            claim(g, color, uv.x * a1 + uv.y * a2, hashU32(h ^ 0x68e31da4u));
        }
    }
    var pending = subgroupBallot(large).x;
    while (pending != 0u) {
        let owner = firstTrailingBit(pending);
        pending &= pending - 1u;
        let bigSlot = subgroupShuffle(slot, owner);
        let bg = geometryOf(bigSlot);
        for (var ty = bg.tileMin.y + i32(lane); ty <= bg.tileMax.y; ty += i32(lanes)) {
            let span = tileSpan(bg, ty);
            if (span.x <= span.y) {
                let n = u32(span.y - span.x + 1);
                let first = atomicAdd(&itemCount[0], n);
                for (var i = 0u; i < n && first + i < uniforms.itemCapacity; i++) {
                    items[first + i] = vec2u(bigSlot, u32(ty) * uniforms.tilesX + u32(span.x) + i);
                }
            }
        }
    }
}
`;

// A thread per item (a splat over a tile), 64 a workgroup: thousands of 16-invocation workgroups
// cost Mali more to schedule than their work. The tile's densest point: the nearest, in the
// splat's own metric, of the tile's area
const sampleTilesWGSL = /* wgsl */ `
${sampleCommonWGSL}

// the least r^2 over the rectangle [lo, hi] (offsets from the centre): 0 if it holds the centre,
// else the least along its edges, each a 1D quadratic
fn nearestR2(q: vec3f, lo: vec2f, hi: vec2f) -> f32 {
    if (all(lo <= vec2f(0.0)) && all(hi >= vec2f(0.0))) {
        return 0.0;
    }
    var best = 1e30;
    for (var e = 0u; e < 2u; e++) {
        let x = select(lo.x, hi.x, e == 1u);
        let y = clamp(-q.y * x / q.z, lo.y, hi.y);
        best = min(best, q.x * x * x + 2.0 * q.y * x * y + q.z * y * y);
        let yy = select(lo.y, hi.y, e == 1u);
        let xx = clamp(-q.y * yy / q.x, lo.x, hi.x);
        best = min(best, q.x * xx * xx + 2.0 * q.y * xx * yy + q.z * yy * yy);
    }
    return best;
}

@compute @workgroup_size(64)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    let index = (wg.x + wg.y * numWorkgroups.x) * 64u + local;
    if (index >= min(atomicLoad(&itemCount[0]), uniforms.itemCapacity)) {
        return;
    }
    let item = items[index];
    let g = geometryOf(item.x);
    let color = colorOf(g.color);
    let tile = vec2u(item.y % uniforms.tilesX, item.y / uniforms.tilesX);
    let origin = vec2f(tile * ${TILE_SIZE}u);
    let size = min(vec2f(${TILE_SIZE}.0), vec2f(uniforms.viewportW, uniforms.viewportH) - origin);
    let lo = origin - g.center;
    let alphaMax = min(uniforms.maxAlpha, g.opacity * (exp(-4.0 * nearestR2(g.q, lo, lo + size)) - EXP_M4) / (1.0 - EXP_M4));
    if (alphaMax < uniforms.alphaClip) {
        return;
    }
    let seed = seedOf(item.x) ^ hashU32(item.y * 0x27d4eb2du);
    let lambdaMax = -log(1.0 - alphaMax);
    if (lambdaMax <= 1.0) {
        // candidates at the densest lambda, thinned to the local one
        var state = seed;
        let candidates = poisson(lambdaMax * size.x * size.y, &state);
        for (var k = 0u; k < candidates; k++) {
            let h = hashU32(seed ^ (k * 0x9e3779b9u));
            let h2 = hashU32(h ^ 0x68e31da4u);
            let d = lo + vec2f(f32(h & 0xffffu), f32(h >> 16u)) * (size / 65536.0);
            let alpha = min(uniforms.maxAlpha, alphaAt(g, d));
            if (alpha >= uniforms.alphaClip && f32(h2 >> 8u) * (1.0 / 16777216.0) * lambdaMax < -log(1.0 - alpha)) {
                claim(g, color, d, hashU32(h2));
            }
        }
    } else {
        // dense: every pixel of the tile against its threshold, at its centre
        let count = u32(size.x) * u32(size.y);
        for (var p = 0u; p < count; p++) {
            let d = lo + vec2f(f32(p % u32(size.x)), f32(p / u32(size.x))) + vec2f(0.5);
            let h = hashU32(seed ^ (p * 0x9e3779b9u));
            let alpha = alphaAt(g, d);
            if (alpha >= uniforms.alphaClip && f32(h >> 8u) * (1.0 / 16777216.0) < alpha) {
                claim(g, color, d, hashU32(h ^ 0x68e31da4u));
            }
        }
    }
}
`;

// the tile pass's workgroups, 2D past the 65535 limit
const sampleArgsWGSL = /* wgsl */ `
struct ArgsUniforms {
    dispatchSlot: u32,
    itemCapacity: u32
}

@group(0) @binding(0) var<storage, read> itemCount: array<u32>;
@group(0) @binding(1) var<storage, read_write> indirectDispatchArgs: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: ArgsUniforms;

@compute @workgroup_size(1)
fn main() {
    let groups = (min(itemCount[0], uniforms.itemCapacity) + 63u) / 64u;
    let x = max(min(groups, 65535u), 1u);
    let base = uniforms.dispatchSlot * 3u;
    indirectDispatchArgs[base] = x;
    indirectDispatchArgs[base + 1u] = max((groups + x - 1u) / x, 1u);
    indirectDispatchArgs[base + 2u] = 1u;
}
`;

// The resolve, a fullscreen pass into the raster target: each pixel's key as its colour and
// depth, or nothing where no point landed
const sampleResolveVertexWGSL = /* wgsl */ `
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(vertex_position, 0.0, 1.0);
    return output;
}
`;

// with merge (variant pipeline:hybrid) the raster has drawn the solid splats into the target first:
// a pixel no point reached keeps what it drew, and one a point reached takes the nearer of the two
const sampleResolveFragmentWGSL = (farClipZ: number, merge: boolean) => /* wgsl */ `
var<storage, read> pixels: array<u32>;
// width, isOrtho, and the raster depth mapping a, b
uniform resolveParams: vec4f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let pix = vec2u(pcPosition.xy);
    let key = pixels[pix.y * u32(uniform.resolveParams.x) + pix.x];
    if (key == 0u) {
        ${
            merge
                ? 'discard;'
                : `output.color = vec4f(0.0);
        output.fragDepth = 1.0;
        return output;`
        }
    }
    output.color = vec4f(vec3f(vec3u(key >> 8u, key >> 4u, key) & vec3u(15u)) * (1.0 / 15.0), 1.0);
    let depth = bitcast<f32>((~key & 0xfffff000u) | 0x800u);
    let ortho = uniform.resolveParams.y > 0.5;
    let w = select(depth, 1.0, ortho);
    output.fragDepth = min(clamp(uniform.resolveParams.z * depth + uniform.resolveParams.w, 0.0, w) / w, ${farClipZ});
    return output;
}
`;

export {
    SAMPLE_TABLE_STEPS,
    buildSampleTables,
    sampleArgsWGSL,
    sampleResolveFragmentWGSL,
    sampleResolveVertexWGSL,
    sampleSplatsWGSL,
    sampleTilesWGSL
};
