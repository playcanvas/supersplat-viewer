// The projector: one 256-thread workgroup per chunk of the resident set. Each thread reads one
// splat through the source's read code, projects it, applies the culls, and survivors append
// themselves to a dense cache with one global atomic per workgroup. The chunk table and node
// visibility come from the cpu (resident-set rebuild on version change, frustum cull per frame).

/** Words per cache entry. See the layout in the plan: ndc, depth, axis1, len2|alpha|flags, rgb, popless, id. */
const CACHE_WORDS = 7;

const PROJECTOR_WORKGROUP_SIZE = 256;

/** Buckets of the counting order (order:bucket); the workgroup size, so each thread owns one. */
const ORDER_BUCKETS = PROJECTOR_WORKGROUP_SIZE;

/** Splats per chunk-table entry; a chunk is one workgroup. */
const CHUNK_SIZE = PROJECTOR_WORKGROUP_SIZE;

// the polygon's circumradius over the ellipse's: so the two cover the same area, or so the
// polygon contains the ellipse (variant jitter, whose fragments discard outside it)
const polygonScale = (sides: number, circumscribed = false) =>
    (circumscribed
        ? 1 / Math.cos(Math.PI / sides)
        : Math.sqrt((2 * Math.PI) / (sides * Math.sin((2 * Math.PI) / sides)))
    ).toFixed(6);

/** Where the coverage threshold varies: per pixel, per splat, or per splat and interleaved pixel set. */
type CoverageMode = 'pixel' | 'splat' | 'interleaved';

/**
 * Draw groups with coverage:interleaved: the four pixel sets (0-3) and the full target (4),
 * which takes the splats below the variant's interleaveArea; each is one contiguous range of the
 * ordered list. (A third tier, the largest splats into quarter-resolution targets per set, one
 * fragment per 4x4 block, was tried and lost on the Pixel 7 Pro: drawn in their own passes the
 * large splats lose the occlusion the sets' nearer splats give them, and the fullscreen draw
 * that carried them into a set's target with frag_depth disabled early depth rejection for the
 * polygons drawn after it in that pass, 3-5 ms with nothing in the targets.)
 */
const SET_GROUPS = 5;

/** Depth buckets per draw group with coverage:interleaved; the groups share the ORDER_BUCKETS. */
const SET_BUCKETS = Math.floor(ORDER_BUCKETS / SET_GROUPS);

/** Cache word 6 with coverage other than pixel: bit 15 marks a full-target entry of the interleaved mode. */
const FULL_ENTRY_BIT = 0x8000;
/** The bits of word 6 below it: the splat's threshold draw. */
const DRAW_BITS = 15;

// the 24 orders of the four strata, 2 bits a set, for the jittered pixel sets
const permutations = (() => {
    const out: number[] = [];
    const walk = (rest: number[], packed: number, shift: number) => {
        if (!rest.length) {
            out.push(packed);
            return;
        }
        for (let i = 0; i < rest.length; i++) {
            walk([...rest.slice(0, i), ...rest.slice(i + 1)], packed | (rest[i] << shift), shift + 2);
        }
    };
    walk([0, 1, 2, 3], 0, 0);
    return out;
})();

