// The occluder grid (variant occluder:on): one depth-only quad per 8 px block of the previous
// frame, at the farthest depth that frame's nearest samples had in the block (the occlusion
// grid's level 1, see shaders/reduce.ts), reprojected into this frame's view. Drawn first in
// the raster pass, with no discard, so a gpu updates its depth early and can reject the
// splats' quads behind it before rasterising them finely, which it cannot do for depth the
// raster's discarding shader writes. Anything behind a block's farthest sample was invisible
// last frame, up to sampling: the same approximation the per-splat occlusion cull makes. A pixel
// whose sample the occluder rejected keeps the occluder's depth, and so feeds it into the next
// frame's grid: a block's depth then only moves away from the camera at rest, and reprojects
// with the geometry when it moves. Without that, such pixels would read as empty, the block as
// far, and every block would alternate between occluding and not.
import { FAR_CLIP_Z, QUADS_PER_INSTANCE } from './raster';

const occluderVertexWGSL = /* wgsl */ `
attribute vertex_position: vec3f;

// blocks x, y, block size in pixels
uniform occBlocks: vec4f;
// the previous frame: viewport (w, h) and the row order of its depth texture (-1 bottom-up)
uniform prevViewport: vec4f;
// the previous frame's projection scales (P00, P11)
uniform prevProjScale: vec4f;
// the previous frame's raster depth mapping: z = (a * viewDepth + b) / viewDepth
uniform prevClipZ: vec4f;
// the previous frame's camera transform (inverse view)
uniform prevInvView: mat4x4f;
// this frame's view-projection and raster depth mapping, as the raster uses them
uniform occViewProj: mat4x4f;
uniform clipZParams: vec4f;
// set by the engine's forward renderer for the target being rendered
uniform projectionFlipY: f32;

var<storage, read> occL1: array<u32>;

const discardPosition = vec4f(0.0, 0.0, 2.0, 1.0);

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let blocksX = u32(uniform.occBlocks.x);
    let index = pcInstanceIndex * ${QUADS_PER_INSTANCE}u + u32(vertex_position.z);
    if (index >= blocksX * u32(uniform.occBlocks.y)) {
        output.position = discardPosition;
        return output;
    }
    // a block with an empty pixel (or off the target) occludes nothing
    let z = bitcast<f32>(occL1[index]);
    if (z >= ${FAR_CLIP_Z}) {
        output.position = discardPosition;
        return output;
    }

    // the corner's pixel in the previous frame, and its view-space point at the block's depth
    let block = vec2f(f32(index % blocksX), f32(index / blocksX));
    let pixel = min((block + vertex_position.xy * 0.5 + 0.5) * uniform.occBlocks.z, uniform.prevViewport.xy);
    // the inverse of the projector's previous-pixel mapping
    let ndc = vec2f(pixel.x / uniform.prevViewport.x * 2.0 - 1.0, (1.0 - pixel.y / uniform.prevViewport.y * 2.0) * uniform.prevViewport.z);
    let depth = uniform.prevClipZ.y / (z - uniform.prevClipZ.x);
    let view = vec4f(ndc.x * depth / uniform.prevProjScale.x, ndc.y * depth / uniform.prevProjScale.y, -depth, 1.0);
    let world = uniform.prevInvView * view;

    // into this frame, with the raster's depth mapping
    let clip = uniform.occViewProj * world;
    let w = clip.w;
    if (w <= 0.0) {
        output.position = discardPosition;
        return output;
    }
    let clipZ = clamp(uniform.clipZParams.x * w + uniform.clipZParams.y, 0.0, w * ${FAR_CLIP_Z});
    output.position = vec4f(clip.x, clip.y * uniform.projectionFlipY, clipZ, w);
    return output;
}
`;

const occluderFragmentWGSL = /* wgsl */ `
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    output.color = vec4f(0.0);
    return output;
}
`;

export { occluderFragmentWGSL, occluderVertexWGSL };
