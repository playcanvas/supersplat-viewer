// The projector: one 256-thread workgroup per chunk of the resident set. Each thread reads one
// splat through the source's read code, projects it, applies the culls, and survivors append
// themselves to a dense cache with one global atomic per workgroup. The chunk table and node
// visibility come from the cpu (resident-set rebuild on version change, frustum cull per frame).

/** Words per cache entry. See the layout in the plan: ndc, depth, axis1, len2|alpha|flags, rgb, popless, id. */
const CACHE_WORDS = 7;

const PROJECTOR_WORKGROUP_SIZE = 256;

/** Splats per chunk-table entry; a chunk is one workgroup. */
const CHUNK_SIZE = PROJECTOR_WORKGROUP_SIZE;

const projectorWGSL = (readChunk: string) => /* wgsl */ `
struct ProjectorUniforms {
    view: mat4x4f,
    viewProj: mat4x4f,
    viewport: vec2f,
    focal: vec2f,
    numChunks: u32,
    splatTextureSize: u32,
    isOrtho: u32,
    minPixelSize: f32,
    alphaClip: f32,
    minContribution: f32
}

// chunk table entry: slotBase, count, node, lod | file << 16
@group(0) @binding(0) var<storage, read> chunks: array<vec4u>;
// one bit per node: 1 = inside the frustum this frame
@group(0) @binding(1) var<storage, read> nodeVisible: array<u32>;
@group(0) @binding(2) var<storage, read_write> cache: array<u32>;
// [0] survivors this frame
@group(0) @binding(3) var<storage, read_write> counter: array<atomic<u32>>;
@group(0) @binding(4) var<uniform> uniforms: ProjectorUniforms;

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
    words: array<u32, ${CACHE_WORDS}>
}

fn project(slot: u32) -> Projected {
    var result: Projected;
    result.valid = false;

    setSplat(slot);
    let center = getCenter();
    let opacity = getOpacity();
    if (opacity < uniforms.alphaClip) {
        return result;
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
    let rot = getRotation();
    let scale = getScale();
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

    // the low-pass dilation every splat renderer applies
    cov00 += 0.3;
    cov11 += 0.3;
    let determinant = cov00 * cov11 - cov01 * cov01;
    if (determinant <= 0.0) {
        return result;
    }

    let mid = 0.5 * (cov00 + cov11);
    let radius = length(vec2f(0.5 * (cov00 - cov11), cov01));
    let lambda1 = mid + radius;
    let lambda2 = max(mid - radius, 0.1);

    // size cull: the quad's longest extent in pixels
    if (2.0 * sqrt(2.0 * lambda1) < uniforms.minPixelSize) {
        return result;
    }

    // contribution cull: the splat's alpha mass in pixels (the engine's minContribution rule)
    if (opacity * 6.283185 * sqrt(determinant) < uniforms.minContribution) {
        return result;
    }

    // principal axis; a circular footprint has no defined eigenvector, any axis is right
    let eigenVec = vec2f(cov01, lambda1 - cov00);
    let eigenLen = length(eigenVec);
    let direction = select(vec2f(1.0, 0.0), eigenVec / eigenLen, eigenLen > 1e-9);
    let maxRadius = min(1024.0, min(viewport.x, viewport.y));
    let len1 = 2.0 * sqrt(2.0 * lambda1);
    let radiusScale = min(1.0, maxRadius / len1);
    let axis1 = len1 * radiusScale * direction;
    let len2 = 2.0 * sqrt(2.0 * lambda2) * radiusScale;
    let axis2 = len2 * vec2f(direction.y, -direction.x);

    let ndc = clip.xy / clip.w;
    let extent = abs(axis1) + abs(axis2);
    let centerPixels = (ndc * 0.5 + 0.5) * viewport;
    if (centerPixels.x + extent.x < 0.0 || centerPixels.x - extent.x > viewport.x
        || centerPixels.y + extent.y < 0.0 || centerPixels.y - extent.y > viewport.y) {
        return result;
    }

    let color = max(getColor(), vec3f(0.0));

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
    result.words[2] = pack2x16float(axis1);
    result.words[3] = pack2x16float(vec2f(len2, 0.0)) | (u32(clamp(opacity, 0.0, 1.0) * 255.0 + 0.5) << 16u);
    result.words[4] = rgb.r | (rgb.g << 10u) | (rgb.b << 20u) | (exponent << 30u);
    // popless depth gradient (plan M5); flat until then
    result.words[5] = 0u;
    // the stable id: the work-buffer slot, which the coverage hash seeds from
    result.words[6] = slot;
    return result;
}

var<workgroup> wgCount: atomic<u32>;
var<workgroup> wgBase: u32;

@compute @workgroup_size(${PROJECTOR_WORKGROUP_SIZE})
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    // no early returns: the barriers below need every thread of the workgroup
    let chunkIndex = wg.x + wg.y * numWorkgroups.x;
    var projected: Projected;
    projected.valid = false;
    if (chunkIndex < uniforms.numChunks) {
        let chunk = chunks[chunkIndex];
        let visible = (nodeVisible[chunk.z >> 5u] >> (chunk.z & 31u)) & 1u;
        if (visible != 0u && local < chunk.y) {
            projected = project(chunk.x + local);
        }
    }

    // survivors claim consecutive slots: one workgroup-local count, one global atomic
    var localSlot = 0u;
    if (projected.valid) {
        localSlot = atomicAdd(&wgCount, 1u);
    }
    workgroupBarrier();
    if (local == 0u) {
        let n = atomicLoad(&wgCount);
        wgBase = select(0u, atomicAdd(&counter[0], n), n > 0u);
    }
    workgroupBarrier();
    if (projected.valid) {
        let base = (wgBase + localSlot) * ${CACHE_WORDS}u;
        for (var i = 0u; i < ${CACHE_WORDS}u; i++) {
            cache[base + i] = projected.words[i];
        }
    }
}
`;

export { CACHE_WORDS, CHUNK_SIZE, PROJECTOR_WORKGROUP_SIZE, projectorWGSL };