const projectorWGSL = (
    readChunk: string,
    occlusion: boolean,
    order: boolean,
    coverage: CoverageMode,
    // of the polygon a splat's kept region draws as, with coverage other than pixel
    sides: number
) => /* wgsl */ `
struct ProjectorUniforms {
    view: mat4x4f,
    viewProj: mat4x4f,
    // the previous frame, for the occlusion cull: its view and view-projection, its clip-z
    // mapping (a, b, isOrtho, 0), viewport and focal length
    prevViewProj: mat4x4f,
    prevView: mat4x4f,
    prevClipZ: vec4f,
    viewport: vec2f,
    focal: vec2f,
    prevViewport: vec2f,
    prevFocal: vec2f,
    numChunks: u32,
    splatTextureSize: u32,
    isOrtho: u32,
    minPixelSize: f32,
    alphaClip: f32,
    minContribution: f32,
    // the occlusion grid: level 1 (8 px) and level 2 (32 px) block counts
    occBlocksX1: u32,
    occBlocksY1: u32,
    occBlocksX2: u32,
    occBlocksY2: u32,
    // 0 off, 1 level 1 only, 2 both levels
    occlusionMode: u32,
    // -1 when the previous depth texture's rows run bottom-up (an offscreen target), else 1
    prevFlip: f32,
    // the order key: bucket = (log(depth) - keyLogNear) * keyInvLogRange, over [0, 1)
    keyLogNear: f32,
    keyInvLogRange: f32,
    // first chunk-table entry of this dispatch (per-file sources dispatch one run each)
    chunkBase: u32,
    // the file's model transform, for sources that read splats in the file's own space
    model: mat4x4f,
    modelRotation: vec4f,
    modelScale: vec4f,
    cameraPosition: vec4f,
    // colour ceiling per channel: 8 keeps the cache's range, 1 clamps like the engine's 8-bit cache
    colorMax: f32,
    // 1: covariance in true pixels. 2: the engine's convention (its focal is viewport * proj[0][0],
    // twice the pixel focal), which makes its 0.3 dilation 0.075 px^2 and scales its culls
    unitScale: f32,
    // the view depths of the near plane and of the raster's far clamp
    depthNear: f32,
    depthFar: f32,
    // the coverage seed (variant coverage:splat; see the raster's frameSeed)
    frameSeed: u32,
    // coverage:splat applies to splats with an opacity byte at least this; fainter ones keep
    // their quads, for the compute sampler (variant pipeline:hybrid)
    coverageLimit: u32,
    // variant jitter: sub-strata a stratum splits into (0: no jitter), and the strata a per-splat
    // threshold draws from (coverage:splat, and the full target's splats of the interleaved mode)
    jitterSubs: u32,
    strata: u32,
    // coverage:interleaved: splats whose footprint at the alpha clip is below this many pixels
    // draw per splat into the full target instead of into the pixel sets (0: none)
    interleaveArea: f32
}

// chunk table entry: slotBase, count, node, lod | file << 16
@group(0) @binding(0) var<storage, read> chunks: array<vec4u>;
// one bit per node: 1 = inside the frustum this frame
@group(0) @binding(1) var<storage, read> nodeVisible: array<u32>;
@group(0) @binding(2) var<storage, read_write> cache: array<u32>;
// [0] survivors this frame, [1] splats the occlusion cull removed
@group(0) @binding(3) var<storage, read_write> counter: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> uniforms: ProjectorUniforms;
// the previous frame's farthest depth per block, as f32 bits (see shaders/reduce.ts)
@group(0) @binding(5) var<storage, read> occL1: array<u32>;
@group(0) @binding(6) var<storage, read> occL2: array<u32>;
// order:bucket: survivors per depth bucket (see shaders/order.ts)
@group(0) @binding(7) var<storage, read_write> buckets: array<atomic<u32>>;

struct Splat {
    index: u32,
    uv: vec2i
}
var<private> splat: Splat;
fn setSplat(idx: u32) {
    splat.index = idx;
    splat.uv = vec2i(i32(idx % uniforms.splatTextureSize), i32(idx / uniforms.splatTextureSize));
}

${readChunk}
${
    coverage !== 'pixel'
        ? `
// integer hash (Wellons' prospector mix), as the raster's
fn hashU32(x: u32) -> u32 {
    var v = x;
    v ^= v >> 16u;
    v *= 0x7feb352du;
    v ^= v >> 15u;
    v *= 0x846ca68bu;
    v ^= v >> 16u;
    return v;
}

// the radius, in units of the quad's half extent, where alpha = opacity * falloff(r^2) falls to
// a threshold, with falloff(x) = (exp(-4 x) - exp(-4)) / (1 - exp(-4))
fn radiusAt(threshold: f32, opacity: f32) -> f32 {
    let e4 = exp(-4.0);
    return sqrt(max(-log(threshold / opacity * (1.0 - e4) + e4) * 0.25, 0.0));
}

