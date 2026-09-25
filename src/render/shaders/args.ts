// Single-thread pass turning the projector's survivor count into the indexed indirect draw
// arguments for the raster pass. Nothing comes back to the cpu, so a frame never stalls on the
// count. Entry layout matches the engine's indirect draw buffer (5 u32 per slot).
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
    quadsPerInstance: u32
}

@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read_write> indirectDrawArgs: array<DrawIndexedIndirectArgs>;
@group(0) @binding(2) var<uniform> uniforms: ArgsUniforms;

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
}
`;

export { argsWGSL };
