// The tile renderer (variant pipeline:compute): the projector's survivors blended front to back
// per pixel in compute, which is the image the stochastic raster converges to (each splat kept
// with probability alpha, the nearest kept one shown), in one frame and with no noise.
//
// Per frame: the bin count walks the survivors front to back (the projector's bucket order),
// gives each a raster record and counts the 16x16 tiles its ellipse reaches, row by row from the
// ellipse's exact extent over each tile row (a splat over many tiles is binned by its whole
// subgroup, its rows over the lanes, so it keeps its place in the order); a scan turns the
// counts into each tile's range of the entry list; the fill writes the entries the same way,
// each keyed by the splat's depth at the tile centre (its popless plane there) and carrying a
// mask of the tile's 4x4 blocks it reaches. The raster sorts each tile's list in workgroup
// memory and blends it front to back (see tileBlendWGSL). It writes the result as the accumulation's history
// (premultiplied colour and coverage, mean depth), which the compose reads, and the depth at
// which each 8x8 block went opaque as the occlusion grid's level 1, so the next frame's projector
// drops what lies behind it. That depth has none of the stochastic depth's holes.
//
// On Mali (Valhall) workgroup memory is ordinary cached memory and a barrier with few warps
// resident drains the core, so the sort keeps its atomics and barriers few (subgroup reductions
// and a subgroup scan). Measured on the Pixel 7 Pro, and rejected: a bitonic sort pass in
// one-warp workgroups (twice as slow), skipping the sort for the binning's bucket order (the
// lists are not ordered by it: within a bucket the scatter's order is arbitrary and the appends
// of concurrent workgroups interleave, half of adjacent entries came out inverted), and a
// subgroup-batched blend sharing records by shuffles (20x slower on Mali, fine on Apple).
import { CACHE_WORDS } from './projector';

const TILE_SIZE = 16;

/** Bounding-box tiles above which a splat is binned by its whole subgroup. */
const BIG_SPLAT_TILES = 32;

