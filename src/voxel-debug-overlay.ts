import {
    type AppBase,
    type Entity,
    BindGroupFormat,
    BindStorageBufferFormat,
    BindStorageTextureFormat,
    BindUniformBufferFormat,
    BLEND_PREMULTIPLIED,
    BUFFERUSAGE_COPY_DST,
    Compute,
    CULLFACE_NONE,
    Mat4,
    PIXELFORMAT_RGBA8,
    SEMANTIC_POSITION,
    Shader,
    SHADERLANGUAGE_WGSL,
    SHADERSTAGE_COMPUTE,
    ShaderMaterial,
    StorageBuffer,
    TEXTUREDIMENSION_2D,
    Texture,
    UniformBufferFormat,
    UniformFormat,
    UNIFORMTYPE_FLOAT,
    UNIFORMTYPE_MAT4,
    UNIFORMTYPE_UINT
} from 'playcanvas';

import type { VoxelCollider } from './voxel-collider';

// ---------------------------------------------------------------------------
// WGSL compute shader: ray-march through the sparse voxel octree per pixel
// ---------------------------------------------------------------------------

const voxelOverlayWGSL = /* wgsl */ `

// Solid leaf sentinel: childMask=0xFF, baseOffset=0
const SOLID_LEAF_MARKER: u32 = 0xFF000000u;

// Maximum DDA steps to prevent infinite loops
const MAX_STEPS: u32 = 512u;

// Target wireframe edge width in pixels
const EDGE_PIXELS: f32 = 1.5;

// Wireframe edge alpha
const EDGE_ALPHA: f32 = 0.85;

// Interior fill alpha (subtle orientation tint)
const FILL_ALPHA: f32 = 0.12;

struct Uniforms {
    invVP: mat4x4<f32>,
    screenWidth: u32,
    screenHeight: u32,
    gridMinX: f32,
    gridMinY: f32,
    gridMinZ: f32,
    voxelRes: f32,
    numVoxelsX: u32,
    numVoxelsY: u32,
    numVoxelsZ: u32,
    leafSize: u32,
    treeDepth: u32,
    projScaleY: f32,
    pad1: u32,
    pad2: u32
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> nodes: array<u32>;
@group(0) @binding(2) var<storage, read> leafData: array<u32>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<rgba8unorm, write>;

// ---- helpers ----

// Traverse the octree for block (bx, by, bz). Returns:
//   0 = empty subtree (no voxels)
//   1 = solid leaf (entire 4x4x4 block is solid)
//   2 + leafDataIndex = mixed leaf (need to check per-voxel bitmask)
fn queryBlock(bx: i32, by: i32, bz: i32) -> u32 {
    let depth = uniforms.treeDepth;
    var nodeIndex: u32 = 0u;

    for (var level: u32 = depth - 1u; ; ) {
        let node = nodes[nodeIndex];

        // Solid leaf sentinel
        if (node == SOLID_LEAF_MARKER) {
            return 1u;
        }

        let childMask = (node >> 24u) & 0xFFu;

        // childMask == 0 means this is a mixed leaf node
        if (childMask == 0u) {
            let leafIdx = node & 0x00FFFFFFu;
            return 2u + leafIdx;
        }

        // Determine octant at this level
        let bitX = (u32(bx) >> level) & 1u;
        let bitY = (u32(by) >> level) & 1u;
        let bitZ = (u32(bz) >> level) & 1u;
        let octant = (bitZ << 2u) | (bitY << 1u) | bitX;

        // Check if child exists
        if ((childMask & (1u << octant)) == 0u) {
            return 0u;
        }

        // Compute child index
        let baseOffset = node & 0x00FFFFFFu;
        let prefix = (1u << octant) - 1u;
        let childOffset = countOneBits(childMask & prefix);
        nodeIndex = baseOffset + childOffset;

        if (level == 0u) { break; }
        level -= 1u;
    }

    // Reached leaf level
    let node = nodes[nodeIndex];
    if (node == SOLID_LEAF_MARKER) {
        return 1u;
    }
    let leafIdx = node & 0x00FFFFFFu;
    return 2u + leafIdx;
}

// Check a single voxel bit in a mixed leaf
fn isVoxelSet(leafIdx: u32, vx: u32, vy: u32, vz: u32) -> bool {
    let bitIndex = vz * 16u + vy * 4u + vx;
    if (bitIndex < 32u) {
        let lo = leafData[leafIdx * 2u];
        return ((lo >> bitIndex) & 1u) == 1u;
    }
    let hi = leafData[leafIdx * 2u + 1u];
    return ((hi >> (bitIndex - 32u)) & 1u) == 1u;
}

// Ray-AABB intersection returning (tNear, tFar). If tNear > tFar → miss.
fn intersectAABB(ro: vec3f, invDir: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
    let t1 = (bmin - ro) * invDir;
    let t2 = (bmax - ro) * invDir;
    let tmin = min(t1, t2);
    let tmax = max(t1, t2);
    let tNear = max(max(tmin.x, tmin.y), tmin.z);
    let tFar  = min(min(tmax.x, tmax.y), tmax.z);
    return vec2f(tNear, tFar);
}

// Compute wireframe edge factor (0 = interior, 1 = on edge) for a hit point on a voxel cube.
// Uses the median of the three per-axis face distances so it works on ANY face.
fn edgeFactor(hitPos: vec3f, voxMin: vec3f, voxSize: f32, edgeWidth: f32) -> f32 {
    let local = (hitPos - voxMin) / voxSize;

    // Distance to nearest face boundary for each axis
    let fx = min(local.x, 1.0 - local.x);
    let fy = min(local.y, 1.0 - local.y);
    let fz = min(local.z, 1.0 - local.z);

    // Median of three values = second smallest = edge distance.
    // On a face, one of fx/fy/fz is ~0 (the face normal axis).
    // The median gives the smaller of the other two = distance to nearest edge.
    let edgeDist = max(min(fx, fy), min(max(fx, fy), fz));

    return 1.0 - smoothstep(0.0, edgeWidth, edgeDist);
}

// Shade a voxel hit, returning premultiplied RGBA
fn shadeVoxelHit(hitPos: vec3f, voxMin: vec3f, voxelRes: f32, ro: vec3f, isSolid: bool) -> vec4f {
    let dist = length(hitPos - ro);
    let pixelWorld = 2.0 * dist / (f32(uniforms.screenHeight) * uniforms.projScaleY);
    let ew = clamp(EDGE_PIXELS * pixelWorld / voxelRes, 0.01, 0.5);

    let ef = edgeFactor(hitPos, voxMin, voxelRes, ew);
    let distFade = clamp(1.0 - dist * 0.01, 0.2, 1.0);

    let local = (hitPos - voxMin) / voxelRes;
    let fx = min(local.x, 1.0 - local.x);
    let fy = min(local.y, 1.0 - local.y);
    let fz = min(local.z, 1.0 - local.z);

    var faceAxis: u32 = 0u;
    if (fy <= fx && fy <= fz) {
        faceAxis = 1u;
    } else if (fz <= fx) {
        faceAxis = 2u;
    }

    var baseColor: vec3f;
    if (isSolid) {
        if (faceAxis == 0u) { baseColor = vec3f(1.0, 0.25, 0.2); }
        else if (faceAxis == 1u) { baseColor = vec3f(0.8, 0.15, 0.1); }
        else { baseColor = vec3f(0.55, 0.08, 0.05); }
    } else {
        if (faceAxis == 0u) { baseColor = vec3f(0.7, 0.7, 0.72); }
        else if (faceAxis == 1u) { baseColor = vec3f(0.5, 0.5, 0.52); }
        else { baseColor = vec3f(0.33, 0.33, 0.35); }
    }

    let alpha = mix(FILL_ALPHA, EDGE_ALPHA, ef) * distFade;

    return vec4f(mix(baseColor, vec3f(0.0), alpha) * alpha, alpha);
}

// ---- main ----

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let px = i32(gid.x);
    let py = i32(gid.y);
    let sw = i32(uniforms.screenWidth);
    let sh = i32(uniforms.screenHeight);

    if (px >= sw || py >= sh) {
        return;
    }

    // Reconstruct world-space ray from pixel coordinates
    let ndcX = (f32(px) + 0.5) / f32(sw) * 2.0 - 1.0;
    let ndcY = -((f32(py) + 0.5) / f32(sh) * 2.0 - 1.0);

    let clipNear = vec4f(ndcX, ndcY, 0.0, 1.0);
    let clipFar  = vec4f(ndcX, ndcY, 1.0, 1.0);

    var worldNear = uniforms.invVP * clipNear;
    worldNear = worldNear / worldNear.w;
    var worldFar = uniforms.invVP * clipFar;
    worldFar = worldFar / worldFar.w;

    // Convert from PlayCanvas world space to voxel space (negate X and Y)
    let ro = vec3f(-worldNear.x, -worldNear.y, worldNear.z);
    let rd = normalize(vec3f(-(worldFar.x - worldNear.x), -(worldFar.y - worldNear.y), worldFar.z - worldNear.z));

    // Grid AABB
    let gridMin = vec3f(uniforms.gridMinX, uniforms.gridMinY, uniforms.gridMinZ);
    let gridMax = gridMin + vec3f(
        f32(uniforms.numVoxelsX),
        f32(uniforms.numVoxelsY),
        f32(uniforms.numVoxelsZ)
    ) * uniforms.voxelRes;

    let invDir = 1.0 / rd;
    let gridHit = intersectAABB(ro, invDir, gridMin, gridMax);

    if (gridHit.x > gridHit.y) {
        textureStore(outputTexture, vec2i(px, py), vec4f(0.0));
        return;
    }

    let tEntry = max(gridHit.x, 0.0) + 0.0001;

    // Entry point in voxel-index space
    let entryWorld = ro + rd * tEntry;
    let voxelRes = uniforms.voxelRes;
    let lsf = f32(uniforms.leafSize);
    let blockRes = voxelRes * lsf;
    let leafSz = i32(uniforms.leafSize);

    // Block-level DDA setup
    let entryBlock = (entryWorld - gridMin) / blockRes;
    let numBlocksX = i32(uniforms.numVoxelsX / uniforms.leafSize);
    let numBlocksY = i32(uniforms.numVoxelsY / uniforms.leafSize);
    let numBlocksZ = i32(uniforms.numVoxelsZ / uniforms.leafSize);

    var bx = clamp(i32(floor(entryBlock.x)), 0, numBlocksX - 1);
    var by = clamp(i32(floor(entryBlock.y)), 0, numBlocksY - 1);
    var bz = clamp(i32(floor(entryBlock.z)), 0, numBlocksZ - 1);

    let stepX = select(-1, 1, rd.x >= 0.0);
    let stepY = select(-1, 1, rd.y >= 0.0);
    let stepZ = select(-1, 1, rd.z >= 0.0);

    let tDeltaX = abs(blockRes / rd.x);
    let tDeltaY = abs(blockRes / rd.y);
    let tDeltaZ = abs(blockRes / rd.z);

    // tMax: t value to reach next block boundary along each axis
    let blockMinWorld = gridMin + vec3f(f32(bx), f32(by), f32(bz)) * blockRes;
    let nextBoundX = select(blockMinWorld.x, blockMinWorld.x + blockRes, rd.x >= 0.0);
    let nextBoundY = select(blockMinWorld.y, blockMinWorld.y + blockRes, rd.y >= 0.0);
    let nextBoundZ = select(blockMinWorld.z, blockMinWorld.z + blockRes, rd.z >= 0.0);

    var tMaxX = (nextBoundX - ro.x) / rd.x;
    var tMaxY = (nextBoundY - ro.y) / rd.y;
    var tMaxZ = (nextBoundZ - ro.z) / rd.z;

    // First-hit result
    var hitColor = vec3f(0.0);
    var hitAlpha: f32 = 0.0;
    var gotHit = false;

    for (var step: u32 = 0u; step < MAX_STEPS; step++) {
        if (gotHit) { break; }

        if (bx < 0 || by < 0 || bz < 0 ||
            bx >= numBlocksX || by >= numBlocksY || bz >= numBlocksZ) {
            break;
        }

        let blockResult = queryBlock(bx, by, bz);

        if (blockResult != 0u) {
            let blockOrigin = gridMin + vec3f(f32(bx), f32(by), f32(bz)) * blockRes;

            let blockMax = blockOrigin + vec3f(blockRes);
            let bHit = intersectAABB(ro, invDir, blockOrigin, blockMax);
            let tBlockEntry = max(bHit.x, 0.0);

            // Voxel-level DDA within the block
            let entryVoxWorld = ro + rd * (tBlockEntry + 0.0001);
            let entryLocal = (entryVoxWorld - blockOrigin) / voxelRes;
            var vx = clamp(i32(floor(entryLocal.x)), 0, leafSz - 1);
            var vy = clamp(i32(floor(entryLocal.y)), 0, leafSz - 1);
            var vz = clamp(i32(floor(entryLocal.z)), 0, leafSz - 1);

            let vTDeltaX = abs(voxelRes / rd.x);
            let vTDeltaY = abs(voxelRes / rd.y);
            let vTDeltaZ = abs(voxelRes / rd.z);

            let voxOrigin = blockOrigin + vec3f(f32(vx), f32(vy), f32(vz)) * voxelRes;
            let vNextX = select(voxOrigin.x, voxOrigin.x + voxelRes, rd.x >= 0.0);
            let vNextY = select(voxOrigin.y, voxOrigin.y + voxelRes, rd.y >= 0.0);
            let vNextZ = select(voxOrigin.z, voxOrigin.z + voxelRes, rd.z >= 0.0);

            var vTMaxX = (vNextX - ro.x) / rd.x;
            var vTMaxY = (vNextY - ro.y) / rd.y;
            var vTMaxZ = (vNextZ - ro.z) / rd.z;

            for (var vStep: u32 = 0u; vStep < 12u; vStep++) {
                if (gotHit) { break; }
                if (vx < 0 || vy < 0 || vz < 0 ||
                    vx >= leafSz || vy >= leafSz || vz >= leafSz) {
                    break;
                }

                var isSolid = false;

                if (blockResult == 1u) {
                    isSolid = true;
                } else {
                    let leafIdx = blockResult - 2u;
                    isSolid = isVoxelSet(leafIdx, u32(vx), u32(vy), u32(vz));
                }

                if (isSolid) {
                    let voxMin = blockOrigin + vec3f(f32(vx), f32(vy), f32(vz)) * voxelRes;
                    let voxMax = voxMin + vec3f(voxelRes);
                    let vHit = intersectAABB(ro, invDir, voxMin, voxMax);
                    let tVoxHit = max(vHit.x, 0.0);
                    let hitPos = ro + rd * (tVoxHit + 0.0001);

                    let shade = shadeVoxelHit(hitPos, voxMin, voxelRes, ro, blockResult == 1u);
                    hitColor = shade.xyz;
                    hitAlpha = shade.w;
                    gotHit = true;
                }

                // Advance voxel DDA
                if (vTMaxX < vTMaxY && vTMaxX < vTMaxZ) {
                    vx += stepX;
                    vTMaxX += vTDeltaX;
                } else if (vTMaxY < vTMaxZ) {
                    vy += stepY;
                    vTMaxY += vTDeltaY;
                } else {
                    vz += stepZ;
                    vTMaxZ += vTDeltaZ;
                }

            }
        }

        // Advance block DDA
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
            bx += stepX;
            tMaxX += tDeltaX;
        } else if (tMaxY < tMaxZ) {
            by += stepY;
            tMaxY += tDeltaY;
        } else {
            bz += stepZ;
            tMaxZ += tDeltaZ;
        }
    }

    // Write premultiplied alpha output
    textureStore(outputTexture, vec2i(px, py), vec4f(hitColor, hitAlpha));
}
`;