// the 24 orders of four strata, 2 bits a set
const PERMUTATIONS = array<u32, 24>(${permutations.map((p) => `${p}u`).join(', ')});
`
        : ''
}
// quaternion (x, y, z, w) to a rotation matrix (columns)
fn rotationMatrix(qIn: vec4f) -> mat3x3f {
    let q = normalize(qIn);
    let x = q.x;
    let y = q.y;
    let z = q.z;
    let w = q.w;
    return mat3x3f(
        vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
        vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
        vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
    );
}

struct Projected {
    valid: bool,
    occluded: bool,
    words: array<u32, ${CACHE_WORDS}>
}

// The farthest depth over the (2g+1)^2 blocks around a block, on one grid level.
fn farthestL1(block: vec2i, gather: i32, blocks: vec2i) -> u32 {
    var farthest = 0u;
    for (var dy = -gather; dy <= gather; dy++) {
        for (var dx = -gather; dx <= gather; dx++) {
            farthest = max(farthest, occL1[u32((block.y + dy) * blocks.x + block.x + dx)]);
        }
    }
    return farthest;
}

fn farthestL2(block: vec2i, gather: i32, blocks: vec2i) -> u32 {
    var farthest = 0u;
    for (var dy = -gather; dy <= gather; dy++) {
        for (var dx = -gather; dx <= gather; dx++) {
            farthest = max(farthest, occL2[u32((block.y + dy) * blocks.x + block.x + dx)]);
        }
    }
    return farthest;
}

fn project(slot: u32, file: u32) -> Projected {
    var result: Projected;
    result.valid = false;
    result.occluded = false;

    setSplat(slot);
    let center = srcCenter();
    let opacity = srcOpacity();
    if (opacity < uniforms.alphaClip) {
        return result;
    }
${
    coverage !== 'pixel'
        ? `
    // Variant coverage:splat: one coverage threshold per splat and frame instead of one per
    // pixel. The pixels where alpha exceeds it form a solid ellipse, which the raster draws as a
    // polygon of the same area with no discard, so a gpu updates depth early and rejects what
    // lies behind it before rasterising it. Each pixel is still kept with probability alpha,
    // independently per splat; the noise is a splat at a random size rather than a dither. The
    // threshold is hashed afresh every frame: one sequence shared by every splat, rotated per
    // splat, would keep two splats' thresholds a fixed distance apart, so their coverage would
    // stay correlated over frames and the accumulation would converge to the wrong image. A
    // splat whose opacity does not exceed its threshold keeps nothing this frame and stops here.
    // The draw goes into cache word 6 as ${DRAW_BITS} bits, and the raster rebuilds the same
    // thresholds from them (shaders/raster.ts).
    let id = slot ^ (file * 2654435761u);
    let hashed = hashU32(((id + 1u) * 26699u) ^ uniforms.frameSeed);
    let drawnBits = hashed >> ${32 - DRAW_BITS}u;
    let drawn = f32(drawnBits) * (1.0 / ${(1 << DRAW_BITS) - 1}.0);
    // Variant jitter: the threshold is the base of a random stratum instead of the draw itself,
    // and every pixel adds its own jitter within the stratum in the raster, so the kept region
    // is the stratum's ellipse with a dithered rim rather than a solid one. Each pixel's
    // threshold is still uniform over [0, 1) and independent per splat, so the expectation is
    // unchanged, but neighbouring pixels no longer all agree. Sub-strata (jitterSubs above 1)
    // narrow the jitter: smaller polygons, more agreement.
    let subs = uniforms.jitterSubs;
    let jittered = subs > 0u;
    let subMask = max(subs, 1u) - 1u;
    // the per-splat threshold (coverage:splat, and the small splats of the interleaved mode): a
    // stratum of \`strata\`, its sub-stratum, and the nibble the raster reads them back from
    // (kept | stratum << 1 | sub << 3)
    let strata = max(uniforms.strata, 1u);
    let splatStratum = min(u32(drawn * f32(strata)), strata - 1u);
    let splatSub = (hashed >> 15u) & subMask;
    let splatBase = select(drawn, f32(splatStratum * max(subs, 1u) + splatSub) / f32(strata * max(subs, 1u)), jittered);
    let splatNibble = 1u | (splatStratum << 1u) | (splatSub << 3u);
    let splatThreshold = max(splatBase, uniforms.alphaClip);
    let splatKept = splatThreshold < opacity;
