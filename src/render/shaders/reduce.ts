// The occlusion grid: the previous frame's depth texture reduced to the farthest depth per 8x8
// pixel block (level 1), and the farthest of each 4x4 group of those (level 2, 32 px). Each
// pixel's depth is the nearest surviving sample there, so a block's maximum bounds what could
// still have shown behind it; a splat whose front lies beyond that bound over every block it
// covers was invisible last frame. Depths are hardware z in [0, 1], stored as their f32 bits
// (non-negative floats order the same as their bits, so atomicMax works on them).
const reduceL1WGSL = /* wgsl */ `
struct ReduceUniforms {
    width: u32,
    height: u32,
    blocksX: u32,
    blocksY: u32
}

@group(0) @binding(0) var prevDepth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> blockMax: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: ReduceUniforms;

var<workgroup> wgMax: atomic<u32>;

@compute @workgroup_size(8, 8)
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(local_invocation_id) lid: vec3u,
    @builtin(local_invocation_index) li: u32
) {
    let pixel = wg.xy * 8u + lid.xy;
    // pixels off the texture count as far, so an edge block never culls
    var depth = 1.0;
    if (pixel.x < uniforms.width && pixel.y < uniforms.height) {
        depth = textureLoad(prevDepth, vec2i(pixel), 0);
    }
    atomicMax(&wgMax, bitcast<u32>(depth));
    workgroupBarrier();
    if (li == 0u) {
        blockMax[wg.y * uniforms.blocksX + wg.x] = atomicLoad(&wgMax);
    }
}
`;

const reduceL2WGSL = /* wgsl */ `
struct ReduceUniforms {
    blocksX1: u32,
    blocksY1: u32,
    blocksX2: u32,
    blocksY2: u32
}

@group(0) @binding(0) var<storage, read> level1: array<u32>;
@group(0) @binding(1) var<storage, read_write> level2: array<u32>;
@group(0) @binding(2) var<uniform> uniforms: ReduceUniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let index = gid.x;
    if (index >= uniforms.blocksX2 * uniforms.blocksY2) {
        return;
    }
    let bx = index % uniforms.blocksX2;
    let by = index / uniforms.blocksX2;
    var farthest = 0u;
    for (var dy = 0u; dy < 4u; dy++) {
        for (var dx = 0u; dx < 4u; dx++) {
            let x = bx * 4u + dx;
            let y = by * 4u + dy;
            if (x < uniforms.blocksX1 && y < uniforms.blocksY1) {
                farthest = max(farthest, level1[y * uniforms.blocksX1 + x]);
            } else {
                farthest = max(farthest, bitcast<u32>(1.0));
            }
        }
    }
    level2[index] = farthest;
}
`;

export { reduceL1WGSL, reduceL2WGSL };