// ---------------------------------------------------------------------------
// VoxelDebugOverlay class
// ---------------------------------------------------------------------------

class VoxelDebugOverlay {
    private app: AppBase;
    private camera: Entity;
    private compute: Compute;
    private storageTexture: Texture;
    private overlayMaterial: ShaderMaterial;
    private nodesBuffer: StorageBuffer;
    private leafDataBuffer: StorageBuffer;
    private collider: VoxelCollider;

    private currentWidth = 0;
    private currentHeight = 0;

    private readonly invVP = new Mat4();
    private readonly vpTemp = new Mat4();

    /** Whether the overlay is currently rendering. */
    enabled = false;

    constructor(app: AppBase, collider: VoxelCollider, camera: Entity) {
        this.app = app;
        this.camera = camera;
        this.collider = collider;

        const device = app.graphicsDevice;

        // Upload SVO node array as a read-only storage buffer
        const nodesData = collider.nodes;
        const nodesByteSize = Math.max(nodesData.byteLength, 4);
        this.nodesBuffer = new StorageBuffer(device, nodesByteSize, BUFFERUSAGE_COPY_DST);
        if (nodesData.byteLength > 0) {
            this.nodesBuffer.write(0, nodesData.buffer, nodesData.byteOffset, nodesData.byteLength);
        }

        // Upload leaf data as a read-only storage buffer
        const leafDataArr = collider.leafData;
        const leafByteSize = Math.max(leafDataArr.byteLength, 4);
        this.leafDataBuffer = new StorageBuffer(device, leafByteSize, BUFFERUSAGE_COPY_DST);
        if (leafDataArr.byteLength > 0) {
            this.leafDataBuffer.write(0, leafDataArr.buffer, leafDataArr.byteOffset, leafDataArr.byteLength);
        }

        // Create the initial storage texture (will be resized on first update)
        this.currentWidth = Math.max(device.width, 1);
        this.currentHeight = Math.max(device.height, 1);
        this.storageTexture = this.createStorageTexture(this.currentWidth, this.currentHeight);

        // Create compute shader
        const shader = new Shader(device, {
            name: 'VoxelDebugOverlay',
            shaderLanguage: SHADERLANGUAGE_WGSL,
            cshader: voxelOverlayWGSL,
            computeUniformBufferFormats: {
                uniforms: new UniformBufferFormat(device, [
                    new UniformFormat('invVP', UNIFORMTYPE_MAT4),
                    new UniformFormat('screenWidth', UNIFORMTYPE_UINT),
                    new UniformFormat('screenHeight', UNIFORMTYPE_UINT),
                    new UniformFormat('gridMinX', UNIFORMTYPE_FLOAT),
                    new UniformFormat('gridMinY', UNIFORMTYPE_FLOAT),
                    new UniformFormat('gridMinZ', UNIFORMTYPE_FLOAT),
                    new UniformFormat('voxelRes', UNIFORMTYPE_FLOAT),
                    new UniformFormat('numVoxelsX', UNIFORMTYPE_UINT),
                    new UniformFormat('numVoxelsY', UNIFORMTYPE_UINT),
                    new UniformFormat('numVoxelsZ', UNIFORMTYPE_UINT),
                    new UniformFormat('leafSize', UNIFORMTYPE_UINT),
                    new UniformFormat('treeDepth', UNIFORMTYPE_UINT),
                    new UniformFormat('projScaleY', UNIFORMTYPE_FLOAT),
                    new UniformFormat('pad1', UNIFORMTYPE_UINT),
                    new UniformFormat('pad2', UNIFORMTYPE_UINT)
                ])
            },
            computeBindGroupFormat: new BindGroupFormat(device, [
                new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE),
                new BindStorageBufferFormat('nodes', SHADERSTAGE_COMPUTE, true),
                new BindStorageBufferFormat('leafData', SHADERSTAGE_COMPUTE, true),
                new BindStorageTextureFormat('outputTexture', PIXELFORMAT_RGBA8, TEXTUREDIMENSION_2D)
            ])
        });

