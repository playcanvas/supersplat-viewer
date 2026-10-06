// Data path (ii): the projector reads each resident file's own textures, so nothing is copied
// into a work buffer: no decoded 24-byte copy per splat, no re-copy when a node's lod changes,
// no colour refresh when the camera turns. The price is one dispatch per resident file, the
// model transform and the sh evaluation per splat per frame.
//
// A sog v2 file is repacked once at load into two textures and its sh palette decoded to
// 11/11/10 bits (shaders/packed-source.ts), so the projector reads one texel per active splat,
// a second per survivor and no codebook per coefficient; measured on the Pixel 7 Pro against
// reading the six textures as they are: house 11.3 to 9.3 ms, large 11.2 to 9.4. Other formats
// (sog v1, ply, compressed ply) are read through the engine's format read chunks as they are.
//
// On an engine without the external renderer mode the work buffer is still materialised, so
// its copy passes are switched off on the buffer this source sees: nothing reads them.
import {
    ADDRESS_CLAMP_TO_EDGE,
    BindGroupFormat,
    BindStorageTextureFormat,
    BindTextureFormat,
    BindUniformBufferFormat,
    Compute,
    FILTER_NEAREST,
    PIXELFORMAT_R32U,
    PIXELFORMAT_RGBA32F,
    PIXELFORMAT_RGBA32U,
    Quat,
    SAMPLETYPE_FLOAT,
    SAMPLETYPE_UINT,
    SAMPLETYPE_UNFILTERABLE_FLOAT,
    Shader,
    ShaderChunks,
    SHADERLANGUAGE_WGSL,
    SHADERSTAGE_COMPUTE,
    Texture,
    TEXTUREDIMENSION_2D,
    UniformBufferFormat,
    UniformFormat,
    UNIFORMTYPE_VEC4,
    Vec3
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

import type {
    EngineManager,
    EngineResource,
    EngineWorkBuffer,
    ResidentFile,
    ResidentNode,
    ResidentSet
} from './resident-set';
import { decodeSHWGSL, packedReadWGSL, repackWGSL } from './shaders/packed-source';
import type { DispatchGroup, SplatSource } from './splat-source';

const tmpScale = new Vec3();
const tmpRotation = new Quat();

// per-file constants the projector's uniforms take
type FileConstants = { rotation: number[]; scale: number[] };

class DirectSplatSource implements SplatSource {
    readonly kind = 'direct' as const;

    private device: GraphicsDevice;

    private resource: EngineResource | null = null;

    private set: ResidentSet | null = null;

    private constants = new Map<number, FileConstants>();

    // the repacked textures per resident sog v2 file, and the compute that fills them
    private packed = new Map<EngineResource, { geom: Texture; color: Texture }>();

    private repack: Compute | null = null;

    // the decoded palette per file, with its decode compute: a compute owns the uniform buffer
    // its dispatch reads, and the codebook range is the file's
    private decodedSH = new Map<EngineResource, { texture: Texture; compute: Compute }>();

    private decodeSHShader: Shader | null = null;

    // the files' codebook ranges (min, extent), the palette's dequantisation constants
    private ranges = new Map<EngineResource, number[]>();

    private patched: {
        workBuffer: EngineWorkBuffer;
        render: EngineWorkBuffer['render'];
        renderColor: EngineWorkBuffer['renderColor'];
    } | null = null;

    constructor(device: GraphicsDevice) {
        this.device = device;
    }

    update(set: ResidentSet, manager: EngineManager) {
        // one format per scene: a sog lod set shares its format across files. The first file's
        // format compiles the projector; a file of another format is skipped by dispatchPlan
        this.resource = set.files[0]?.resource ?? this.resource;
        this.set = set;
        this.constants.clear();
        for (const file of set.files) {
            const m = file.modelMatrix;
            m.getScale(tmpScale);
            tmpRotation.setFromMat4(m);
            if (tmpRotation.w < 0) tmpRotation.mulScalar(-1);
            this.constants.set(file.fileIndex, {
                rotation: [tmpRotation.x, tmpRotation.y, tmpRotation.z, tmpRotation.w],
                scale: [tmpScale.x, tmpScale.y, tmpScale.z, 0]
            });
        }
        // On an engine without the external renderer mode the work buffer is still
        // materialised, and its copies are wasted work for this path; in that mode the world
        // leaves the buffer empty and there is nothing to skip.
        if (manager.world.workBufferEnabled !== false) this.patchWorkBuffer(manager.world.workBuffer);
        if (this.packedActive()) {
            for (const file of set.files) this.ensurePacked(file.resource);
        }
    }

    private decodedActive() {
        return this.packedActive() && this.hasSH();
    }

    // the file's codebook range
    private codebookRange(resource: EngineResource) {
        let range = this.ranges.get(resource);
        if (!range) {
            const codebook = resource.gsplatData?.meta?.shN?.codebook ?? [0, 1];
            let min = Infinity;
            let max = -Infinity;
            for (const value of codebook) {
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
            range = [min, Math.max(max - min, 1e-6), 0, 0];
            this.ranges.set(resource, range);
        }
        return range;
    }

    // decode a file's sh palette once: codebook indices to 11/11/10-bit coefficients
    private ensureDecodedSH(resource: EngineResource) {
        if (this.decodedSH.has(resource)) return;
        const { device } = this;
        const centroids = resource.streams.textures.get('sh_centroids')!;
        const texture = new Texture(device, {
            name: 'sse-splat-sh-decoded',
            width: centroids.width,
            height: centroids.height,
            format: PIXELFORMAT_R32U,
            mipmaps: false,
            storage: true,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        if (!this.decodeSHShader) {
            this.decodeSHShader = new Shader(device, {
                name: 'sse-splat-decode-sh',
                shaderLanguage: SHADERLANGUAGE_WGSL,
                cshader: decodeSHWGSL,
                computeUniformBufferFormats: {
                    uniforms: new UniformBufferFormat(device, [new UniformFormat('shRange', UNIFORMTYPE_VEC4)])
                },
                computeBindGroupFormat: new BindGroupFormat(device, [
                    new BindUniformBufferFormat('uniforms', SHADERSTAGE_COMPUTE),
                    new BindTextureFormat('sh_centroids', SHADERSTAGE_COMPUTE, undefined, SAMPLETYPE_FLOAT, false),
                    new BindTextureFormat(
                        'sogCodebook',
                        SHADERSTAGE_COMPUTE,
                        undefined,
                        SAMPLETYPE_UNFILTERABLE_FLOAT,
                        false
                    ),
                    new BindStorageTextureFormat('outSH', PIXELFORMAT_R32U, TEXTUREDIMENSION_2D)
                ])
            });
        }
        const compute = new Compute(device, this.decodeSHShader, 'sse-splat-decode-sh');
        compute.setParameter('sh_centroids', centroids);
        compute.setParameter('sogCodebook', resource.streams.textures.get('sogCodebook')!);
        compute.setParameter('outSH', texture);
        compute.setParameter('shRange', this.codebookRange(resource));
        compute.setupDispatch(Math.ceil(centroids.width / 16), Math.ceil(centroids.height / 16), 1);
        device.computeDispatch([compute], 'sse-splat-decode-sh');
        this.decodedSH.set(resource, { texture, compute });
    }

    // the packed layout applies to sog v2 files, the only ones the repack reads
    private packedActive() {
        const textures = this.resource?.streams.textures;
        return !!textures && textures.has('sogCodebook');
    }

    private hasSH() {
        const textures = this.resource?.streams.textures;
        return !!textures && textures.has('sh_labels') && textures.has('sh_centroids');
    }

    // repack a file once: its six RGBA8 textures into one geometry texel and one colour texel
    private ensurePacked(resource: EngineResource) {
        if (this.packed.has(resource)) return;
        const { device } = this;
        const { x: width, y: height } = resource.textureDimensions;
        const options = {
            width,
            height,
            mipmaps: false,
            storage: true,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        };
        const geom = new Texture(device, { ...options, name: 'sse-splat-packed-geom', format: PIXELFORMAT_RGBA32U });
        const color = new Texture(device, { ...options, name: 'sse-splat-packed-color', format: PIXELFORMAT_R32U });
        if (!this.repack) {
            const inputs = ['means_l', 'means_u', 'quats', 'scales', 'sh0', 'sh_labels'];
            this.repack = new Compute(
                device,
                new Shader(device, {
                    name: 'sse-splat-repack',
                    shaderLanguage: SHADERLANGUAGE_WGSL,
                    cshader: repackWGSL,
                    computeBindGroupFormat: new BindGroupFormat(device, [
                        ...inputs.map(
                            (name) =>
                                new BindTextureFormat(name, SHADERSTAGE_COMPUTE, undefined, SAMPLETYPE_FLOAT, false)
                        ),
                        new BindStorageTextureFormat('outGeom', PIXELFORMAT_RGBA32U, TEXTUREDIMENSION_2D),
                        new BindStorageTextureFormat('outColor', PIXELFORMAT_R32U, TEXTUREDIMENSION_2D)
                    ])
                }),
                'sse-splat-repack'
            );
        }
        const compute = this.repack;
        for (const name of ['means_l', 'means_u', 'quats', 'scales', 'sh0']) {
            compute.setParameter(name, resource.streams.textures.get(name)!);
        }
        // a file without sh has no labels: any texture serves, the label bits go unread
        const textures = resource.streams.textures;
        compute.setParameter('sh_labels', textures.get('sh_labels') ?? textures.get('sh0')!);
        compute.setParameter('outGeom', geom);
        compute.setParameter('outColor', color);
        compute.setupDispatch(Math.ceil(width / 16), Math.ceil(height / 16), 1);
        device.computeDispatch([compute], 'sse-splat-repack');
        this.packed.set(resource, { geom, color });
    }

    suspend() {
        this.restoreWorkBuffer();
    }

    // the engine's copy into the work buffer is wasted work for this path
    private patchWorkBuffer(workBuffer: EngineWorkBuffer) {
        if (this.patched?.workBuffer === workBuffer) return;
        this.restoreWorkBuffer();
        this.patched = { workBuffer, render: workBuffer.render, renderColor: workBuffer.renderColor };
        const skip = (): void => undefined;
        workBuffer.render = skip;
        workBuffer.renderColor = skip;
    }

    private restoreWorkBuffer() {
        if (!this.patched) return;
        const { workBuffer, render, renderColor } = this.patched;
        workBuffer.render = render;
        workBuffer.renderColor = renderColor;
        this.patched = null;
    }

    readChunk(bindingBase: number) {
        if (this.packedActive()) return packedReadWGSL(bindingBase, this.fileBands());
        const format = this.require().format;
        // The format's read chunk reads the file's own space and returns sh0 colour + alpha;
        // the adapter below applies the file's model transform and evaluates its sh for this
        // camera. Its loose `uniform` and texture declarations (dequantisation constants, the
        // compressed format's chunk texture) are reflected by the engine into a second bind
        // group and set by name like any other parameter.
        // The engine writes its 32-bit float streams (the sog v2 codebook) as `texture_2d<uff>`,
        // an alias only its reflection of loose declarations resolves; explicit bindings need
        // the wgsl type, and the matching unfilterable sample type in bindFormats()
        const declarations = format
            .getComputeInputDeclarations(bindingBase)
            .replace(/texture_2d<uff>/g, 'texture_2d<f32>');
        return /* wgsl */ `
#include "halfTypesCS"
#include "gsplatEvalSHVS"
${declarations}
${format.getReadCode()}

var<private> srcWorldCenter: vec3f;
var<private> srcColorCache: vec4f;

fn quatMulF(a: vec4f, b: vec4f) -> vec4f {
    return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

// v rotated by the inverse of q (x, y, z, w)
fn quatRotateInvF(q: vec4f, v: vec3f) -> vec3f {
    let u = -q.xyz;
    return v + 2.0 * cross(u, cross(u, v) + q.w * v);
}

fn srcCenter() -> vec3f {
    srcWorldCenter = (uniforms.model * vec4f(getCenter(), 1.0)).xyz;
    return srcWorldCenter;
}

fn srcOpacity() -> f32 {
    srcColorCache = getColor();
    return srcColorCache.a;
}

// the format returns (w, x, y, z); world = model * source
fn srcRotation() -> vec4f {
    let q = quatMulF(uniforms.modelRotation, getRotation().yzwx);
    return q.wxyz;
}

fn srcScale() -> vec3f {
    return uniforms.modelScale.xyz * getScale();
}

fn srcColor() -> vec3f {
    var color = srcColorCache.rgb;
    #if SH_BANDS > 0
        // the view direction in the file's space; orthographic rays all run along the camera forward
        let view = uniforms.view;
        let orthoDir = vec3f(0.0, 0.0, -1.0) * mat3x3f(view[0].xyz, view[1].xyz, view[2].xyz);
        let viewDir = select(srcWorldCenter - uniforms.cameraPosition.xyz, orthoDir, uniforms.isOrtho != 0u);
        let dir = normalize(quatRotateInvF(uniforms.modelRotation, viewDir));
        var sh: array<half3, SH_COEFFS>;
        var shScale: f32;
        readSHData(&sh, &shScale);
        color += vec3f(evalSH(&sh, dir) * half(shScale));
    #endif
    return color;
}
`;
    }

    bindFormats() {
        if (this.packedActive()) {
            return [
                new BindTextureFormat('packedGeom', SHADERSTAGE_COMPUTE, undefined, SAMPLETYPE_UINT, false),
                new BindTextureFormat('packedColor', SHADERSTAGE_COMPUTE, undefined, SAMPLETYPE_UINT, false),
                ...(this.hasSH()
                    ? [new BindTextureFormat('sh_centroids', SHADERSTAGE_COMPUTE, undefined, SAMPLETYPE_UINT, false)]
                    : []),
                new BindTextureFormat(
                    'sogCodebook',
                    SHADERSTAGE_COMPUTE,
                    undefined,
                    SAMPLETYPE_UNFILTERABLE_FLOAT,
                    false
                )
            ];
        }
        const format = this.require().format;
        const entries = format.getComputeBindFormats() as BindTextureFormat[];
        for (const entry of entries) {
            const stream = format.streams.find((s) => s.name === entry.name);
            if (stream?.format === PIXELFORMAT_RGBA32F) entry.sampleType = SAMPLETYPE_UNFILTERABLE_FLOAT;
        }
        return entries;
    }

    shaderIncludes() {
        // the read chunks include the engine's own gsplat chunks by name
        return new Map(ShaderChunks.get(this.device, SHADERLANGUAGE_WGSL) as unknown as Map<string, string>);
    }

    shaderDefines() {
        const defines = new Map<string, string>();
        this.require().configureMaterialDefines(defines);
        if (this.packedActive()) defines.set('SSE_PACKED_SOURCE', '1');
        if (this.decodedActive()) defines.set('SSE_SH_DECODED', '1');
        return defines;
    }

    // the file's sh bands, from the defines the engine sets for it
    private fileBands() {
        const defines = new Map<string, string>();
        this.require().configureMaterialDefines(defines);
        return Number(defines.get('SH_BANDS') ?? 0);
    }

    chunkBase(node: ResidentNode) {
        return node.sourceBase;
    }

    dispatchPlan(set: ResidentSet): DispatchGroup[] {
        // one run of the chunk table per file (the table is built file by file)
        const groups: DispatchGroup[] = [];
        let chunkBase = 0;
        const hash = this.resource?.format.hash;
        for (const file of set.files) {
            let chunkCount = 0;
            for (const node of file.nodes) chunkCount += Math.ceil(node.count / 256);
            if (chunkCount > 0 && file.resource.format.hash === hash) {
                groups.push({ fileIndex: file.fileIndex, chunkBase, chunkCount });
            }
            chunkBase += chunkCount;
        }
        return groups;
    }

    bind(compute: Compute, group: DispatchGroup, set: ResidentSet) {
        const file: ResidentFile = set.files[group.fileIndex];
        const { resource } = file;
        if (this.packedActive()) {
            // update() repacks the set's files; this covers one it has not seen
            this.ensurePacked(resource);
            const packed = this.packed.get(resource)!;
            compute.setParameter('packedGeom', packed.geom);
            compute.setParameter('packedColor', packed.color);
            if (this.decodedActive()) {
                this.ensureDecodedSH(resource);
                compute.setParameter('sh_centroids', this.decodedSH.get(resource)!.texture);
                compute.setParameter('shRange', this.codebookRange(resource));
            }
            compute.setParameter('sogCodebook', resource.streams.textures.get('sogCodebook')!);
        } else {
            for (const [name, texture] of resource.streams.textures) {
                compute.setParameter(name, texture);
            }
        }
        for (const [name, value] of resource.parameters) {
            compute.setParameter(name, value as number | number[]);
        }
        const constants = this.constants.get(file.fileIndex)!;
        compute.setParameter('model', file.modelMatrix.data);
        compute.setParameter('modelRotation', constants.rotation);
        compute.setParameter('modelScale', constants.scale);
    }

    textureSize(group: DispatchGroup) {
        return this.set?.files[group.fileIndex].resource.textureDimensions.x ?? 0;
    }

    gpuBytes() {
        // the file textures belong to the engine and are counted by app.stats.vram; the
        // repacked copies are this source's
        let bytes = 0;
        for (const { geom, color } of this.packed.values()) bytes += geom.gpuSize + color.gpuSize;
        for (const { texture } of this.decodedSH.values()) bytes += texture.gpuSize;
        return bytes;
    }

    shaderKey() {
        const resource = this.resource;
        if (!resource) return 'direct:';
        const defines = this.shaderDefines();
        return `direct:${resource.format.hash}:${[...defines].map(([k, v]) => `${k}=${v}`).join(',')}`;
    }

    destroy() {
        this.restoreWorkBuffer();
        for (const { geom, color } of this.packed.values()) {
            geom.destroy();
            color.destroy();
        }
        this.packed.clear();
        this.repack?.shader.destroy();
        this.repack?.destroy();
        this.repack = null;
        for (const { texture, compute } of this.decodedSH.values()) {
            texture.destroy();
            compute.destroy();
        }
        this.decodedSH.clear();
        this.ranges.clear();
        this.decodeSHShader?.destroy();
        this.decodeSHShader = null;
        this.resource = null;
        this.set = null;
        this.constants.clear();
    }

    private require() {
        if (!this.resource) throw new Error('DirectSplatSource: update() has not run');
        return this.resource;
    }
}

export { DirectSplatSource };
