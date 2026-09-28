// Point lights for the stochastic frame (proof of concept). Lighting runs in the compose, after
// the accumulation, on what the history has converged to: the splats' colour as albedo, their
// mean depth for the surface position, and the mean of their normals. Lighting after rather than
// before the accumulation means a light can move while the camera rests without its old
// positions lingering in the history, and it is lit once per pixel, not once per sample. With
// the accumulation off the raw frame is lit the same way, noise and all.
//
// Normals, by `lightNormals`: `splat`, each splat's shortest axis (projector word 7), averaged
// over the pixel's samples; `depth`, from the neighbouring pixels' surface positions; `none`,
// no angle term, only the distance falloff. Shadows are screen space: the segment from the
// surface to the light is marched through the depth the frame holds, so only occluders on
// screen cast them.
//
// Included in the compose under SSE_LIGHTING, after its depth helpers.

/** Point lights the compose takes at most. */
const MAX_LIGHTS = 4;

const lightingWGSL = /* wgsl */ `
// this frame's normals (octahedral, world space) and the accumulated ones
var splatNormal: texture_2d<f32>;
var taaNormal: texture_2d<u32>;

// x: ambient (the splats' own colour is lit by ambient 1), y: light count, z: normal source
// (0 none, 1 splat, 2 depth), w: 1 for shadows
uniform lightParams: vec4f;
// 1: show the normals, 2: show the lighting on a white albedo
uniform lightDebug: f32;
// x: the depth normals' baseline in pixels, y: how much the angle term counts (0 none, 1 all)
uniform normalParams: vec4f;
// x: steps along the segment to a light, y: occluder thickness and z: self-shadow margin, both
// as fractions of the view depth, w: the segment's first fraction left out
uniform shadowParams: vec4f;
// world position and range (w) of each light, and its colour times intensity (rgb) with the
// radius of its marker in pixels (w)
uniform lightPos0: vec4f;
uniform lightPos1: vec4f;
uniform lightPos2: vec4f;
uniform lightPos3: vec4f;
uniform lightColor0: vec4f;
uniform lightColor1: vec4f;
uniform lightColor2: vec4f;
uniform lightColor3: vec4f;
// the camera's world transform and projection x/y terms (as the accumulation's reprojection),
// its view-projection, and the splat target's row order (-1 bottom-up, else 1)
uniform cameraWorld: mat4x4f;
uniform unproject: vec4f;
uniform viewProj: mat4x4f;
uniform lightFlip: f32;

fn lightPos(i: i32) -> vec4f {
    switch i {
        case 0: { return uniform.lightPos0; }
        case 1: { return uniform.lightPos1; }
        case 2: { return uniform.lightPos2; }
        default: { return uniform.lightPos3; }
    }
}

fn lightColor(i: i32) -> vec4f {
    switch i {
        case 0: { return uniform.lightColor0; }
        case 1: { return uniform.lightColor1; }
        case 2: { return uniform.lightColor2; }
        default: { return uniform.lightColor3; }
    }
}

fn usingHistory() -> bool {
    return uniform.composeParams.z > 0.5;
}

// the surface's view depth at a splat target texel, 0 where nothing is there: the accumulated
// mean when the history is in use, else the frame's nearest sample
fn surfaceDepthAt(p: vec2i) -> f32 {
    if (usingHistory()) {
        let info = decodeInfo(textureLoad(taaInfo, p, 0).x);
        return select(0.0, info.depth, info.count > 0.5);
    }
    let z = textureLoad(splatDepth, p, 0);
    return select(0.0, viewDepthOf(z), z < 1.0);
}

// the world point at a splat target texel and view depth
fn worldAt(p: vec2i, viewDepth: f32, dims: vec2i) -> vec3f {
    let uv = (vec2f(p) + vec2f(0.5)) / vec2f(dims);
    let ndc = vec2f(uv.x * 2.0 - 1.0, uniform.lightFlip * (1.0 - 2.0 * uv.y));
    let u = uniform.unproject;
    let viewXY = select((ndc + u.zw) * viewDepth, ndc - u.zw, uniform.composeParams.y > 0.5) / u.xy;
    return (uniform.cameraWorld * vec4f(viewXY, -viewDepth, 1.0)).xyz;
}

fn cameraPosition() -> vec3f {
    return uniform.cameraWorld[3].xyz;
}

fn viewDepthOfPoint(p: vec3f) -> f32 {
    return dot(p - cameraPosition(), -uniform.cameraWorld[2].xyz);
}

// the splat target pixel a world point lands on, and whether it is in front of the camera
fn pixelOf(p: vec3f, dims: vec2i) -> vec3f {
    let clip = uniform.viewProj * vec4f(p, 1.0);
    let ndc = clip.xy / max(abs(clip.w), 1e-9);
    let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * uniform.lightFlip * 0.5);
    return vec3f(uv * vec2f(dims), select(0.0, 1.0, clip.w > 0.0));
}

// the surface normal from the neighbouring texels' positions, the flatter side on each axis
fn depthNormal(p: vec2i, center: vec3f, dims: vec2i) -> vec3f {
    let hi = dims - vec2i(1);
    var tangents: array<vec3f, 2>;
    for (var axis = 0; axis < 2; axis++) {
        let step = select(vec2i(0, 1), vec2i(1, 0), axis == 0) * i32(uniform.normalParams.x);
        let a = clamp(p + step, vec2i(0), hi);
        let b = clamp(p - step, vec2i(0), hi);
        let da = surfaceDepthAt(a);
        let db = surfaceDepthAt(b);
        let pa = worldAt(a, da, dims) - center;
        let pb = center - worldAt(b, db, dims);
        let useA = da > 0.0 && (db <= 0.0 || dot(pa, pa) < dot(pb, pb));
        tangents[axis] = select(pb, pa, useA);
    }
    let n = cross(tangents[0], tangents[1]);
    let len = length(n);
    let toCamera = normalize(cameraPosition() - center);
    let unit = select(toCamera, n / max(len, 1e-12), len > 1e-12);
    return select(-unit, unit, dot(unit, toCamera) >= 0.0);
}

fn surfaceNormal(p: vec2i, center: vec3f, dims: vec2i) -> vec3f {
    let source = uniform.lightParams.z;
    if (source > 1.5) {
        return depthNormal(p, center, dims);
    }
    if (usingHistory()) {
        return decodeNormal(textureLoad(taaNormal, p, 0));
    }
    return octDecode(textureLoad(splatNormal, p, 0).xy);
}

// 1 where the segment from the surface to the light is clear of what the frame shows, 0 where
// a surface on screen sits in front of it, thicker than nothing and no thicker than the limit
fn shadowTo(p: vec2i, surface: vec3f, light: vec3f, dims: vec2i) -> f32 {
    let steps = i32(uniform.shadowParams.x);
    // a fixed per-pixel offset turns the steps' banding into a fine dither that holds still
    let jitter = fract(52.9829189 * fract(dot(vec2f(p), vec2f(0.06711056, 0.00583715))));
    let start = uniform.shadowParams.w;
    for (var i = 0; i < steps; i++) {
        let t = start + (1.0 - start) * (f32(i) + jitter) / f32(steps);
        let s = mix(surface, light, t);
        let at = pixelOf(s, dims);
        if (at.z < 0.5 || any(at.xy < vec2f(0.0)) || any(at.xy >= vec2f(dims))) {
            break;
        }
        let depth = viewDepthOfPoint(s);
        let occluder = surfaceDepthAt(vec2i(at.xy));
        if (occluder > 0.0 && occluder < depth * (1.0 - uniform.shadowParams.z)
            && depth - occluder < depth * uniform.shadowParams.y) {
            return 0.0;
        }
    }
    return 1.0;
}

// the lit colour of a surface texel, gamma in and out; the lighting itself is linear
fn lightSurface(p: vec2i, viewDepth: f32, albedoGamma: vec3f, dims: vec2i) -> vec3f {
    let surface = worldAt(p, viewDepth, dims);
    let useNormal = uniform.lightParams.z > 0.5;
    let normal = select(vec3f(0.0), surfaceNormal(p, surface, dims), useNormal);
    if (uniform.lightDebug > 0.5 && uniform.lightDebug < 1.5) {
        return normal * 0.5 + vec3f(0.5);
    }
    var light = vec3f(uniform.lightParams.x);
    let count = i32(uniform.lightParams.y);
    for (var i = 0; i < count; i++) {
        let pos = lightPos(i);
        let toLight = pos.xyz - surface;
        let dist = length(toLight);
        let falloff = pow(clamp(1.0 - dist / pos.w, 0.0, 1.0), 2.0);
        if (falloff <= 0.0) {
            continue;
        }
        let lambert = max(dot(normal, toLight / max(dist, 1e-9)), 0.0);
        let facing = select(1.0, mix(1.0, lambert, uniform.normalParams.y), useNormal);
        if (facing <= 0.0) {
            continue;
        }
        var shade = 1.0;
        if (uniform.lightParams.w > 0.5) {
            shade = shadowTo(p, surface, pos.xyz, dims);
        }
        light += lightColor(i).rgb * (falloff * facing * shade);
    }
    let albedo = select(pow(albedoGamma, vec3f(2.2)), vec3f(1.0), uniform.lightDebug > 1.5);
    return pow(albedo * light, vec3f(1.0 / 2.2));
}

// A light's marker: a small disc at its position, in front of the splats there. The colour, and
// the view depth for the compose's depth write, or a negative depth where no marker covers p
fn lightMarker(p: vec2i, dims: vec2i) -> vec4f {
    let count = i32(uniform.lightParams.y);
    let here = surfaceDepthAt(p);
    for (var i = 0; i < count; i++) {
        let pos = lightPos(i);
        let color = lightColor(i);
        let at = pixelOf(pos.xyz, dims);
        let depth = viewDepthOfPoint(pos.xyz);
        if (at.z > 0.5 && distance(at.xy, vec2f(p) + vec2f(0.5)) < color.w && (here <= 0.0 || depth < here)) {
            return vec4f(color.rgb / max(max(color.r, max(color.g, color.b)), 1e-6), depth);
        }
    }
    return vec4f(0.0, 0.0, 0.0, -1.0);
}
`;

export { MAX_LIGHTS, lightingWGSL };