${
    coverage === 'interleaved'
        ? `
    // Variant coverage:interleaved: the pixels split into four interleaved sets, the four of a
    // 2x2 quad, and each set takes its own threshold, the four quarters of [0, 1) from the one
    // draw: a quad holds the splat at four stratified sizes, so its mean is nearly the splat's
    // alpha, as the per-pixel thresholds' is, and neighbouring pixels are no longer all one
    // splat. Jittered, the sets take the four strata in a random order, each within a random
    // sub-stratum, and their pixels jitter inside it
    var setBases = fract(vec4f(drawn) + vec4f(0.0, 0.25, 0.5, 0.75));
    var setNibbles = vec4u(0u);
    if (jittered) {
        let bits = hashU32(hashed ^ 0x9e3779b9u);
        let packed = PERMUTATIONS[bits % 24u];
        let perm = (vec4u(packed) >> vec4u(0u, 2u, 4u, 6u)) & vec4u(3u);
        let subsOf = (vec4u(bits) >> vec4u(8u, 10u, 12u, 14u)) & vec4u(subMask);
        setBases = vec4f(perm * subs + subsOf) / f32(4u * subs);
        setNibbles = (perm << vec4u(1u)) | (subsOf << vec4u(3u));
    }
    let setThresholds = max(setBases, vec4f(uniforms.alphaClip));
    let keptSets = setThresholds < vec4f(opacity);
    setNibbles = select(vec4u(0u), setNibbles | vec4u(1u), keptSets);
    // whether the splat draws into the sets or the full target waits for its footprint; a splat
    // keeping nothing either way stops here
    if (!any(keptSets) && !splatKept) {
        return result;
    }
    let lowest = select(vec4f(2.0), setThresholds, keptSets);
    let setThreshold = min(min(lowest.x, lowest.y), min(lowest.z, lowest.w));
`
        : `
    let perSplat = u32(clamp(opacity, 0.0, 1.0) * 255.0 + 0.5) >= uniforms.coverageLimit;
    if (perSplat && !splatKept) {
        return result;
    }
`
}
`
        : ''
}
    let viewCenter = uniforms.view * vec4f(center, 1.0);
    let depth = -viewCenter.z;
    if (uniforms.isOrtho == 0u && depth <= 0.0) {
        return result;
    }
    let clip = uniforms.viewProj * vec4f(center, 1.0);
    if (clip.w == 0.0) {
        return result;
    }

    let viewport = uniforms.viewport;
    let focal = uniforms.focal;

    // the work buffer holds world-space splats, so the view matrix is the model-view
    let rot = srcRotation();
    let scale = srcScale();
    let linear = mat3x3f(uniforms.view[0].xyz, uniforms.view[1].xyz, uniforms.view[2].xyz);
    let gaussian = linear * rotationMatrix(vec4f(rot.yzw, rot.x)) * mat3x3f(
        vec3f(scale.x, 0.0, 0.0),
        vec3f(0.0, scale.y, 0.0),
        vec3f(0.0, 0.0, scale.z)
    );
    let row0 = vec3f(gaussian[0].x, gaussian[1].x, gaussian[2].x);
    let row1 = vec3f(gaussian[0].y, gaussian[1].y, gaussian[2].y);
    let row2 = vec3f(gaussian[0].z, gaussian[1].z, gaussian[2].z);
    let c00 = dot(row0, row0);
    let c01 = dot(row0, row1);
    let c02 = dot(row0, row2);
    let c11 = dot(row1, row1);
    let c12 = dot(row1, row2);
    let c22 = dot(row2, row2);

    var cov00: f32;
    var cov01: f32;
    var cov11: f32;
    if (uniforms.isOrtho != 0u) {
        cov00 = focal.x * focal.x * c00;
        cov01 = focal.x * focal.y * c01;
        cov11 = focal.y * focal.y * c11;
    } else {
        let safeDepth = max(depth, 0.001);
        let invDepth = 1.0 / safeDepth;
        let jx0 = focal.x * invDepth;
        let jx2 = focal.x * viewCenter.x * invDepth * invDepth;
        let jy1 = focal.y * invDepth;
        let jy2 = focal.y * viewCenter.y * invDepth * invDepth;
        let u00 = jx0 * c00 + jx2 * c02;
        let u01 = jx0 * c01 + jx2 * c12;
        let u02 = jx0 * c02 + jx2 * c22;
        let u11 = jy1 * c11 + jy2 * c12;
        let u12 = jy1 * c12 + jy2 * c22;
        cov00 = u00 * jx0 + u02 * jx2;
        cov01 = u01 * jy1 + u02 * jy2;
        cov11 = u11 * jy1 + u12 * jy2;
    }

    // the low-pass dilation every splat renderer applies, 0.3 in the chosen units
    let us2 = uniforms.unitScale * uniforms.unitScale;
    cov00 += 0.3 / us2;
    cov11 += 0.3 / us2;
    let determinant = cov00 * cov11 - cov01 * cov01;
    if (determinant <= 0.0) {
        return result;
    }

    let mid = 0.5 * (cov00 + cov11);
    let radius = length(vec2f(0.5 * (cov00 - cov11), cov01));
    let lambda1 = mid + radius;
    let lambda2 = max(mid - radius, 0.1 / us2);

    // size cull on the footprint's radius in pixels. minPixelSize is a diameter: the engine's
    // projector is dispatched with half of it, and its quad path tests the full extent
    // (2 sqrt(2 lambda)) against the whole value, so both cut at the same place
    if (uniforms.unitScale * sqrt(2.0 * lambda1) < 0.5 * uniforms.minPixelSize) {
        return result;
    }

    // contribution cull: the splat's alpha mass in pixels (the engine's minContribution rule)
    if (opacity * 6.283185 * sqrt(determinant) * us2 < uniforms.minContribution) {
        return result;
    }

    // principal axis; a circular footprint has no defined eigenvector, any axis is right
    let eigenVec = vec2f(cov01, lambda1 - cov00);
    let eigenLen = length(eigenVec);
    let direction = select(vec2f(1.0, 0.0), eigenVec / eigenLen, eigenLen > 1e-9);
    let maxRadius = min(1024.0, min(viewport.x, viewport.y));
    let len1 = 2.0 * sqrt(2.0 * lambda1);
    let len2Full = 2.0 * sqrt(2.0 * lambda2);
    let clampScale = min(1.0, maxRadius / len1);
${
    coverage !== 'pixel'
        ? `
    // The kept ellipse's polygon, in units of the quad's half extent: area matched to the
    // ellipse, or containing it when the raster discards outside it (jitter). The cache keeps
    // the full quad's axes and the raster sizes each polygon itself; here the largest bounds the
    // culls below
    let polygonScale = select(${polygonScale(sides)}, ${polygonScale(sides, true)}, jittered);