        // Create compute instance
        this.compute = new Compute(device, shader, 'VoxelDebugOverlay');

        // Create overlay material with premultiplied alpha blending and a custom
        // fragment shader that preserves the texture's alpha channel (the built-in
        // getTextureShaderDesc hardcodes alpha = 1.0, which prevents blending).
        this.overlayMaterial = new ShaderMaterial();
        this.overlayMaterial.cull = CULLFACE_NONE;
        this.overlayMaterial.blendType = BLEND_PREMULTIPLIED;
        this.overlayMaterial.depthTest = false;
        this.overlayMaterial.depthWrite = false;
        this.overlayMaterial.setParameter('colorMap', this.storageTexture);
        this.overlayMaterial.shaderDesc = {
            uniqueName: 'VoxelOverlayComposite',
            vertexGLSL: /* glsl */ `
                attribute vec2 vertex_position;
                uniform mat4 matrix_model;
                varying vec2 uv0;
                void main(void) {
                    gl_Position = matrix_model * vec4(vertex_position, 0, 1);
                    uv0 = vertex_position.xy + 0.5;
                }
            `,
            vertexWGSL: /* wgsl */ `
                attribute vertex_position: vec2f;
                uniform matrix_model: mat4x4f;
                varying uv0: vec2f;
                @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniform.matrix_model * vec4f(input.vertex_position, 0.0, 1.0);
                    output.uv0 = input.vertex_position.xy + vec2f(0.5);
                    return output;
                }
            `,
            fragmentGLSL: /* glsl */ `
                varying vec2 uv0;
                uniform sampler2D colorMap;
                void main(void) {
                    gl_FragColor = texture2D(colorMap, uv0);
                }
            `,
            fragmentWGSL: /* wgsl */ `
                varying uv0: vec2f;
                var colorMap: texture_2d<f32>;
                var colorMapSampler: sampler;
                @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
                    var output: FragmentOutput;
                    output.color = textureSample(colorMap, colorMapSampler, input.uv0);
                    return output;
                }
            `,
            attributes: { vertex_position: SEMANTIC_POSITION }
        };
        this.overlayMaterial.update();
    }

    private createStorageTexture(width: number, height: number): Texture {
        return new Texture(this.app.graphicsDevice, {
            name: 'VoxelOverlay-Storage',
            width,
            height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            addressU: 3,    // ADDRESS_CLAMP_TO_EDGE
            addressV: 3,    // ADDRESS_CLAMP_TO_EDGE
            storage: true
        });
    }

    update(): void {
        if (!this.enabled) return;

        const { app, camera, compute, collider } = this;
        const device = app.graphicsDevice;
        const width = device.width;
        const height = device.height;

        if (width <= 0 || height <= 0) return;

        // Resize storage texture if screen dimensions changed
        if (width !== this.currentWidth || height !== this.currentHeight) {
            this.storageTexture.destroy();
            this.currentWidth = width;
            this.currentHeight = height;
            this.storageTexture = this.createStorageTexture(width, height);

            // Update the overlay material to reference the new texture
            this.overlayMaterial.setParameter('colorMap', this.storageTexture);
            this.overlayMaterial.update();
        }

        // Compute inverse view-projection matrix
        const cam = camera.camera;
        this.vpTemp.mul2(cam.projectionMatrix, cam.viewMatrix);
        this.invVP.copy(this.vpTemp).invert();

        // Set compute uniforms
        compute.setParameter('invVP', this.invVP.data);
        compute.setParameter('screenWidth', width);
        compute.setParameter('screenHeight', height);
        compute.setParameter('gridMinX', collider.gridMinX);
        compute.setParameter('gridMinY', collider.gridMinY);
        compute.setParameter('gridMinZ', collider.gridMinZ);
        compute.setParameter('voxelRes', collider.voxelResolution);
        compute.setParameter('numVoxelsX', collider.numVoxelsX);
        compute.setParameter('numVoxelsY', collider.numVoxelsY);
        compute.setParameter('numVoxelsZ', collider.numVoxelsZ);
        compute.setParameter('leafSize', collider.leafSize);
        compute.setParameter('treeDepth', collider.treeDepth);
        compute.setParameter('projScaleY', cam.projectionMatrix.data[5]);
        compute.setParameter('pad1', 0);
        compute.setParameter('pad2', 0);

        // Set storage buffers and output texture
        compute.setParameter('nodes', this.nodesBuffer);
        compute.setParameter('leafData', this.leafDataBuffer);
        compute.setParameter('outputTexture', this.storageTexture);

        // Dispatch compute shader
        const workgroupsX = Math.ceil(width / 8);
        const workgroupsY = Math.ceil(height / 8);
        compute.setupDispatch(workgroupsX, workgroupsY, 1);
        device.computeDispatch([compute], 'VoxelDebugOverlay');

        // Composite overlay on top of the scene
        app.drawTexture(0, 0, 2, 2, null, this.overlayMaterial);
    }

    destroy(): void {
        this.nodesBuffer?.destroy();
        this.leafDataBuffer?.destroy();
        this.storageTexture?.destroy();
    }
}

export { VoxelDebugOverlay };