// The splat geometry the binning and the sampler (shaders/samples.ts) share: the projector's
// cache entry in framebuffer pixels (x right, y down), its quadratic form in the falloff's units
// (r = 1 at the quad's edge, 2 sqrt(2) sigma), the r^2 where alpha falls to the clip, its popless
// plane, and the tiles its ellipse reaches. It reads cache and uniforms (viewportW,
// viewportH, tilesX, tilesY, focalX, focalY, flip, alphaClip, isOrtho) from the shader including it
const splatGeometryWGSL = /* wgsl */ `
const EXP_M4 = ${Math.exp(-4)};
const LOG2E = ${Math.LOG2E};

struct Geometry {
    valid: bool,
    center: vec2f,
    // r^2 = q.x dx^2 + 2 q.y dx dy + q.z dy^2
    q: vec3f,
    radius2: f32,
    depth: f32,
    // the popless plane: depth at offset d is depth / (1 + dot(gradient, d)), or depth + dot for
    // an orthographic camera
    gradient: vec2f,
    opacity: f32,
    color: u32,
    tileMin: vec2i,
    tileMax: vec2i
}

fn geometryOf(slot: u32) -> Geometry {
    var g: Geometry;
    let base = slot * ${CACHE_WORDS}u;
    let size = vec2f(uniforms.viewportW, uniforms.viewportH);
    let maxRadius = min(1024.0, min(size.x, size.y));
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / size;
    let ndc = unpack2x16snorm(cache[base]) * ndcRange;
    g.depth = bitcast<f32>(cache[base + 1u]);
    let axis1 = unpack2x16float(cache[base + 2u]);
    let word3 = cache[base + 3u];
    let len2 = max(unpack2x16float(word3).x, 1e-6);
    g.opacity = f32((word3 >> 16u) & 0xffu) / 255.0;
    g.color = cache[base + 4u];
    let len1 = max(length(axis1), 1e-6);
    let dir = axis1 / len1;
    let f = uniforms.flip;
    // the axes in framebuffer pixels, over their squared lengths: uv = (d . u1, d . u2)
    let u1 = vec2f(dir.x, -f * dir.y) / len1;
    let u2 = vec2f(dir.y, f * dir.x) / len2;
    g.q = vec3f(u1.x * u1.x + u2.x * u2.x, u1.x * u1.y + u2.x * u2.y, u1.y * u1.y + u2.y * u2.y);
    g.center = vec2f((ndc.x * 0.5 + 0.5) * size.x, (0.5 - f * ndc.y * 0.5) * size.y);
    // alpha = opacity * (exp(-4 r^2) - exp(-4)) / (1 - exp(-4)) reaches the clip here
    g.radius2 = clamp(-log(uniforms.alphaClip / max(g.opacity, 1e-6) * (1.0 - EXP_M4) + EXP_M4) * 0.25, 0.0, 1.0);
    let ortho = uniforms.isOrtho != 0u;
    let gn = unpack2x16float(cache[base + 5u]) * select(g.depth, 1.0, ortho);
    g.gradient = vec2f(gn.x / uniforms.focalX, -f * gn.y / uniforms.focalY);
    let det = max(g.q.x * g.q.z - g.q.y * g.q.y, 1e-30);
    let extent = sqrt(g.radius2 * vec2f(g.q.z, g.q.x) / det);
    let lo = vec2i(floor((g.center - extent) / ${TILE_SIZE}.0));
    let hi = vec2i(floor((g.center + extent) / ${TILE_SIZE}.0));
    let last = vec2i(i32(uniforms.tilesX) - 1, i32(uniforms.tilesY) - 1);
    g.tileMin = max(lo, vec2i(0));
    g.tileMax = min(hi, last);
    g.valid = g.opacity >= uniforms.alphaClip && g.radius2 > 0.0 && all(g.tileMin <= g.tileMax);
    return g;
}

// The tiles of a row the ellipse reaches: those whose pixel centres meet its extent over the
// row's pixel centres. Over a band of rows the extent's right end is concave in y, so its
// maximum is at the rightmost point's y clamped into the band, and the left end likewise
fn tileSpan(g: Geometry, ty: i32) -> vec2i {
    let a = g.q.x;
    let b = g.q.y;
    let c = g.q.z;
    let det = max(a * c - b * b, 1e-30);
    let ymax = sqrt(g.radius2 * a / det);
    let y0 = max(f32(ty) * ${TILE_SIZE}.0 + 0.5 - g.center.y, -ymax);
    let y1 = min(f32(ty) * ${TILE_SIZE}.0 + ${TILE_SIZE - 0.5} - g.center.y, ymax);
    if (y0 > y1) {
        return vec2i(1, 0);
    }
    let xmax = sqrt(g.radius2 * c / det);
    let yRight = clamp(-b * xmax / c, y0, y1);
    let yLeft = clamp(b * xmax / c, y0, y1);
    let right = (-b * yRight + sqrt(max(a * g.radius2 - det * yRight * yRight, 0.0))) / a;
    let left = (-b * yLeft - sqrt(max(a * g.radius2 - det * yLeft * yLeft, 0.0))) / a;
    let x0 = i32(ceil((g.center.x + left - ${TILE_SIZE - 0.5}) / ${TILE_SIZE}.0));
    let x1 = i32(floor((g.center.x + right - 0.5) / ${TILE_SIZE}.0));
    return vec2i(max(x0, g.tileMin.x), min(x1, g.tileMax.x));
}

// The 4x4-pixel blocks of a tile the ellipse reaches, a bit each (row-major), from its extent
// over each block row's pixel centres: the raster's warps skip the entries missing their block
fn tileMask(g: Geometry, tx: i32, ty: i32) -> u32 {
    let a = g.q.x;
    let b = g.q.y;
    let c = g.q.z;
    let det = max(a * c - b * b, 1e-30);
    let ymax = sqrt(g.radius2 * a / det);
    let xmax = sqrt(g.radius2 * c / det);
    var mask = 0u;
    for (var row = 0; row < 4; row++) {
        let top = f32(ty * ${TILE_SIZE} + row * 4) + 0.5 - g.center.y;
        let y0 = max(top, -ymax);
        let y1 = min(top + 3.0, ymax);
        if (y0 > y1) {
            continue;
        }
        let yRight = clamp(-b * xmax / c, y0, y1);
        let yLeft = clamp(b * xmax / c, y0, y1);
        let right = g.center.x + (-b * yRight + sqrt(max(a * g.radius2 - det * yRight * yRight, 0.0))) / a;
        let left = g.center.x + (-b * yLeft - sqrt(max(a * g.radius2 - det * yLeft * yLeft, 0.0))) / a;
        for (var col = 0; col < 4; col++) {
            let x0 = f32(tx * ${TILE_SIZE} + col * 4) + 0.5;
            if (right >= x0 && left <= x0 + 3.0) {
                mask |= 1u << u32(row * 4 + col);
            }
        }
    }
    return mask;
}

// the sort key of a splat in a tile: its plane's depth at the tile centre, as f32 bits
fn tileKey(g: Geometry, tx: i32, ty: i32) -> u32 {
    let d = (vec2f(f32(tx), f32(ty)) + vec2f(0.5)) * ${TILE_SIZE}.0 - g.center;
    let shift = dot(g.gradient, d);
    let depth = select(g.depth / (1.0 + clamp(shift, -0.5, 0.5)), g.depth + shift, uniforms.isOrtho != 0u);
    return bitcast<u32>(max(depth, 0.0));
}
`;