${
    coverage === 'interleaved'
        ? `
    // the small splats of the interleaved mode draw per splat into the full target: the
    // footprint at the alpha clip, in pixels, decides
    let footprint = 3.14159265 * len1 * len2Full * pow(radiusAt(max(uniforms.alphaClip, 1e-6), opacity), 2.0);
    let fullEntry = uniforms.interleaveArea > 0.0 && footprint < uniforms.interleaveArea;
    if (select(!any(keptSets), !splatKept, fullEntry)) {
        return result;
    }
    let threshold = select(setThreshold, splatThreshold, fullEntry);
    let radiusScale = clampScale * radiusAt(threshold, opacity) * polygonScale;
`
        : `
    let radiusScale = clampScale * select(1.0, radiusAt(splatThreshold, opacity) * polygonScale, perSplat);
`
}
`
        : `
    let radiusScale = clampScale;
`
}
    // the extent the culls test: the largest polygon the raster will draw
    let axis1 = len1 * radiusScale * direction;
    let len2 = len2Full * radiusScale;
    let axis2 = len2 * vec2f(direction.y, -direction.x);

    let ndc = clip.xy / clip.w;
    let extent = abs(axis1) + abs(axis2);
    let centerPixels = (ndc * 0.5 + 0.5) * viewport;
    if (centerPixels.x + extent.x < 0.0 || centerPixels.x - extent.x > viewport.x
        || centerPixels.y + extent.y < 0.0 || centerPixels.y - extent.y > viewport.y) {
        return result;
    }

${
    occlusion
        ? `
    // Occlusion cull against the previous frame. Each stored depth is the nearest sample that
    // survived there, so the farthest depth over the blocks a splat covered bounds what could
    // still have shown behind it; a splat whose front (its centre less 2 sqrt(2) sigma along the
    // view, the same cut-off as the quad's edge) lies beyond that bound was invisible last
    // frame, up to sampling. Static splats reproject exactly through the previous view, so only
    // true disocclusions arrive a frame late. The footprint the splat had last frame bounds the
    // gather; footprints up to 16 px use the 8 px grid, up to 64 px the 32 px grid, larger ones
    // skip the test.
    if (uniforms.occlusionMode != 0u) {
        let prevClip = uniforms.prevViewProj * vec4f(center, 1.0);
        let prevDepth = -(uniforms.prevView * vec4f(center, 1.0)).z;
        let prevOrtho = uniforms.prevClipZ.z != 0.0;
        if (prevClip.w > 0.0 && (prevOrtho || prevDepth > 0.0)) {
            let prevNdc = prevClip.xy / prevClip.w;
            let halfExtent = len1 * radiusScale;
            let prevHalfExtent = halfExtent * (uniforms.prevFocal.x / focal.x)
                * select(depth / max(prevDepth, 0.001), 1.0, prevOrtho);
            let footprint = max(halfExtent, prevHalfExtent);
            var level = 1u;
            var blockSize = 8.0;
            var blocks = vec2i(i32(uniforms.occBlocksX1), i32(uniforms.occBlocksY1));
            if (footprint > 16.0) {
                level = 2u;
                blockSize = 32.0;
                blocks = vec2i(i32(uniforms.occBlocksX2), i32(uniforms.occBlocksY2));
            }
            if (footprint <= 64.0 && level <= uniforms.occlusionMode) {
                let gather = max(i32(ceil(footprint / blockSize)), 1);
                let prevPixel = vec2f(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * uniforms.prevFlip * 0.5) * uniforms.prevViewport;
                let block = vec2i(floor(prevPixel / blockSize));
                if (block.x >= gather && block.y >= gather && block.x < blocks.x - gather && block.y < blocks.y - gather) {
                    let front = prevDepth - 2.8284 * sqrt(c22);
                    let w = select(front, 1.0, prevOrtho);
                    if (w > 0.0) {
                        let frontZ = clamp(uniforms.prevClipZ.x * front + uniforms.prevClipZ.y, 0.0, w) / w;
                        // the block under the centre first: the neighbourhood's maximum is at
                        // least its maximum, so a splat that block alone cannot cull is visible,
                        // and most splats leave here after one load
                        let centreIndex = u32(block.y * blocks.x + block.x);
                        var farthest = select(occL1[centreIndex], occL2[centreIndex], level == 2u);
                        if (frontZ > bitcast<f32>(farthest)) {
                            if (level == 1u) {
                                farthest = farthestL1(block, gather, blocks);
                            } else {
                                farthest = farthestL2(block, gather, blocks);
                            }
                            if (frontZ > bitcast<f32>(farthest)) {
                                result.occluded = true;
                                return result;
                            }
                        }
                    }
                }
            }
        }
    }

