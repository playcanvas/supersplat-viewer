// Data path (i): the engine's work buffer as-is. The engine keeps copying sog nodes into its
// square textures (world-space centres, sh colour baked for this camera) and the projector
// reads them through the engine's own generated read code, so this path needs nothing new
// from the engine and is the functional baseline for the others.
import type { Compute } from 'playcanvas';

import type { EngineManager, EngineWorkBuffer, ResidentSet } from './resident-set';
import type { DispatchGroup, SplatSource } from './splat-source';

class WorkBufferSplatSource implements SplatSource {
    readonly kind = 'workbuffer' as const;

    private workBuffer: EngineWorkBuffer | null = null;

    update(set: ResidentSet, manager: EngineManager) {
        this.workBuffer = manager.world.workBuffer;
    }

    readChunk(bindingBase: number) {
        const format = this.require().format;
        // the engine's declarations bind one texture per stream from bindingBase and define
        // loadDataX(); its read code decodes them into getCenter() and friends
        return `${format.getComputeInputDeclarations(bindingBase)}\n${format.getReadCode()}`;
    }

    bindFormats() {
        return this.require().format.getComputeBindFormats();
    }

    dispatchPlan(set: ResidentSet, numChunks: number): DispatchGroup[] {
        return [{ fileIndex: -1, chunkBase: 0, chunkCount: numChunks }];
    }

    bind(compute: Compute) {
        const workBuffer = this.require();
        for (const stream of workBuffer.format.streams) {
            compute.setParameter(stream.name, workBuffer.getTexture(stream.name));
        }
    }

    textureSize() {
        return this.require().textureSize;
    }

    gpuBytes() {
        // the work buffer belongs to the engine and is counted by app.stats.vram
        return 0;
    }

    shaderKey() {
        const workBuffer = this.workBuffer;
        return workBuffer ? `wb:${workBuffer.format.streams.map((s) => s.name).join(',')}` : 'wb:';
    }

    destroy() {
        this.workBuffer = null;
    }

    private require() {
        if (!this.workBuffer) throw new Error('WorkBufferSplatSource: update() has not run');
        return this.workBuffer;
    }
}

export { WorkBufferSplatSource };