// the binning passes' uniforms, then the geometry
const binCommonWGSL = /* wgsl */ `
struct BinUniforms {
    viewportW: f32,
    viewportH: f32,
    tilesX: u32,
    tilesY: u32,
    focalX: f32,
    focalY: f32,
    // 1 when ndc +y is the target's row 0 (its rows top-down), else -1
    flip: f32,
    alphaClip: f32,
    isOrtho: u32,
    entryCapacity: u32,
    pad0: u32,
    pad1: u32
}

${splatGeometryWGSL}
`;

const binBindingsWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read> cache: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: BinUniforms;
@group(0) @binding(3) var<storage, read_write> tileCounts: array<atomic<u32>>;
// the survivors front to back (the projector's bucket order)
@group(0) @binding(4) var<storage, read> orderedSlots: array<u32>;
@group(0) @binding(5) var<storage, read_write> recordsA: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> recordsB: array<vec4u>;
// slot, key, block mask (and a spare word)
@group(0) @binding(7) var<storage, read_write> entries: array<vec4u>;
`;

// One thread per survivor, front to back. A splat over more than BIG_SPLAT_TILES tiles is
// binned by its whole subgroup at once, its rows spread over the lanes, so no thread runs long
// and the splat still lands in the tiles' lists at its place in the order. The count pass first
// writes the raster record: centre, the exponent's quadratic form (the falloff's exp(-4 r^2) as
// exp2), alpha's scale, depth and colour (unorm8, as the target it ends in)
const binPassWGSL = (fill: boolean) => /* wgsl */ `
diagnostic(off, subgroup_uniformity);
${binCommonWGSL}
${binBindingsWGSL}

fn binRow(slot: u32, g: Geometry, ty: i32) {
    let span = tileSpan(g, ty);
    for (var tx = span.x; tx <= span.y; tx++) {
        let tile = u32(ty) * uniforms.tilesX + u32(tx);
        ${
            fill
                ? `let index = atomicAdd(&tileCounts[tile], 1u);
        if (index < uniforms.entryCapacity) {
            entries[index] = vec4u(slot, tileKey(g, tx, ty), tileMask(g, tx, ty), 0u);
        }`
                : `atomicAdd(&tileCounts[tile], 1u);`
        }
    }
}

@compute @workgroup_size(256)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32,
    @builtin(subgroup_invocation_id) lane: u32,
    @builtin(subgroup_size) lanes: u32
) {
    // no early returns: the subgroup bins its big splats together
    let order = (wg.x + wg.y * numWorkgroups.x) * 256u + local;
    let live = order < counter[0];
    let slot = select(0u, orderedSlots[min(order, max(counter[0], 1u) - 1u)], live);
    var g = geometryOf(slot);
    g.valid = g.valid && live;
    ${
        fill
            ? ''
            : `if (live) {
        let e = -4.0 * LOG2E;
        recordsA[slot] = vec4f(g.center, g.q.x * e, 2.0 * g.q.y * e);
        let bits = g.color;
        let rgb = vec3f(vec3u(bits, bits >> 10u, bits >> 20u) & vec3u(1023u)) * (f32(1u << (bits >> 30u)) / 1023.0);
        recordsB[slot] = vec4u(
            bitcast<u32>(g.q.z * e),
            bitcast<u32>(g.opacity / (1.0 - EXP_M4)),
            bitcast<u32>(g.depth),
            pack4x8unorm(vec4f(min(rgb, vec3f(1.0)), 1.0))
        );
    }`
    }
    let box = g.tileMax - g.tileMin + vec2i(1);
    let big = g.valid && box.x * box.y > ${BIG_SPLAT_TILES};
    if (g.valid && !big) {
        for (var ty = g.tileMin.y; ty <= g.tileMax.y; ty++) {
            binRow(slot, g, ty);
        }
    }
    var pending = subgroupBallot(big).x;
    while (pending != 0u) {
        let owner = firstTrailingBit(pending);
        pending &= pending - 1u;
        let bigSlot = subgroupShuffle(slot, owner);
        let bg = geometryOf(bigSlot);
        for (var ty = bg.tileMin.y + i32(lane); ty <= bg.tileMax.y; ty += i32(lanes)) {
            binRow(bigSlot, bg, ty);
        }
    }
}
`;

const binCountWGSL = binPassWGSL(false);

const binFillWGSL = binPassWGSL(true);

// One workgroup: the tiles' exclusive offsets (into tileOffsets, and into the counts, which the
// fill then advances as cursors), and the entry total. Each thread scans a contiguous run
const tileScanWGSL = /* wgsl */ `
struct ScanUniforms {
    tileCount: u32
}

