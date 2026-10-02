// The sampled stochastic renderer (variant pipeline:sample): the stochastic raster's frame, the
// nearest kept sample per pixel, made in compute without testing the pixels a splat does not
// keep. The raster tests every pixel of a splat's quad against a threshold and keeps it with
// probability alpha; at an overdraw-heavy view 93% of those tests fail. Here each splat instead
// scatters a Poisson number of points with density lambda = -ln(1 - alpha) over its footprint
// (in pixels, from a per-opacity table of the falloff's radial profile), so a pixel receives at
// least one with probability 1 - exp(-lambda) = alpha, independently per pixel and per splat:
// the same statistics as the raster's thresholds (its pixels area-averaged rather than
// point-sampled), at about 1.3 points per kept pixel. Each point takes the depth of the splat's
// popless plane there and claims its pixel with one 32-bit atomicMax of a key packing the
// inverted depth's top 20 bits (0.05 % precision) over the colour at 4 bits a channel, dithered
// so the accumulation converges to the exact colour. Splats come in the projector's front-to-back
// bucket order and a point behind its pixel's key skips the atomic, so most never issue one. A
// splat with more points than one thread should carry hands them to a second pass in batches.
// A fullscreen resolve then writes the keys into the raster target's colour and depth, so the
// accumulation, the compose, the occlusion grid and the picker read an ordinary frame.
import { CACHE_WORDS } from './projector';

/** Radius steps per opacity in the inverse-CDF table. */
const SAMPLE_TABLE_STEPS = 32;

/** Points a splat scatters itself; one with more hands them to the batch pass. */
const SAMPLE_DIRECT_POINTS = 32;

/** Points per batch of the batch pass. */
const SAMPLE_BATCH_POINTS = 64;

const SAMPLE_BATCH_WORKGROUP = 64;

// lambda never exceeds this (alpha is clamped just below 1, where lambda would be infinite)
const SAMPLE_MAX_ALPHA = 0.995;

/**
 * The per-opacity tables: the falloff's radial profile as a Poisson density, its integral over
 * the unit disk (points per unit of uv area, before the axes' scale) and its inverse radial CDF.
 *
 * @param alphaClip - Alpha below which nothing is kept.
 * @returns totals[256] and radii[256 * (SAMPLE_TABLE_STEPS + 1)].
 */
