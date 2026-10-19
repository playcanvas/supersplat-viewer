import type { AppBase, EventHandle } from 'playcanvas';

// TEMPORARY workaround for Safari on Apple Vision Pro (https://bugs.webkit.org/show_bug.cgi?id=327533),
// until the viewer requires an engine with the same fix (playcanvas/engine#9748): then delete this
// file. The engine creates the WebGPU projection layer without a depth format, so per the
// WebXR/WebGPU binding spec it has no depth texture, and the browser clears any it does have to 1
// every frame. Safari hands out one it never clears, and its compositor reads it to reproject a
// frame that misses its display time: head-locked content doubles as the head turns, and the scene
// shakes as it moves sideways. Each eye's depth is cleared to the far plane here, so the compositor
// corrects a late frame by its rotation alone. A browser that follows the spec gives no depth
// texture, so this does nothing there.

// The WebGPU calls this makes, typed here: the project carries no WebGPU typings
type GpuTexture = { format: string; createView(descriptor: object): unknown };

type GpuSubImage = {
    depthStencilTexture: GpuTexture | null;
    getViewDescriptor?(): { baseArrayLayer?: number } | null;
};

type GpuBinding = { getViewSubImage(layer: unknown, view: XRView): GpuSubImage };

// the engine internals this reads: the projection layer it renders into, the reference space of its
// frames, and the command encoder of the device's frame, which the engine's own fix records on
type EngineXr = {
    xrBridge: { presentationLayer: unknown } | null;
    _referenceSpace: XRReferenceSpace | null;
};

type EngineDevice = {
    getCommandEncoder(): { beginRenderPass(descriptor: object): { end(): void } };
};

/**
 * Clears each eye's depth texture of a WebGPU XR session to the far plane every frame, ahead of the
 * engine's frame.
 *
 * @param app - The application, on a WebGPU device.
 * @returns The handle of the frame listener, to turn it off with.
 */
const initXrDepthClear = (app: AppBase): EventHandle => {
    const { xr } = app;
    const engineXr = xr as unknown as EngineXr;
    const device = app.graphicsDevice as unknown as EngineDevice;

    return xr.on('update', (frame: XRFrame) => {
        const binding = xr.graphicsBinding as GpuBinding | null;
        const layer = engineXr.xrBridge?.presentationLayer;
        const space = engineXr._referenceSpace;
        if (!binding || !layer || !space) return;

        const views = frame.getViewerPose(space)?.views;
        if (!views) return;

        for (const view of views) {
            // Safari throws while the layer's first frame is not ready, which the engine's frame
            // reports right after this
            let texture: GpuTexture | null;
            let baseArrayLayer: number;
            try {
                const sub = binding.getViewSubImage(layer, view);
                texture = sub.depthStencilTexture;
                if (!texture) continue;
                // the eye's own array layer, as for its colour
                baseArrayLayer = sub.getViewDescriptor?.()?.baseArrayLayer ?? 0;
            } catch {
                return;
            }

            const attachment: Record<string, unknown> = {
                view: texture.createView({
                    dimension: '2d',
                    baseMipLevel: 0,
                    mipLevelCount: 1,
                    baseArrayLayer,
                    arrayLayerCount: 1
                }),
                depthClearValue: 1,
                depthLoadOp: 'clear',
                depthStoreOp: 'store'
            };
            if (texture.format.includes('stencil')) {
                attachment.stencilLoadOp = 'clear';
                attachment.stencilStoreOp = 'store';
            }

            device
                .getCommandEncoder()
                .beginRenderPass({ colorAttachments: [], depthStencilAttachment: attachment })
                .end();
        }
    });
};

export { initXrDepthClear };