`
        : ''
}
    let color = clamp(srcColor(), vec3f(0.0), vec3f(uniforms.colorMax));

    // rgb: 10/10/10 unorm with a 2-bit shared exponent (scale 1/2/4/8, range [0, 8])
    let maxChannel = max(color.r, max(color.g, color.b));
    var exponent = 0u;
    if (maxChannel > 4.0) {
        exponent = 3u;
    } else if (maxChannel > 2.0) {
        exponent = 2u;
    } else if (maxChannel > 1.0) {
        exponent = 1u;
    }
    let rgb = vec3u(clamp(color / f32(1u << exponent), vec3f(0.0), vec3f(1.0)) * 1023.0 + 0.5);

    // centre as snorm16 over the range the offscreen cull bounds visible centres to; the
    // raster shader derives the same range from its viewport
    let ndcRange = vec2f(1.0) + vec2f(4.0 * maxRadius) / viewport;

    result.valid = true;
    result.words[0] = pack2x16snorm(ndc / ndcRange);
    result.words[1] = bitcast<u32>(depth);
${
    coverage !== 'pixel'
        ? `
    // the full quad's axes (clamped to the radius limit); the raster scales them to each polygon
    result.words[2] = pack2x16float(len1 * clampScale * direction);
    result.words[3] = pack2x16float(vec2f(len2Full * clampScale, 0.0)) | (u32(clamp(opacity, 0.0, 1.0) * 255.0 + 0.5) << 16u);
