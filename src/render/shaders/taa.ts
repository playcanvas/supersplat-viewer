// Temporal accumulation for the stochastic frame. Each frame the raster leaves one sample per
// pixel (a colour where a splat's fragment survived its coverage test, nothing otherwise) and
// the nearest surviving depth; this pass folds it into a per-pixel history of premultiplied
// colour and coverage, so a still camera converges to the expected image over a few dozen
// frames and a moving one keeps most of that history by reprojecting it.
//
// Reprojection uses the sample's own depth: the pixel's world point is carried into the
// previous view and the history is fetched there. Whether that history is trustworthy is
// decided against a running depth distribution kept alongside it (mean and variance of the
// accepted samples' depths, in view units): a stochastic pixel under a semi-transparent splat
// sees two or more layers and its variance grows to span them, so both layers keep accepting,
// while a true disocclusion (the reprojected point lies far from anything the history saw)
// resets the pixel. A pixel with no sample this frame reprojects through the depth its own
// history remembers, so coverage fades out where a surface has moved away rather than
// smearing into the background.
const taaVertexWGSL = /* wgsl */ `
attribute vertex_position: vec2f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4f(vertex_position, 0.0, 1.0);
    return output;
}
`;

const taaFragmentWGSL = /* wgsl */ `
var curColor: texture_2d<f32>;
var curColorSampler: sampler;
var curDepth: texture_depth_2d;
// premultiplied colour and coverage; 32-bit, since a 1 / 256 step of a half-float mean rounds away
var histColor: texture_2d<uff>;
// mean depth, depth variance, sample count, run of out-of-distribution samples (signed by
// side) of the previous frame, in its view depths
var histInfo: texture_2d<uff>;

uniform invViewProj: mat4x4f;
uniform prevViewProj: mat4x4f;
uniform prevView: mat4x4f;
// clip z = a * viewDepth + b over w = viewDepth (x, y); z: 1 for an orthographic camera
uniform clipZParams: vec4f;
// x: sample cap, y: relative depth tolerance, z: 1 when the history holds the previous frame,
// w: 1 when the camera moved since that frame
uniform taaParams: vec4f;
// width, height, 1 / width, 1 / height
uniform taaViewport: vec4f;
// x: -1 when the target's rows run bottom-up (an offscreen target), else 1; y: the colour
// clamp width in neighbourhood standard deviations (0: no clamp); z: out-of-distribution run
// that resets a pixel while moving (0: no depth test); w: 1 when the raster's thresholds are
// quad-stratified
uniform taaControl: vec4f;
// x: 1 for a Catmull-Rom history fetch while moving (0: bilinear); y: 1 to reproject through
// the pixel's accumulated mean depth rather than this frame's sample depth; z: image motion in
// pixels a frame that halves the moving sample cap (0: fixed cap)
uniform taaFilter: vec4f;
// 1: write the accumulation state instead of colour (r: count / cap, g: history accepted,
// b: the camera moved since the previous frame)
uniform taaDebug: f32;

const ABS_TOL = 1e-3;

fn viewDepthOf(z: f32) -> f32 {
    let p = uniform.clipZParams;
    let dz = z - p.x;
    let safeDz = select(dz, sign(dz) * 1e-9 + 1e-12, abs(dz) < 1e-9);
    return select(p.y / safeDz, (z - p.y) / p.x, p.z != 0.0);
}

fn clipZOf(viewDepth: f32) -> f32 {
    let p = uniform.clipZParams;
    let w = select(viewDepth, 1.0, p.z != 0.0);
    return clamp(p.x * viewDepth + p.y, 0.0, w) / w;
}

struct Reprojected {
    valid: bool,
    uv: vec2f,
    prevDepth: f32
}

// the previous frame's view depth and texture coordinate of this pixel's point at clip depth z
fn reproject(pix: vec2i, z: f32) -> Reprojected {
    var r: Reprojected;
    let flip = uniform.taaControl.x;
    let uv = (vec2f(pix) + vec2f(0.5)) * uniform.taaViewport.zw;
    let ndc = vec2f(uv.x * 2.0 - 1.0, flip * (1.0 - 2.0 * uv.y));
    let worldH = uniform.invViewProj * vec4f(ndc, z, 1.0);
    let world = worldH.xyz / worldH.w;
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

// Catmull-Rom fetch of the 32-bit history: sharper than bilinear, whose blur compounds over
// the frames a moving history lives
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
    let lo = vec2i(0);
    let hi = dims - vec2i(1);
    var sum = vec4f(0.0);
    for (var y = 0; y < 4; y++) {
        for (var x = 0; x < 4; x++) {
            let t = clamp(i0 + vec2i(x - 1, y - 1), lo, hi);
            sum += textureLoad(histColor, t, 0) * (wx[x] * wy[y]);
        }
    }
    // the negative lobes can push coverage or colour below zero
    return max(sum, vec4f(0.0));
}

// bilinear fetch of the 32-bit history
fn historyAt(uv: vec2f, dims: vec2i) -> vec4f {
    let p = uv * vec2f(dims) - vec2f(0.5);
    let i0 = vec2i(floor(p));
    let f = p - floor(p);
    let lo = vec2i(0);
    let hi = dims - vec2i(1);
    let a = textureLoad(histColor, clamp(i0, lo, hi), 0);
    let b = textureLoad(histColor, clamp(i0 + vec2i(1, 0), lo, hi), 0);
    let c = textureLoad(histColor, clamp(i0 + vec2i(0, 1), lo, hi), 0);
    let d = textureLoad(histColor, clamp(i0 + vec2i(1, 1), lo, hi), 0);
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

    let own = textureLoad(histInfo, pix, 0);
    let maxCount = uniform.taaParams.x;
    let historyValid = uniform.taaParams.z > 0.5;
    let moving = uniform.taaParams.w > 0.5;
    // still: this pixel's own sample, so the history converges to full resolution; moving:
    // the quad's four
    let sample = select(select(vec4f(0.0), vec4f(cur.rgb, 1.0), hit), quadSample(pix, dims), moving && uniform.taaControl.w > 0.5);

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
        r.prevDepth = select(own.x, d, hit);
        carryDepth = r.prevDepth;
    } else if (uniform.taaFilter.y > 0.5 && own.z > 0.5) {
        // through the depth the pixel's history has settled on: one stochastic sample's depth
        // is one layer of the mixture the history holds, and reprojecting the mixture through
        // a different layer every frame smears it by their parallax
        r = reproject(pix, clipZOf(own.x));
        carryDepth = own.x;
    } else if (hit) {
        r = reproject(pix, z);
        carryDepth = d;
    } else if (own.z > 0.5) {
        r = reproject(pix, clipZOf(own.x));
        carryDepth = own.x;
    }
    r.valid = r.valid && historyValid;

    var hist = vec4f(0.0);
    var info = vec4f(0.0);
    var accepted = false;
    var run = 0.0;
    var inflate = 0.0;
    if (r.valid) {
        // at rest the exact texel; moving, a filtered fetch of the reprojected position
        if (!moving) {
            hist = textureLoad(histColor, pix, 0);
        } else if (uniform.taaFilter.x > 0.5) {
            hist = historyCubicAt(r.uv, dims);
        } else {
            hist = historyAt(r.uv, dims);
        }
        info = textureLoad(histInfo, clamp(vec2i(r.uv * vec2f(dims)), vec2i(0), dims - vec2i(1)), 0);
        accepted = info.z > 0.5;
        run = info.w;
        if (accepted && hit && moving && uniform.taaControl.z > 0.5) {
            // A resting camera cannot disocclude anything, so every sample is accepted and the
            // pixel converges. Moving, a single sample outside the pixel's depth distribution
            // is what a semi-transparent splat produces every other frame (the nearest sample
            // alternates between its layers), so it widens the distribution; a run of them on
            // the same side is a disocclusion and resets the pixel
            let tol = max(uniform.taaParams.y * r.prevDepth, ABS_TOL);
            let sigma = sqrt(max(info.y, 0.0));
            let dev = r.prevDepth - info.x;
            if (abs(dev) > 2.0 * sigma + tol) {
                let side = sign(dev);
                run = select(side, run + side, sign(run) == side);
                if (abs(run) >= uniform.taaControl.z) {
                    accepted = false;
                } else {
                    inflate = dev * dev * 0.25;
                }
            } else {
                run = 0.0;
            }
        } else {
            run = 0.0;
        }
    }

    var color: vec4f;
    var mean: f32;
    var variance: f32;
    var count: f32;
    if (!accepted) {
        color = sample;
        mean = d;
        variance = 0.0;
        count = select(0.0, 1.0, hit);
        run = 0.0;
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
        count = min(info.z + 1.0, cap);
        let w = 1.0 / count;
        color = mix(hist, sample, w);
        // carry the distribution into this view: the point moved along the ray by the change
        // in its depth
        let shifted = info.x + (carryDepth - r.prevDepth);
        if (hit) {
            let delta = d - shifted;
            mean = shifted + w * delta;
            variance = max((1.0 - w) * (info.y + w * delta * delta), inflate);
        } else {
            mean = shifted;
            variance = info.y;
        }
    }

    if (uniform.taaDebug > 1.5) {
        // the reprojection offset in pixels, 8 px full scale, centred on 0.5
        let mv = select(vec2f(0.0), r.uv * vec2f(dims) - vec2f(pix) - vec2f(0.5), r.valid);
        color = vec4f(mv / 16.0 + vec2f(0.5), select(0.0, 1.0, r.valid), 1.0);
    } else if (uniform.taaDebug > 0.5) {
        color = vec4f(count / maxCount, select(0.0, 1.0, accepted), select(0.0, 1.0, moving), 1.0);
    }
    output.color = color;
    output.color1 = vec4f(mean, variance, count, run);
    return output;
}
`;

export { taaFragmentWGSL, taaVertexWGSL };