@group(0) @binding(0) var<storage, read_write> tileCounts: array<u32>;
@group(0) @binding(1) var<storage, read_write> tileOffsets: array<u32>;
// [0] entries this frame
@group(0) @binding(2) var<storage, read_write> entryTotal: array<u32>;
@group(0) @binding(3) var<uniform> uniforms: ScanUniforms;

var<workgroup> partial: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) local: u32) {
    let n = uniforms.tileCount;
    let run = (n + 255u) / 256u;
    let start = min(local * run, n);
    let end = min(start + run, n);
    var sum = 0u;
    for (var i = start; i < end; i++) {
        sum += tileCounts[i];
    }
    partial[local] = sum;
    for (var stride = 1u; stride < 256u; stride <<= 1u) {
        workgroupBarrier();
        let value = select(0u, partial[local - stride], local >= stride);
        workgroupBarrier();
        partial[local] += value;
    }
    var offset = partial[local] - sum;
    for (var i = start; i < end; i++) {
        let count = tileCounts[i];
        tileOffsets[i] = offset;
        tileCounts[i] = offset;
        offset += count;
    }
    if (local == 255u) {
        entryTotal[0] = partial[255];
    }
}
`;

/** Entries a tile sorts in workgroup memory at once; a longer list runs in depth-ordered chunks. */
const TILE_SORT_CAPACITY = 1024;

/** Depth bins of a tile's counting sort, over the tile's own key range. */
const TILE_SORT_BINS = 512;

// The raster: a workgroup per tile, a thread per pixel. The tile's entries are sorted by key with
// a counting sort over the tile's own key range, in chunks of whole bins that fit workgroup
// memory (within a bin, 1/512 of the tile's depth range, the order is the atomics'). The key
// range comes from subgroup reductions and the bin offsets from a subgroup scan, so the sort
// needs few atomics and few barriers: on Mali workgroup memory is ordinary cached memory and a
// barrier drains the core. Each thread then walks the sorted entries, skipping those that miss its
// 4x4 block, until its pixel's transmittance is below 1/255 (what lies behind adds less than a
// level); the workgroup stops between chunks once every pixel has
const tileBlendWGSL = (historyWGSL: string) => /* wgsl */ `
diagnostic(off, subgroup_uniformity);
struct BlendUniforms {
    viewportW: u32,
    viewportH: u32,
    tilesX: u32,
    blocksX1: u32,
    blocksY1: u32,
    entryCapacity: u32,
    isOrtho: u32,
    alphaClip: f32,
    // the raster depth mapping, z = (a * depth + b) / depth (or a * depth + b orthographic)
    clipA: f32,
    clipB: f32
}

@group(0) @binding(0) var<storage, read> tileCounts: array<u32>;
@group(0) @binding(1) var<storage, read> tileOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> entries: array<vec4u>;
@group(0) @binding(3) var<storage, read> recordsA: array<vec4f>;
@group(0) @binding(4) var<storage, read> recordsB: array<vec4u>;
@group(0) @binding(5) var<uniform> uniforms: BlendUniforms;
@group(0) @binding(6) var outColor: texture_storage_2d<rgba16uint, write>;
@group(0) @binding(7) var outInfo: texture_storage_2d<r32uint, write>;
@group(0) @binding(8) var<storage, read_write> occL1: array<u32>;

${historyWGSL}

