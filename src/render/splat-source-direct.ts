// Data path (ii): the projector reads each resident file's own textures (sog, ply or
// compressed ply) through the engine's format read chunks, so nothing is copied into a work
// buffer: no decoded 24-byte copy per splat, no re-copy when a node's lod changes, no
// colour refresh when the camera turns. The price is one dispatch per resident file, the
// model transform and the sh evaluation per splat per frame.
//
// Interim: the engine still allocates its work buffer and would keep copying into it, so the
// copy passes are switched off on the work buffer this source sees; the textures themselves
// stay until engine change E2 (no work buffer in external mode) lands.
import {
    PIXELFORMAT_RGBA32F,
    Quat,
    SAMPLETYPE_UNFILTERABLE_FLOAT,
    ShaderChunks,
    SHADERLANGUAGE_WGSL,
    Vec3
} from 'playcanvas';
import type { BindTextureFormat, Compute, GraphicsDevice } from 'playcanvas';

import type {
    EngineManager,
    EngineResource,
    EngineWorkBuffer,
    ResidentFile,
    ResidentNode,
    ResidentSet
} from './resident-set';
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
        this.patchWorkBuffer(manager.world.workBuffer);
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
        return defines;
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
        for (const [name, texture] of resource.streams.textures) {
            compute.setParameter(name, texture);
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
        // the file textures belong to the engine and are counted by app.stats.vram
        return 0;
    }

    shaderKey() {
        const resource = this.resource;
        if (!resource) return 'direct:';
        const defines = this.shaderDefines();
        return `direct:${resource.format.hash}:${[...defines].map(([k, v]) => `${k}=${v}`).join(',')}`;
    }

    destroy() {
        this.restoreWorkBuffer();
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
