// Temporal accumulation for the stochastic frame. Each frame the raster leaves one sample per
// pixel (a colour where a splat's fragment survived its coverage test, nothing otherwise) and
// the nearest surviving depth; this pass folds it into a per-pixel history of premultiplied
// colour and coverage, so a still camera converges to the expected image over a few hundred
// frames and a moving one keeps most of that history by reprojecting it.
//
// Reprojection uses the sample's own depth: the pixel's world point is carried into the
// previous view and the history is fetched there, clamped to the colours this frame's
// neighbourhood holds so a stale colour cannot survive a disocclusion. A pixel with no sample
// this frame reprojects through the mean depth its own history remembers, so coverage fades out
// where a surface has moved away rather than smearing into the background.
//
// The history is 12 bytes a pixel (24 with the ping-pong). The colour is the running mean as
// 16-bit fixed point: a half float cannot hold it, since its steps in [0.5, 1) are 1 / 2048 and
// the 1 / N step of a 256-sample mean rounds away once a sample lies within 1 / 16 of the mean
// (an error floor of about 5 rms in 8-bit units), while fixed point steps by 1 / 65535
// everywhere, so the same step only rounds away within half an 8-bit level of the mean. The
// depth record is the mean view depth of the pixel's samples and their count in one 32-bit word.

// the most samples the history's count field holds
const TAA_MAX_COUNT = 511;

const taaVertexWGSL = /* wgsl */ `
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(vertex_position, 0.0, 1.0);
    return output;
}
`;

// The history's encoding, shared with the compose that reads it
const taaHistoryWGSL = /* wgsl */ `
const TAA_COLOR_SCALE = 65535.0;

fn decodeColor(v: vec4u) -> vec4f {
    return vec4f(v) / TAA_COLOR_SCALE;
}

// premultiplied colour and coverage: coverage in [0, 1] and colour within it (the Catmull-Rom
// fetch over- and undershoots both), rounded to the nearest step
fn encodeColor(c: vec4f) -> vec4u {
    let a = clamp(c.a, 0.0, 1.0);
    return vec4u(round(vec4f(clamp(c.rgb, vec3f(0.0), vec3f(a)), a) * TAA_COLOR_SCALE));
}

struct HistoryInfo {
    depth: f32,
    count: f32
}

// The mean view depth keeps the float's exponent and top 15 mantissa bits, rounded: a relative
// step of 2^-15, which stalls a 256-sample mean only within 0.4 % of the depth (the depth steers
// the reprojection, where that is far below a pixel). The count takes the low 9 bits
fn decodeInfo(v: u32) -> HistoryInfo {
    var info: HistoryInfo;
    info.depth = bitcast<f32>((v >> 9u) << 8u);
    info.count = f32(v & ${TAA_MAX_COUNT}u);
    return info;
}

// A unit vector in the octahedral encoding (both components in [-1, 1]) and back
fn octDecode(e: vec2f) -> vec3f {
    var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
    let t = max(-n.z, 0.0);
    n.x += select(t, -t, n.x >= 0.0);
    n.y += select(t, -t, n.y >= 0.0);
    return normalize(n);
}

fn octEncode(n: vec3f) -> vec2f {
    let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
    let folded = (vec2f(1.0) - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0));
    return select(p, folded, n.z < 0.0);
}

// The lighting normal the pixel's samples average to, world space, octahedral as unorm16
fn decodeNormal(v: vec4u) -> vec3f {
    return octDecode(vec2f(v.xy) / 32767.5 - vec2f(1.0));
}

fn encodeNormal(n: vec3f) -> vec4u {
    return vec4u(vec2u(round((octEncode(n) + vec2f(1.0)) * 32767.5)), 0u, 0u);
}

fn encodeInfo(depth: f32, count: f32) -> u32 {
    let bits = bitcast<u32>(max(depth, 0.0));
    return (((bits + 0x80u) >> 8u) << 9u) | min(u32(count), ${TAA_MAX_COUNT}u);
}
`;