const EXP_M4 = ${Math.exp(-4)};
const BINS = ${TILE_SORT_BINS}u;
const CAPACITY = ${TILE_SORT_CAPACITY}u;
const OPAQUE = ${1 / 255};

var<workgroup> cursors: array<atomic<u32>, ${TILE_SORT_BINS}>;
var<workgroup> starts: array<u32, ${TILE_SORT_BINS + 1}>;
// per-subgroup totals of the scan (256 threads: at least 8 subgroups, at most 64)
var<workgroup> partials: array<u32, 64>;
var<workgroup> sorted: array<u32, ${TILE_SORT_CAPACITY}>;
var<workgroup> sortedMask: array<u32, ${TILE_SORT_CAPACITY}>;
var<workgroup> keyMin: atomic<u32>;
var<workgroup> keyMax: atomic<u32>;
var<workgroup> done: atomic<u32>;
var<workgroup> doneShared: u32;
// the chunk: first bin, end bin, first entry, entries
var<workgroup> chunk: vec4u;
var<workgroup> blockDepth: array<atomic<u32>, 4>;

fn binOf(key: u32, low: f32, scale: f32) -> u32 {
    return min(u32(max(bitcast<f32>(key) - low, 0.0) * scale), BINS - 1u);
}

fn clipZOf(depth: f32) -> f32 {
    let w = select(depth, 1.0, uniforms.isOrtho != 0u);
    return clamp(uniforms.clipA * depth + uniforms.clipB, 0.0, w) / max(w, 1e-12);
}

