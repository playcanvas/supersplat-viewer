// The direct source's layout for sog v2 files: a resident file's six RGBA8 textures repacked
// once into one RGBA32U texel of geometry per splat and one R32U texel of sh0 indices, so the
// projector reads one texel for every active splat and the second only for survivors.
// The payload is the file's own bytes, so the decode below is the engine's sog read code
// (shader-lib/wgsl/chunks/gsplat/vert/formats/sog.js) over different words.
//
// Geometry word layout: x = mean x | mean y << 16 (16-bit, as the file stores them);
// y = mean z | quaternion bytes x, y << 16; z = quaternion bytes z, w | scale indices x, y << 16;
// w = scale index z | opacity << 8 | sh palette label << 16.
const repackWGSL = /* wgsl */ `
@group(0) @binding(0) var means_l: texture_2d<f32>;
@group(0) @binding(1) var means_u: texture_2d<f32>;
@group(0) @binding(2) var quats: texture_2d<f32>;
@group(0) @binding(3) var scales: texture_2d<f32>;
@group(0) @binding(4) var sh0: texture_2d<f32>;
@group(0) @binding(5) var sh_labels: texture_2d<f32>;
@group(0) @binding(6) var outGeom: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(7) var outColor: texture_storage_2d<r32uint, write>;

fn bytesOf(v: vec4f) -> vec4u {
    return vec4u(v * 255.0 + 0.5);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let dims = textureDimensions(means_l);
    if (id.x >= dims.x || id.y >= dims.y) {
        return;
    }
    let p = vec2i(id.xy);
    let l = bytesOf(textureLoad(means_l, p, 0));
    let u = bytesOf(textureLoad(means_u, p, 0));
    let q = bytesOf(textureLoad(quats, p, 0));
    let s = bytesOf(textureLoad(scales, p, 0));
    let c = bytesOf(textureLoad(sh0, p, 0));
    let lab = bytesOf(textureLoad(sh_labels, p, 0));
    let geom = vec4u(
        (l.x | (u.x << 8u)) | ((l.y | (u.y << 8u)) << 16u),
        (l.z | (u.z << 8u)) | (q.x << 16u) | (q.y << 24u),
        q.z | (q.w << 8u) | (s.x << 16u) | (s.y << 24u),
        s.z | (c.w << 8u) | ((lab.x | (lab.y << 8u)) << 16u)
    );
    textureStore(outGeom, p, geom);
    textureStore(outColor, p, vec4u(c.x | (c.y << 8u) | (c.z << 16u), 0u, 0u, 0u));
}
`;

// The sh palette decoded once through the codebook, packed 11/11/10 bits a texel over the
// file's codebook range (the engine's own per-splat packing): the original palette's 4 bytes a
// texel, and a survivor's coefficient reads need no codebook lookups. The range is a uniform,
// so each file's decode needs its own compute.
const decodeSHWGSL = /* wgsl */ `
struct DecodeUniforms {
    shRange: vec4f
}
@group(0) @binding(0) var<uniform> uniforms: DecodeUniforms;
@group(0) @binding(1) var sh_centroids: texture_2d<f32>;
@group(0) @binding(2) var sogCodebook: texture_2d<f32>;
@group(0) @binding(3) var outSH: texture_storage_2d<r32uint, write>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let dims = textureDimensions(sh_centroids);
    if (id.x >= dims.x || id.y >= dims.y) {
        return;
    }
    let p = vec2i(id.xy);
    let idx = vec3i(textureLoad(sh_centroids, p, 0).xyz * 255.0 + 0.5);
    let value = vec3f(
        textureLoad(sogCodebook, vec2i(idx.x, 0), 0).b,
        textureLoad(sogCodebook, vec2i(idx.y, 0), 0).b,
        textureLoad(sogCodebook, vec2i(idx.z, 0), 0).b
    );
    // x and z take 11 bits, y 10, as the engine's own packing
    let n = clamp((value - uniforms.shRange.x) / uniforms.shRange.y, vec3f(0.0), vec3f(1.0));
    let q = vec3u(n * vec3f(2047.0, 1023.0, 2047.0) + 0.5);
    textureStore(outSH, p, vec4u((q.x << 21u) | (q.y << 11u) | q.z, 0u, 0u, 0u));
}
`;