const taaFragmentWGSL = /* wgsl */ `
var curColor: texture_2d<f32>;
var curColorSampler: sampler;
var curDepth: texture_depth_2d;
// premultiplied colour and coverage, unorm16 (decodeColor)
var histColor: texture_2d<u32>;
// the mean view depth of the pixel's samples and their count, in the previous frame's view
// depths (decodeInfo)
var histInfo: texture_2d<u32>;
// this frame's lighting normals (octahedral, world space) and their history (decodeNormal)
var curNormal: texture_2d<f32>;
var histNormal: texture_2d<u32>;

// the camera's world transform (the inverse view), and its projection's x and y terms: x, y the
// scales, z, w the offsets (the column that multiplies view z for a perspective camera, the
// translation for an orthographic one)
uniform cameraWorld: mat4x4f;
uniform unproject: vec4f;
uniform prevViewProj: mat4x4f;
uniform prevView: mat4x4f;
// clip z = a * viewDepth + b over w = viewDepth (x, y); z: 1 for an orthographic camera
uniform clipZParams: vec4f;
// x: sample cap, y: 1 when the history holds the previous frame, z: 1 when the camera moved
// since that frame, w: the frames the camera has rested, this one included (0 on a frame whose
// resident set changed)
uniform taaParams: vec4f;
// width, height, 1 / width, 1 / height
uniform taaViewport: vec4f;
// x: -1 when the target's rows run bottom-up (an offscreen target), else 1; y: the colour
// clamp width in neighbourhood standard deviations (0: no clamp); z: 1 when the raster's
// thresholds are quad-stratified
uniform taaControl: vec4f;
// x: 1 for a Catmull-Rom history fetch while moving (0: bilinear); y: 1 to reproject through
// the pixel's accumulated mean depth rather than this frame's sample depth; z: image motion in
// pixels a frame that halves the moving sample cap (0: fixed cap)
uniform taaFilter: vec4f;
// 1: write the accumulation state instead of colour (r: count / cap, g: history accepted,
// b: the camera moved since the previous frame)
uniform taaDebug: f32;

${taaHistoryWGSL}

fn viewDepthOf(z: f32) -> f32 {
    let p = uniform.clipZParams;
    let dz = z - p.x;
    let safeDz = select(dz, sign(dz) * 1e-9 + 1e-12, abs(dz) < 1e-9);
    return select(p.y / safeDz, (z - p.y) / p.x, p.z != 0.0);
}

struct Reprojected {
    valid: bool,
    uv: vec2f,
    prevDepth: f32
}

// The previous frame's view depth and texture coordinate of this pixel's point at a view
// depth. The point is built in view space from the depth and the projection's x and y terms,
// then moved by the camera's rigid transform: through the inverse view-projection instead, a
// near plane at 1e-4 of the depth (the viewer's floor once the camera is inside the scene
// bound) leaves a 32-bit float about three digits of the point, a pixel of error that changes
// with every frame's sample depths and shakes the history.
fn reproject(pix: vec2i, viewDepth: f32) -> Reprojected {
    var r: Reprojected;
    let flip = uniform.taaControl.x;
    let uv = (vec2f(pix) + vec2f(0.5)) * uniform.taaViewport.zw;
    let ndc = vec2f(uv.x * 2.0 - 1.0, flip * (1.0 - 2.0 * uv.y));
    let u = uniform.unproject;
    let viewXY = select((ndc + u.zw) * viewDepth, ndc - u.zw, uniform.clipZParams.z != 0.0) / u.xy;
    let world = (uniform.cameraWorld * vec4f(viewXY, -viewDepth, 1.0)).xyz;
    let prevClip = uniform.prevViewProj * vec4f(world, 1.0);
    r.prevDepth = -(uniform.prevView * vec4f(world, 1.0)).z;
    r.valid = prevClip.w > 0.0;
    let prevNdc = prevClip.xy / max(prevClip.w, 1e-9);
    r.uv = vec2f(prevNdc.x * 0.5 + 0.5, 0.5 - prevNdc.y * flip * 0.5);
    r.valid = r.valid && all(r.uv >= vec2f(0.0)) && all(r.uv <= vec2f(1.0));
    return r;
}

// the premultiplied sample at a texel: its colour where a fragment landed, nothing otherwise
fn sampleAt(pix: vec2i, dims: vec2i) -> vec4f {
    let p = clamp(pix, vec2i(0), dims - vec2i(1));
    let c = textureLoad(curColor, p, 0);
    let z = textureLoad(curDepth, p, 0);
    return select(vec4f(0.0), vec4f(c.rgb, 1.0), c.a > 0.0 && z < 1.0);
}

// The mean of the 2x2 quad's samples, bilinear between quad centres (the compose's resolve of
// the raster's quad-stratified thresholds): four samples a pixel, at a little sharpness, for
// the frames where the history is too short to carry the noise on its own
fn quadSample(pix: vec2i, dims: vec2i) -> vec4f {
    let size = vec2f(dims);
    let u = (vec2f(pix) - vec2f(0.5)) * 0.5;
    let q0 = floor(u);
    let f = u - q0;
    let uv = (q0 * 2.0 + vec2f(1.0)) / size;
    let step = vec2f(2.0) / size;
    let a = textureSampleLevel(curColor, curColorSampler, uv, 0.0);
    let b = textureSampleLevel(curColor, curColorSampler, uv + vec2f(step.x, 0.0), 0.0);
    let c = textureSampleLevel(curColor, curColorSampler, uv + vec2f(0.0, step.y), 0.0);
    let d = textureSampleLevel(curColor, curColorSampler, uv + step, 0.0);
    let m = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    // the raster leaves empty texels transparent black, so the mean is premultiplied coverage
    return vec4f(m.rgb, m.a);
}

fn historyTexel(p: vec2i, dims: vec2i) -> vec4f {
    return decodeColor(textureLoad(histColor, clamp(p, vec2i(0), dims - vec2i(1)), 0));
}

// Catmull-Rom fetch of the history: sharper than bilinear, whose blur compounds over the
// frames a moving history lives. Its lobes over- and undershoot; the encoding clamps both
fn historyCubicAt(uv: vec2f, dims: vec2i) -> vec4f {
    let p = uv * vec2f(dims) - vec2f(0.5);
    let i0 = vec2i(floor(p));
    let f = p - floor(p);
    let f2 = f * f;
    let f3 = f2 * f;
    // Catmull-Rom weights for taps at -1, 0, 1, 2
    let w0 = -0.5 * f3 + f2 - 0.5 * f;
    let w1 = 1.5 * f3 - 2.5 * f2 + vec2f(1.0);
    let w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
    let w3 = 0.5 * f3 - 0.5 * f2;
    let wx = array<f32, 4>(w0.x, w1.x, w2.x, w3.x);
    let wy = array<f32, 4>(w0.y, w1.y, w2.y, w3.y);
    var sum = vec4f(0.0);
    for (var y = 0; y < 4; y++) {
        for (var x = 0; x < 4; x++) {
            sum += historyTexel(i0 + vec2i(x - 1, y - 1), dims) * (wx[x] * wy[y]);
        }
    }
    return sum;
}

// bilinear fetch of the history
fn historyAt(uv: vec2f, dims: vec2i) -> vec4f {
    let p = uv * vec2f(dims) - vec2f(0.5);
    let i0 = vec2i(floor(p));
    let f = p - floor(p);
    let a = historyTexel(i0, dims);
    let b = historyTexel(i0 + vec2i(1, 0), dims);
    let c = historyTexel(i0 + vec2i(0, 1), dims);
    let d = historyTexel(i0 + vec2i(1, 1), dims);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let pix = vec2i(pcPosition.xy);
    let dims = vec2i(textureDimensions(curColor));
    let cur = textureLoad(curColor, pix, 0);
    let z = textureLoad(curDepth, pix, 0);
    let hit = cur.a > 0.0 && z < 1.0;
    let d = viewDepthOf(z);

    let own = decodeInfo(textureLoad(histInfo, pix, 0).x);
    let maxCount = uniform.taaParams.x;
    let historyValid = uniform.taaParams.y > 0.5;
    let moving = uniform.taaParams.z > 0.5;
    // still: this pixel's own sample, so the history converges to full resolution; moving:
    // the quad's four
    var sample = select(vec4f(0.0), vec4f(cur.rgb, 1.0), hit);
    if (moving && uniform.taaControl.z > 0.5) {
        sample = quadSample(pix, dims);
    }

    // Where to look in the history: through this frame's sample, or, with no sample, through
    // the depth this pixel's own history remembers, so an emptied pixel fades rather than
    // holding a stale colour
    var r: Reprojected;
    r.valid = false;
    var carryDepth = 0.0;
    if (!moving) {
        // a resting camera maps every pixel onto itself: the exact texel, not the round trip
        // through the matrices, whose rounding would blur the history a little every frame
        r.valid = true;
        r.uv = (vec2f(pix) + vec2f(0.5)) * uniform.taaViewport.zw;
        r.prevDepth = select(own.depth, d, hit);
        carryDepth = r.prevDepth;
    } else if (uniform.taaFilter.y > 0.5 && own.count > 0.5) {
        // through the depth the pixel's history has settled on: one stochastic sample's depth
        // is one layer of the mixture the history holds, and reprojecting the mixture through
        // a different layer every frame smears it by their parallax
        r = reproject(pix, own.depth);
        carryDepth = own.depth;
    } else if (hit) {
        r = reproject(pix, d);
        carryDepth = d;
    } else if (own.count > 0.5) {
        r = reproject(pix, own.depth);
        carryDepth = own.depth;
    }
    r.valid = r.valid && historyValid;

    var hist = vec4f(0.0);
    var histN = vec3f(0.0, 0.0, 1.0);
    // the sample's normal, where one landed
    let sampleN = octDecode(textureLoad(curNormal, pix, 0).xy);
    var info: HistoryInfo;
    var accepted = false;
    if (r.valid) {
        // at rest the exact texel; moving, a filtered fetch of the reprojected position
        if (!moving) {
            hist = decodeColor(textureLoad(histColor, pix, 0));
            info = own;
            histN = decodeNormal(textureLoad(histNormal, pix, 0));
        } else {
            if (uniform.taaFilter.x > 0.5) {
                hist = historyCubicAt(r.uv, dims);
            } else {
                hist = historyAt(r.uv, dims);
            }
            let texel = clamp(vec2i(r.uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
            info = decodeInfo(textureLoad(histInfo, texel, 0).x);
            histN = decodeNormal(textureLoad(histNormal, texel, 0));
        }
        // a resting camera cannot disocclude anything, so every sample is accepted and the
        // pixel converges; moving, the colour clamp below keeps a disoccluded history out
        accepted = info.count > 0.5;
    }

    var color: vec4f;
    var mean: f32;
    var count: f32;
    var normal = sampleN;
    if (!accepted) {
        color = sample;
        mean = d;
        count = select(0.0, 1.0, hit);
        // at rest a pixel with no hit yet has still been sampled on every rest frame, so its
        // first hit is one of that many samples: at full weight a rare hit would flash to full
        // coverage, and freeze there once the viewer stops rendering. Its depth is the hit's
        if (hit && !moving && historyValid) {
            count = clamp(uniform.taaParams.w, 1.0, maxCount);
            color = sample / count;
        }
    } else {
        // moving, the history is clamped to the colours this frame's neighbourhood holds, so a
        // stale colour cannot survive where nothing like it is drawn any more
        if (moving && uniform.taaControl.y > 0.0) {
            var m1 = vec4f(0.0);
            var m2 = vec4f(0.0);
            for (var dy = -1; dy <= 1; dy++) {
                for (var dx = -1; dx <= 1; dx++) {
                    let n = sampleAt(pix + vec2i(dx, dy), dims);
                    m1 += n;
                    m2 += n * n;
                }
            }
            let mu = m1 / 9.0;
            let sd = sqrt(max(m2 / 9.0 - mu * mu, vec4f(0.0)));
            let halfWidth = sd * uniform.taaControl.y;
            hist = clamp(hist, mu - halfWidth, mu + halfWidth);
        }
        // the faster the image moves, the shorter the history: a stochastic pixel's layers
        // reproject through one layer's depth, so their parallax smears the history by an
        // amount that grows with the motion, and a raw frame is the better estimate past it
        var cap = maxCount;
        if (moving && uniform.taaFilter.z > 0.0) {
            let speed = length(r.uv * vec2f(dims) - vec2f(pix) - vec2f(0.5));
            cap = max(2.0, maxCount / (1.0 + speed / uniform.taaFilter.z));
        }
        count = min(info.count + 1.0, cap);
        let w = 1.0 / count;
        color = mix(hist, sample, w);
        // an empty sample takes at least a step off the coverage: rounded to the nearest, a
        // decay of less than half a step holds (below cap / 2 steps, about 0.002 at the default
        // cap), so a faint pixel would keep its coverage, and the depth the compose writes for
        // it, forever. The colour follows, since the encoding keeps it within the coverage
        if (sample.a == 0.0) {
            color.a = min(color.a, max(hist.a - 1.0 / TAA_COLOR_SCALE, 0.0));
        }
        // carry the mean depth into this view: the point moved along the ray by the change in
        // its depth, then the sample joins it
        let shifted = info.depth + (carryDepth - r.prevDepth);
        mean = select(shifted, shifted + w * (d - shifted), hit);
        // the normals' running mean, renormalised; a miss keeps the history's
        let mixed = histN + w * (sampleN - histN);
        normal = select(histN, normalize(select(sampleN, mixed, dot(mixed, mixed) > 1e-8)), hit);
    }

    if (uniform.taaDebug > 1.5) {
        // the reprojection offset in pixels, 8 px full scale, centred on 0.5
        let mv = select(vec2f(0.0), r.uv * vec2f(dims) - vec2f(pix) - vec2f(0.5), r.valid);
        color = vec4f(mv / 16.0 + vec2f(0.5), select(0.0, 1.0, r.valid), 1.0);
    } else if (uniform.taaDebug > 0.5) {
        color = vec4f(count / maxCount, select(0.0, 1.0, accepted), select(0.0, 1.0, moving), 1.0);
    }
    output.color = encodeColor(color);
    output.color1 = encodeInfo(mean, count);
    output.color2 = encodeNormal(normal);
    return output;
}
`;

export { TAA_MAX_COUNT, taaFragmentWGSL, taaHistoryWGSL, taaVertexWGSL };