@compute @workgroup_size(256)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(local_invocation_index) li: u32,
    @builtin(subgroup_invocation_id) lane: u32,
    @builtin(subgroup_size) lanes: u32
) {
    let tile = wg.y * uniforms.tilesX + wg.x;
    // a 4x4 block of the tile per 16 invocations, and the thread's pixel within it
    let quad = li >> 4u;
    let block = vec2u(quad & 3u, quad >> 2u);
    let local = block * 4u + vec2u(li & 3u, (li >> 2u) & 3u);
    let pixel = wg.xy * ${TILE_SIZE}u + local;
    let inside = pixel.x < uniforms.viewportW && pixel.y < uniforms.viewportH;
    let first = min(tileOffsets[tile], uniforms.entryCapacity);
    let count = min(tileCounts[tile], uniforms.entryCapacity) - first;

    if (li == 0u) {
        atomicStore(&keyMin, 0xffffffffu);
        atomicStore(&keyMax, 0u);
        atomicStore(&done, 0u);
    }
    if (li < 4u) {
        atomicStore(&blockDepth[li], 0u);
    }
    for (var b = li; b < BINS; b += 256u) {
        atomicStore(&cursors[b], 0u);
    }
    workgroupBarrier();

    // the tile's key range: per thread, per subgroup, then one atomic a subgroup
    var lowKey = 0xffffffffu;
    var highKey = 0u;
    for (var i = li; i < count; i += 256u) {
        let key = entries[first + i].y;
        lowKey = min(lowKey, key);
        highKey = max(highKey, key);
    }
    lowKey = subgroupMin(lowKey);
    highKey = subgroupMax(highKey);
    if (lane == 0u) {
        atomicMin(&keyMin, lowKey);
        atomicMax(&keyMax, highKey);
    }
    if (!inside) {
        atomicAdd(&done, 1u);
    }
    workgroupBarrier();
    let low = bitcast<f32>(atomicLoad(&keyMin));
    let high = bitcast<f32>(atomicLoad(&keyMax));
    let scale = f32(BINS) / max(high - low, 1e-20);
    for (var i = li; i < count; i += 256u) {
        atomicAdd(&cursors[binOf(entries[first + i].y, low, scale)], 1u);
    }
    workgroupBarrier();

    // exclusive scan of the bins, two a thread: within each subgroup, then over the subgroups'
    // totals; starts[b] is bin b's first entry, and each bin's cursor starts there
    let h0 = atomicLoad(&cursors[2u * li]);
    let h1 = atomicLoad(&cursors[2u * li + 1u]);
    let pair = h0 + h1;
    let within = subgroupExclusiveAdd(pair);
    let subgroup = li / lanes;
    if (lane == lanes - 1u) {
        partials[subgroup] = within + pair;
    }
    workgroupBarrier();
    var before = 0u;
    for (var g = 0u; g < subgroup; g++) {
        before += partials[g];
    }
    let s0 = before + within;
    starts[2u * li] = s0;
    starts[2u * li + 1u] = s0 + h0;
    atomicStore(&cursors[2u * li], s0);
    atomicStore(&cursors[2u * li + 1u], s0 + h0);
    if (li == 0u) {
        starts[BINS] = count;
    }
    workgroupBarrier();

    let centre = vec2f(pixel) + vec2f(0.5);
    var color = vec3f(0.0);
    var transmittance = 1.0;
    var depthSum = 0.0;
    var opaqueDepth = -1.0;
    var blending = inside;

    var binStart = 0u;
    loop {
        // the next chunk: whole bins from binStart while they fit (a bin bigger than the
        // capacity is cut short)
        if (li == 0u) {
            var binEnd = binStart + 1u;
            while (binEnd < BINS && starts[binEnd + 1u] - starts[binStart] <= CAPACITY) {
                binEnd++;
            }
            chunk = vec4u(binStart, binEnd, starts[binStart], min(starts[binEnd] - starts[binStart], CAPACITY));
        }
        let c = workgroupUniformLoad(&chunk);
        for (var i = li; i < count; i += 256u) {
            let entry = entries[first + i];
            let bin = binOf(entry.y, low, scale);
            if (bin >= c.x && bin < c.y) {
                let position = atomicAdd(&cursors[bin], 1u) - c.z;
                if (position < CAPACITY) {
                    sorted[position] = entry.x;
                    sortedMask[position] = entry.z;
                }
            }
        }
        workgroupBarrier();

        // each thread walks the chunk until its pixel is opaque, skipping the entries that miss its
        // block (a test the block's 16 threads, a Mali warp, take together); no barriers in here.
        // (A subgroup-batched walk, records shared by shuffles, ran 20x slower on Mali)
        let bit = 1u << (block.y * 4u + block.x);
        for (var j = 0u; j < c.w && blending; j++) {
            if ((sortedMask[j] & bit) != 0u) {
                let splat = sorted[j];
                let a = recordsA[splat];
                let b = recordsB[splat];
                let d = centre - a.xy;
                let power = a.z * d.x * d.x + a.w * d.x * d.y + bitcast<f32>(b.x) * d.y * d.y;
                let alpha = bitcast<f32>(b.y) * (exp2(power) - EXP_M4);
                if (alpha >= uniforms.alphaClip) {
                    let weight = transmittance * alpha;
                    color += weight * unpack4x8unorm(b.w).rgb;
                    depthSum += weight * bitcast<f32>(b.z);
                    transmittance -= weight;
                    if (transmittance < OPAQUE) {
                        blending = false;
                        opaqueDepth = bitcast<f32>(b.z);
                        atomicAdd(&done, 1u);
                    }
                }
            }
        }
        workgroupBarrier();
        if (li == 0u) {
            doneShared = atomicLoad(&done);
        }
        let finished = workgroupUniformLoad(&doneShared) >= 256u || c.y >= BINS;
        if (finished) {
            break;
        }
        binStart = c.y;
    }

    if (inside) {
        let coverage = 1.0 - transmittance;
        textureStore(outColor, vec2i(pixel), encodeColor(vec4f(color, coverage)));
        let meanDepth = depthSum / max(coverage, 1e-12);
        textureStore(outInfo, vec2i(pixel), vec4u(encodeInfo(meanDepth, select(0.0, 1.0, coverage > 0.0)), 0u, 0u, 0u));
    }
    // the depth this pixel went opaque at (the far plane where it never did), farthest per 8x8
    // block, as the occlusion grid holds it
    let opaqueZ = select(1.0, clipZOf(opaqueDepth), opaqueDepth > 0.0 && inside);
    atomicMax(&blockDepth[(local.y / 8u) * 2u + local.x / 8u], bitcast<u32>(opaqueZ));
    workgroupBarrier();
    if (li < 4u) {
        let cell = wg.xy * 2u + vec2u(li & 1u, li >> 1u);
        if (cell.x < uniforms.blocksX1 && cell.y < uniforms.blocksY1) {
            occL1[cell.y * uniforms.blocksX1 + cell.x] = atomicLoad(&blockDepth[li]);
        }
    }
}
`;

export { TILE_SIZE, binCountWGSL, binFillWGSL, splatGeometryWGSL, tileBlendWGSL, tileScanWGSL };