// the projector's read chunk over the packed textures and the decoded palette; `bands` is the
// file's sh band count, the palette stride
const packedReadWGSL = (bindingBase: number, bands: number) => /* wgsl */ `
#include "halfTypesCS"
#include "gsplatEvalSHVS"
@group(0) @binding(${bindingBase}) var packedGeom: texture_2d<u32>;
@group(0) @binding(${bindingBase + 1}) var packedColor: texture_2d<u32>;
${bands > 0 ? `@group(0) @binding(${bindingBase + 2}) var sh_centroids: texture_2d<u32>;` : ''}
@group(0) @binding(${bindingBase + (bands > 0 ? 3 : 2)}) var sogCodebook: texture_2d<f32>;
uniform means_mins: vec3f;
uniform means_maxs: vec3f;
${bands > 0 ? 'uniform shRange: vec4f;' : ''}

const SH_C0: f32 = 0.28209479177387814;
const PACK_NORM: f32 = sqrt(2.0);
// the file's coefficients per palette entry: the stride of the centroid texture
const SH_STRIDE: i32 = ${[0, 3, 8, 15][bands]};

fn lutScales(b: i32) -> f32 { return textureLoad(sogCodebook, vec2i(b, 0), 0).r; }
fn lutSh0(b: i32) -> f32 { return textureLoad(sogCodebook, vec2i(b, 0), 0).g; }

var<private> packedG: vec4u;
var<private> srcWorldCenter: vec3f;

fn quatMulF(a: vec4f, b: vec4f) -> vec4f {
    return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

// v rotated by the inverse of q (x, y, z, w)
fn quatRotateInvF(q: vec4f, v: vec3f) -> vec3f {
    let u = -q.xyz;
    return v + 2.0 * cross(u, cross(u, v) + q.w * v);
}

// the one read every active splat makes
fn srcCenter() -> vec3f {
    packedG = textureLoad(packedGeom, splat.uv, 0);
    let n = vec3f(f32(packedG.x & 0xffffu), f32(packedG.x >> 16u), f32(packedG.y & 0xffffu)) / 65535.0;
    let v = mix(uniform.means_mins, uniform.means_maxs, n);
    srcWorldCenter = (uniforms.model * vec4f(sign(v) * (exp(abs(v)) - 1.0), 1.0)).xyz;
    return srcWorldCenter;
}

fn srcOpacity() -> f32 {
    return f32((packedG.w >> 8u) & 0xffu) / 255.0;
}

// the file stores three components and the omitted axis; the engine's getRotation
fn srcRotation() -> vec4f {
    let qb = vec4u((packedG.y >> 16u) & 0xffu, packedG.y >> 24u, packedG.z & 0xffu, (packedG.z >> 8u) & 0xffu);
    let abc = (vec3f(qb.xyz) / 255.0 - 0.5) * PACK_NORM;
    let d = sqrt(max(0.0, 1.0 - dot(abc, abc)));
    let qmode = qb.w - 252u;
    var quat: vec4f;
    if (qmode == 0u) {
        quat = vec4f(d, abc);
    } else if (qmode == 1u) {
        quat = vec4f(abc.x, d, abc.y, abc.z);
    } else if (qmode == 2u) {
        quat = vec4f(abc.x, abc.y, d, abc.z);
    } else {
        quat = vec4f(abc.x, abc.y, abc.z, d);
    }
    // the format's order is (w, x, y, z); world = model * source
    let q = quatMulF(uniforms.modelRotation, quat.yzwx);
    return q.wxyz;
}

fn srcScale() -> vec3f {
    let i = vec3i(i32((packedG.z >> 16u) & 0xffu), i32(packedG.z >> 24u), i32(packedG.w & 0xffu));
    return uniforms.modelScale.xyz * exp(vec3f(lutScales(i.x), lutScales(i.y), lutScales(i.z)));
}

#if SH_BANDS > 0
// a coefficient triple of the decoded palette: 11/11/10 bits over the file's codebook range
fn readSHTexel(u: i32, v: i32) -> half3 {
    let bits = textureLoad(sh_centroids, vec2i(u, v), 0).x;
    let q = vec3f(vec3u(bits >> 21u, (bits >> 11u) & 0x3ffu, bits & 0x7ffu)) / vec3f(2047.0, 1023.0, 2047.0);
    return half3(uniform.shRange.x + q * uniform.shRange.y);
}
#endif

// survivors only: the sh0 texel, and the sh evaluation for this camera
fn srcColor() -> vec3f {
    let c = textureLoad(packedColor, splat.uv, 0).x;
    let i = vec3i(i32(c & 0xffu), i32((c >> 8u) & 0xffu), i32((c >> 16u) & 0xffu));
    var color = vec3f(0.5) + vec3f(lutSh0(i.x), lutSh0(i.y), lutSh0(i.z)) * SH_C0;
    #if SH_BANDS > 0
        let view = uniforms.view;
        let orthoDir = vec3f(0.0, 0.0, -1.0) * mat3x3f(view[0].xyz, view[1].xyz, view[2].xyz);
        let viewDir = select(srcWorldCenter - uniforms.cameraPosition.xyz, orthoDir, uniforms.isOrtho != 0u);
        let dir = normalize(quatRotateInvF(uniforms.modelRotation, viewDir));
        let n = i32(packedG.w >> 16u);
        let u = (n % 64) * SH_STRIDE;
        let v = n / 64;
        var sh: array<half3, SH_COEFFS>;
        sh[0] = readSHTexel(u, v);
        sh[1] = readSHTexel(u + 1, v);
        sh[2] = readSHTexel(u + 2, v);
        #if SH_BANDS > 1
            sh[3] = readSHTexel(u + 3, v);
            sh[4] = readSHTexel(u + 4, v);
            sh[5] = readSHTexel(u + 5, v);
            sh[6] = readSHTexel(u + 6, v);
            sh[7] = readSHTexel(u + 7, v);
        #endif
        #if SH_BANDS > 2
            sh[8] = readSHTexel(u + 8, v);
            sh[9] = readSHTexel(u + 9, v);
            sh[10] = readSHTexel(u + 10, v);
            sh[11] = readSHTexel(u + 11, v);
            sh[12] = readSHTexel(u + 12, v);
            sh[13] = readSHTexel(u + 13, v);
            sh[14] = readSHTexel(u + 14, v);
        #endif
        color += vec3f(evalSH(&sh, dir));
    #endif
    return color;
}
`;

export { decodeSHWGSL, packedReadWGSL, repackWGSL };
