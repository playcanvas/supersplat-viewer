// The rasterization rate map of each eye of a WebGPU XR session, which WebXR does not expose:
// visionOS renders an eye's logical viewport (4493 x 3604 on Apple Vision Pro) into a smaller
// texture (1856 x 1792 of 1888 x 1792) at a variable rate, fixed for the session and separable.
// One pass per eye draws a fullscreen triangle into the eye's sub-image with colour writes off, and
// the fragments on the texture's middle row and column store the logical ndc they were shaded at,
// which is the map along each axis. The foveated target takes its layout from it (shaders/warp.ts).
import type { WarpMap } from './shaders/warp';

// The WebGPU calls this makes, typed here: the project carries no WebGPU typings
type GpuBuffer = {
    destroy(): void;
    mapAsync(mode: number): Promise<void>;
    getMappedRange(): ArrayBuffer;
    unmap(): void;
};

type GpuPass = {
    setPipeline(pipeline: unknown): void;
    setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
    setBindGroup(index: number, group: unknown): void;
    draw(count: number): void;
    end(): void;
};

type GpuDevice = {
    createShaderModule(descriptor: { code: string }): unknown;
    createRenderPipeline(descriptor: object): { getBindGroupLayout(index: number): unknown };
    createBuffer(descriptor: { size: number; usage: number }): GpuBuffer;
    createBindGroup(descriptor: object): unknown;
    createCommandEncoder(): {
        beginRenderPass(descriptor: object): GpuPass;
        copyBufferToBuffer(src: GpuBuffer, srcOffset: number, dst: GpuBuffer, dstOffset: number, size: number): void;
        finish(): unknown;
    };
    queue: {
        writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBuffer): void;
        submit(buffers: unknown[]): void;
    };
};

/** One eye's sub-image, as the engine's WebGPU XR bridge records it each frame (device.xrSubImages). */
type XrSubImage = {
    colorTexture: { width: number; height: number; createView(descriptor?: object): unknown };
    viewDescriptor: object | null;
    viewport: { x: number; y: number; width: number; height: number };
    viewFormat: string;
};

// GPUBufferUsage and GPUMapMode
const MAP_READ = 0x0001;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const UNIFORM = 0x0040;
const STORAGE = 0x0080;

const rateMapWGSL = /* wgsl */ `
// the texture's size, and its middle column and row
struct Params { size: vec2u, mid: vec2u }
@group(0) @binding(0) var<uniform> params: Params;
// the logical ndc x of each column's centre along the middle row, then the ndc y of each row's
// centre along the middle column
@group(0) @binding(1) var<storage, read_write> map: array<f32>;
// the last column and row a fragment landed in
@group(0) @binding(2) var<storage, read_write> extent: array<atomic<u32>, 2>;

struct Varyings {
    @builtin(position) position: vec4f,
    @location(0) ndc: vec2f
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> Varyings {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var out: Varyings;
    out.position = vec4f(corners[index], 0.0, 1.0);
    out.ndc = corners[index];
    return out;
}

@fragment
fn fragmentMain(input: Varyings) -> @location(0) vec4f {
    let texel = vec2u(input.position.xy);
    if (texel.y == params.mid.y && texel.x < params.size.x) {
        map[texel.x] = input.ndc.x;
        atomicMax(&extent[0], texel.x);
    }
    if (texel.x == params.mid.x && texel.y < params.size.y) {
        map[params.size.x + texel.y] = input.ndc.y;
        atomicMax(&extent[1], texel.y);
    }
    return vec4f(0.0);
}
`;

/**
 * Whether an eye is rasterised at a variable rate: its logical viewport is larger than its texture.
 * Otherwise there is nothing to measure.
 */
const variableRate = (sub: XrSubImage) =>
    sub.viewport.width > sub.colorTexture.width || sub.viewport.height > sub.colorTexture.height;

/**
 * Measure every eye's rate map. Call it after the frame's own rendering has been submitted and
 * while the sub-images are still the frame's (the engine's frameend). Resolves with one map per
 * eye, or null for an eye whose map could not be read.
 */
const measureXrRateMaps = async (gpu: GpuDevice, subImages: XrSubImage[]): Promise<(WarpMap | null)[]> => {
    const module = gpu.createShaderModule({ code: rateMapWGSL });
    const encoder = gpu.createCommandEncoder();
    const eyes = subImages.map((sub) => {
        const { width, height } = sub.colorTexture;
        const pipeline = gpu.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: 'vertexMain' },
            fragment: { module, entryPoint: 'fragmentMain', targets: [{ format: sub.viewFormat, writeMask: 0 }] },
            primitive: { topology: 'triangle-list' }
        });
        const params = gpu.createBuffer({ size: 16, usage: UNIFORM | COPY_DST });
        gpu.queue.writeBuffer(params, 0, new Uint32Array([width, height, width >> 1, height >> 1]));
        const mapBytes = (width + height) * 4;
        const map = gpu.createBuffer({ size: mapBytes, usage: STORAGE | COPY_SRC });
        const extent = gpu.createBuffer({ size: 8, usage: STORAGE | COPY_SRC });
        const readMap = gpu.createBuffer({ size: mapBytes, usage: MAP_READ | COPY_DST });
        const readExtent = gpu.createBuffer({ size: 8, usage: MAP_READ | COPY_DST });
        const bindGroup = gpu.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: { buffer: map } },
                { binding: 2, resource: { buffer: extent } }
            ]
        });
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                { view: sub.colorTexture.createView(sub.viewDescriptor ?? undefined), loadOp: 'load', storeOp: 'store' }
            ]
        });
        const { viewport } = sub;
        pass.setPipeline(pipeline);
        pass.setViewport(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        encoder.copyBufferToBuffer(map, 0, readMap, 0, mapBytes);
        encoder.copyBufferToBuffer(extent, 0, readExtent, 0, 8);
        return { width, height, buffers: [params, map, extent, readMap, readExtent], readMap, readExtent };
    });
    gpu.queue.submit([encoder.finish()]);

    try {
        return await Promise.all(
            eyes.map(async ({ width, readMap, readExtent }) => {
                await Promise.all([readMap.mapAsync(MAP_READ), readExtent.mapAsync(MAP_READ)]);
                const values = new Float32Array(readMap.getMappedRange().slice(0));
                const [lastColumn, lastRow] = new Uint32Array(readExtent.getMappedRange().slice(0));
                readMap.unmap();
                readExtent.unmap();
                const map: WarpMap = {
                    width: lastColumn + 1,
                    height: lastRow + 1,
                    columns: values.slice(0, lastColumn + 1),
                    rows: values.slice(width, width + lastRow + 1)
                };
                // a map has to be strictly monotonic: columns rise to the right, rows fall downward
                for (let i = 1; i < map.width; i++) if (!(map.columns[i] > map.columns[i - 1])) return null;
                for (let j = 1; j < map.height; j++) if (!(map.rows[j] < map.rows[j - 1])) return null;
                return map.width > 1 && map.height > 1 ? map : null;
            })
        );
    } finally {
        for (const eye of eyes) for (const buffer of eye.buffers) buffer.destroy();
    }
};

export { measureXrRateMaps, variableRate };
export type { GpuDevice, XrSubImage };