`
        : `
    result.words[2] = pack2x16float(axis1);
    result.words[3] = pack2x16float(vec2f(len2, 0.0)) | (u32(clamp(opacity, 0.0, 1.0) * 255.0 + 0.5) << 16u);
`
}
${
    order
        ? `
    // the depth bucket, log-spaced from the near plane, in the flags byte
    let key = clamp((log(max(depth, 1e-6)) - uniforms.keyLogNear) * uniforms.keyInvLogRange, 0.0, 0.999) * ${ORDER_BUCKETS}.0;
    result.words[3] |= u32(key) << 24u;
`
        : ''
}
    result.words[4] = rgb.r | (rgb.g << 10u) | (rgb.b << 20u) | (exponent << 30u);
    // Popless depth (StochasticSplats 3.4): the quad is tilted onto the plane through the
    // centre with normal adj(Sigma) mu (view space; adj rather than the inverse, so a flat
    // splat needs no division by its tiny determinant), and the raster gives each corner the
    // depth where its own view ray meets that plane, so hardware interpolation hands every
    // fragment the depth of the Gaussian's peak along its ray instead of the centre's. Stored
    // as g = n.xy / (n . mu): a corner at view offset d (in the plane z = -depth) lands at
    // depth / (1 + g . d). Orthographic rays are parallel, so there n = adj(Sigma) e_z and
    // the corner depth is depth + g . d with g = n.xy / n.z. Bounded so every corner stays
    // within 2 sqrt(2) sigma_z of the centre (the occlusion cull's front margin) and the
    // perspective scale stays positive, and so no corner crosses the near plane or the
    // raster's far clamp: a corner clamped there while the others are not bends the quad, whose
    // two triangles then take different depths and show as polygons (large far splats, the
    // sky, sit right at a far plane fitted to the scene). A centre beyond the clamp stays flat.
    let ortho = uniforms.isOrtho != 0u;
    let a00 = c11 * c22 - c12 * c12;
    let a01 = c02 * c12 - c01 * c22;
    let a02 = c01 * c12 - c02 * c11;
    let a11 = c00 * c22 - c02 * c02;
    let a12 = c01 * c02 - c00 * c12;
    let a22 = c00 * c11 - c01 * c01;
    let toward = select(viewCenter.xyz, vec3f(0.0, 0.0, -1.0), ortho);
    let n = vec3f(
        a00 * toward.x + a01 * toward.y + a02 * toward.z,
        a01 * toward.x + a11 * toward.y + a12 * toward.z,
        a02 * toward.x + a12 * toward.y + a22 * toward.z
    );
    let denom = select(dot(n, viewCenter.xyz), n.z, ortho);
    var g = vec2f(0.0);
    if (abs(denom) > 1e-20) {
        g = n.xy / denom;
        // view units per pixel at the centre's depth, and the quad's half extents in them
        let viewScale = select(depth, 1.0, ortho) / focal;
        let ext = (abs(axis1) + abs(axis2)) * viewScale;
        let bound = abs(g.x) * ext.x + abs(g.y) * ext.y;
        let margin = 2.8284 * sqrt(max(c22, 0.0));
        let inRange = select(
            min(1.0 - depth / uniforms.depthFar, depth / max(uniforms.depthNear, 1e-6) - 1.0),
            min(uniforms.depthFar - depth, depth - uniforms.depthNear),
            ortho
        );
        let limit = max(0.0, min(select(min(0.25, margin / max(depth, 1e-6)), margin, ortho), 0.999 * inRange));
        if (bound > limit) {
            g *= limit / max(bound, 1e-20);
        }
    }
    result.words[5] = pack2x16float(g);
${
    coverage === 'pixel'
        ? `
    // the stable id the coverage hash seeds from: the slot, salted by the file for sources
    // whose indices restart per file
    result.words[6] = slot ^ (file * 2654435761u);
