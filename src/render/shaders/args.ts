// Single-thread pass turning the projector's survivor count into the indexed indirect draw
// arguments for the raster pass and the indirect dispatch size of the order scatter. Nothing
// comes back to the cpu, so a frame never stalls on the count. Entry layouts match the engine's
// indirect draw buffer (5 u32 per slot) and indirect dispatch buffer (3 u32 per slot).
const argsWGSL = /* wgsl */ `
struct DrawIndexedIndirectArgs {
    indexCount: u32,
    instanceCount: u32,
    firstIndex: u32,
    baseVertex: i32,
    firstInstance: u32
}

struct ArgsUniforms {
    drawSlot: u32,
    indexCount: u32,
    quadsPerInstance: u32,
    dispatchSlot: u32,
    scatterWorkgroupSize: u32
}

@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read_write> indirectDrawArgs: array<DrawIndexedIndirectArgs>;
@group(0) @binding(2) var<storage, read_write> indirectDispatchArgs: array<u32>;
@group(0) @binding(3) var<uniform> uniforms: ArgsUniforms;

@compute @workgroup_size(1)
fn main() {
    let count = counter[0];
    indirectDrawArgs[uniforms.drawSlot] = DrawIndexedIndirectArgs(
        uniforms.indexCount,
        (count + uniforms.quadsPerInstance - 1u) / uniforms.quadsPerInstance,
        0u,
        0,
        0u
    );
    // the scatter: one workgroup per scatterWorkgroupSize survivors, 2D past the 65535 limit
    let groups = (count + uniforms.scatterWorkgroupSize - 1u) / uniforms.scatterWorkgroupSize;
    let x = max(min(groups, 65535u), 1u);
    let base = uniforms.dispatchSlot * 3u;
    indirectDispatchArgs[base] = x;
    indirectDispatchArgs[base + 1u] = (groups + x - 1u) / x;
    indirectDispatchArgs[base + 2u] = 1u;
}
`;

export { argsWGSL };