const buildSampleTables = (alphaClip: number) => {
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
            const alpha = Math.min(SAMPLE_MAX_ALPHA, (opacity * (Math.exp(-4 * r * r) - e4)) / (1 - e4));
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
struct SampleUniforms {
    viewportW: f32,
    viewportH: f32,
    focalX: f32,
    focalY: f32,
    flip: f32,
    isOrtho: u32,
    frameSeed: u32,
    batchCapacity: u32
}

@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read> cache: array<u32>;
@group(0) @binding(2) var<storage, read> orderedSlots: array<u32>;
@group(0) @binding(3) var<storage, read> totals: array<f32>;
@group(0) @binding(4) var<storage, read> radii: array<f32>;
@group(0) @binding(5) var<storage, read_write> pixels: array<atomic<u32>>;
// slot, first point, points, the splat's seed
@group(0) @binding(6) var<storage, read_write> batches: array<vec4u>;
// [0] batches this frame
@group(0) @binding(7) var<storage, read_write> batchCount: array<atomic<u32>>;
@group(0) @binding(8) var<uniform> uniforms: SampleUniforms;

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

struct Splat {
    center: vec2f,
    axis1: vec2f,
    axis2: vec2f,
    depth: f32,
    gradient: vec2f,
    opacity: u32,
    color: vec3f,
    seed: u32
}

fn splatOf(slot: u32) -> Splat {
    var s: Splat;
    let base = slot * ${CACHE_WORDS}u;
    let size = vec2f(uniforms.viewportW, uniforms.viewportH);
    let maxRadius = min(1024.0, min(size.x, size.y));
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / size;
    let ndc = unpack2x16snorm(cache[base]) * ndcRange;
    s.depth = bitcast<f32>(cache[base + 1u]);
    // the axes in framebuffer pixels (y down)
    let f = uniforms.flip;
    let axis1 = unpack2x16float(cache[base + 2u]);
    let word3 = cache[base + 3u];
    let len2 = unpack2x16float(word3).x;
    let dir = axis1 / max(length(axis1), 1e-12);
    s.axis1 = vec2f(axis1.x, -f * axis1.y);
    s.axis2 = len2 * vec2f(dir.y, f * dir.x);
    s.opacity = (word3 >> 16u) & 0xffu;
    s.center = vec2f((ndc.x * 0.5 + 0.5) * size.x, (0.5 - f * ndc.y * 0.5) * size.y);
    let ortho = uniforms.isOrtho != 0u;
    let g = unpack2x16float(cache[base + 5u]) * select(s.depth, 1.0, ortho);
    s.gradient = vec2f(g.x / uniforms.focalX, -f * g.y / uniforms.focalY);
    let bits = cache[base + 4u];
    s.color = min(vec3f(vec3u(bits, bits >> 10u, bits >> 20u) & vec3u(1023u)) * (f32(1u << (bits >> 30u)) / 1023.0), vec3f(1.0));
    s.seed = hashU32(((cache[base + 6u] + 1u) * 26699u) ^ uniforms.frameSeed);
    return s;
}

// the points a splat scatters this frame: the table's total times its footprint's area
fn pointsOf(s: Splat, state: ptr<function, u32>) -> u32 {
    let area = abs(s.axis1.x * s.axis2.y - s.axis1.y * s.axis2.x);
    return poisson(totals[s.opacity] * area, state);
}

// point k of the splat: a radius from the table, an angle, a pixel; its key claims the pixel if
// nearer than what holds it
fn scatter(s: Splat, k: u32) {
    let h = hashU32(s.seed ^ (k * 0x9e3779b9u));
    let t = f32(h & 0xffffu) * (${SAMPLE_TABLE_STEPS}.0 / 65536.0);
    let step = u32(t);
    let row = s.opacity * ${SAMPLE_TABLE_STEPS + 1}u;
    let r = mix(radii[row + step], radii[row + step + 1u], t - f32(step));
    let angle = f32(h >> 16u) * (6.2831853 / 65536.0);
    let uv = r * vec2f(cos(angle), sin(angle));
    let offset = uv.x * s.axis1 + uv.y * s.axis2;
    let p = s.center + offset;
    if (p.x < 0.0 || p.y < 0.0 || p.x >= uniforms.viewportW || p.y >= uniforms.viewportH) {
        return;
    }
    let shift = dot(s.gradient, offset);
    let depth = select(s.depth / (1.0 + clamp(shift, -0.5, 0.5)), s.depth + shift, uniforms.isOrtho != 0u);
    // the colour at 4 bits a channel, dithered by the point's own noise
    let d = hashU32(h ^ 0x68e31da4u);
    let dither = vec3f(vec3u(d, d >> 8u, d >> 16u) & vec3u(255u)) * (1.0 / 256.0);
    let q = min(vec3u(s.color * 15.0 + dither), vec3u(15u));
    let key = (~bitcast<u32>(max(depth, 0.0)) & 0xfffff000u) | (q.r << 8u) | (q.g << 4u) | q.b;
    let index = u32(p.y) * u32(uniforms.viewportW) + u32(p.x);
    if (atomicLoad(&pixels[index]) < key) {
        atomicMax(&pixels[index], key);
    }
}
`;

// One thread per survivor, in the bucket order: its point count, then its points, or batches of
// them for the batch pass
const sampleSplatsWGSL = /* wgsl */ `
${sampleCommonWGSL}

@compute @workgroup_size(256)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    let order = (wg.x + wg.y * numWorkgroups.x) * 256u + local;
    if (order >= counter[0]) {
        return;
    }
    let slot = orderedSlots[order];
    let s = splatOf(slot);
    var state = s.seed;
    let points = pointsOf(s, &state);
    if (points <= ${SAMPLE_DIRECT_POINTS}u) {
        for (var k = 0u; k < points; k++) {
            scatter(s, k);
        }
        return;
    }
    let count = (points + ${SAMPLE_BATCH_POINTS - 1}u) / ${SAMPLE_BATCH_POINTS}u;
    let first = atomicAdd(&batchCount[0], count);
    for (var b = 0u; b < count; b++) {
        if (first + b < uniforms.batchCapacity) {
            let start = b * ${SAMPLE_BATCH_POINTS}u;
            batches[first + b] = vec4u(slot, start, min(points - start, ${SAMPLE_BATCH_POINTS}u), 0u);
        }
    }
}
`;

const sampleBatchesWGSL = /* wgsl */ `
${sampleCommonWGSL}

@compute @workgroup_size(${SAMPLE_BATCH_WORKGROUP})
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    let index = (wg.x + wg.y * numWorkgroups.x) * ${SAMPLE_BATCH_WORKGROUP}u + local;
    if (index >= min(atomicLoad(&batchCount[0]), uniforms.batchCapacity)) {
        return;
    }
    let batch = batches[index];
    let s = splatOf(batch.x);
    for (var k = 0u; k < batch.z; k++) {
        scatter(s, batch.y + k);
    }
}
`;

// the batch pass's workgroups, 2D past the 65535 limit
const sampleArgsWGSL = /* wgsl */ `
struct ArgsUniforms {
    dispatchSlot: u32,
    batchCapacity: u32
}

@group(0) @binding(0) var<storage, read> batchCount: array<u32>;
@group(0) @binding(1) var<storage, read_write> indirectDispatchArgs: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: ArgsUniforms;

@compute @workgroup_size(1)
fn main() {
    let batches = min(batchCount[0], uniforms.batchCapacity);
    let groups = (batches + ${SAMPLE_BATCH_WORKGROUP - 1}u) / ${SAMPLE_BATCH_WORKGROUP}u;
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

const sampleResolveFragmentWGSL = (farClipZ: number) => /* wgsl */ `
var<storage, read> pixels: array<u32>;
// width, isOrtho, and the raster depth mapping a, b
uniform resolveParams: vec4f;

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let pix = vec2u(pcPosition.xy);
    let key = pixels[pix.y * u32(uniform.resolveParams.x) + pix.x];
    if (key == 0u) {
        output.color = vec4f(0.0);
        output.fragDepth = 1.0;
        return output;
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
    SAMPLE_BATCH_POINTS,
    SAMPLE_TABLE_STEPS,
    buildSampleTables,
    sampleArgsWGSL,
    sampleBatchesWGSL,
    sampleResolveFragmentWGSL,
    sampleResolveVertexWGSL,
    sampleSplatsWGSL
};