`
        : coverage === 'interleaved'
          ? `
    // the draw's bits, bit 15 for a full-target entry, and a nibble per pixel set (0: the set
    // keeps nothing): the raster rebuilds every threshold from them
    let nibbles = select(setNibbles, vec4u(splatNibble, 0u, 0u, 0u), fullEntry);
    result.words[6] = drawnBits | select(0u, ${FULL_ENTRY_BIT}u, fullEntry)
        | (nibbles.x << 16u) | (nibbles.y << 20u) | (nibbles.z << 24u) | (nibbles.w << 28u);
`
          : `
    // the draw's bits and the per-splat nibble (shaders/raster.ts)
    result.words[6] = drawnBits | (splatNibble << 16u);
`
}
    return result;
}

var<workgroup> wgCount: atomic<u32>;
var<workgroup> wgOccluded: atomic<u32>;
var<workgroup> wgBase: u32;
${order ? `var<workgroup> wgBuckets: array<atomic<u32>, ${ORDER_BUCKETS}>;` : ''}

@compute @workgroup_size(${PROJECTOR_WORKGROUP_SIZE})
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    // no early returns: the barriers below need every thread of the workgroup
    let chunkIndex = wg.x + wg.y * numWorkgroups.x;
${order ? `    atomicStore(&wgBuckets[local], 0u);` : ''}
    var projected: Projected;
    projected.valid = false;
    projected.occluded = false;
    if (chunkIndex < uniforms.numChunks) {
        let chunk = chunks[uniforms.chunkBase + chunkIndex];
        let visible = (nodeVisible[chunk.z >> 5u] >> (chunk.z & 31u)) & 1u;
        if (visible != 0u && local < chunk.y) {
            projected = project(chunk.x + local, chunk.w >> 16u);
        }
    }

    // survivors claim consecutive slots: one workgroup-local count, one global atomic
    var localSlot = 0u;
    if (projected.valid) {
        localSlot = atomicAdd(&wgCount, 1u);
    }
    if (projected.occluded) {
        atomicAdd(&wgOccluded, 1u);
    }
    workgroupBarrier();
    if (local == 0u) {
        let n = atomicLoad(&wgCount);
        wgBase = select(0u, atomicAdd(&counter[0], n), n > 0u);
        let o = atomicLoad(&wgOccluded);
        if (o > 0u) {
            atomicAdd(&counter[1], o);
        }
    }
    workgroupBarrier();
    if (projected.valid) {
        let base = (wgBase + localSlot) * ${CACHE_WORDS}u;
        for (var i = 0u; i < ${CACHE_WORDS}u; i++) {
            cache[base + i] = projected.words[i];
        }
${
    order && coverage === 'interleaved'
        ? `
        // one entry per kept pixel set, or one in the full target's group: the group's
        // ${SET_BUCKETS} buckets, front to back, from the depth bucket
        let depthKey = ((projected.words[3] >> 24u) * ${SET_BUCKETS}u) >> 8u;
        if ((projected.words[6] & ${FULL_ENTRY_BIT}u) != 0u) {
            atomicAdd(&wgBuckets[4u * ${SET_BUCKETS}u + depthKey], 1u);
        } else {
            for (var s = 0u; s < 4u; s++) {
                if (((projected.words[6] >> (16u + 4u * s)) & 1u) != 0u) {
                    atomicAdd(&wgBuckets[s * ${SET_BUCKETS}u + depthKey], 1u);
                }
            }
        }`
        : order
          ? `        atomicAdd(&wgBuckets[projected.words[3] >> 24u], 1u);`
          : ''
}
    }
${
    order
        ? `
    // a chunk's splats are spatially coherent, so few of its buckets are non-empty: one
    // workgroup count each, then one global atomic per non-empty bucket
    workgroupBarrier();
    let bucketCount = atomicLoad(&wgBuckets[local]);
    if (bucketCount > 0u) {
        atomicAdd(&buckets[local], bucketCount);
    }
`
        : ''
}
}
`;

export {
    CACHE_WORDS,
    CHUNK_SIZE,
    DRAW_BITS,
    FULL_ENTRY_BIT,
    ORDER_BUCKETS,
    PROJECTOR_WORKGROUP_SIZE,
    SET_BUCKETS,
    SET_GROUPS,
    polygonScale,
    projectorWGSL
};
export type { CoverageMode };
