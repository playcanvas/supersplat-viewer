import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NONE,
    BlendState,
    CULLFACE_NONE,
    FILTER_NEAREST,
    PIXELFORMAT_R16F,
    PIXELFORMAT_R32F,
    RenderTarget,
    SEMANTIC_POSITION,
    ShaderMaterial,
    ShaderUtils,
    Texture,
    drawQuadWithShader
} from 'playcanvas';
import type { AppBase, Entity, Shader } from 'playcanvas';

import { PICK_TRIALS, SURFACE_OPACITY, SURFACE_RADIUS_PX } from '../picker';
import type { ScenePicker } from '../picker';

// the pick render's samples in a surface disc, and how many of the nearest the quantile needs
let discPixels = 0;
for (let dy = -SURFACE_RADIUS_PX; dy <= SURFACE_RADIUS_PX; dy++) {
    for (let dx = -SURFACE_RADIUS_PX; dx <= SURFACE_RADIUS_PX; dx++) {
        if (dx * dx + dy * dy <= SURFACE_RADIUS_PX * SURFACE_RADIUS_PX) discPixels++;
    }
}
const NEAREST = Math.ceil(discPixels * PICK_TRIALS * SURFACE_OPACITY);
const R = SURFACE_RADIUS_PX;

// Resolve: each pixel's surface depth, the SURFACE_OPACITY quantile of the pick render's
// nearest survivors over the same disc as `Picker.pickSurface`, as linear view depth; 0 where
// no surface is found
const resolveGlsl = /* glsl */ `
uniform highp sampler2D pickDepth;
uniform vec2 pickRange;
uniform float surfaceOpacity;
void main(void) {
    ivec2 size = textureSize(pickDepth, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    float nearest[${NEAREST}];
    for (int i = 0; i < ${NEAREST}; i++) nearest[i] = 2.0;
    int n = 0;
    for (int dy = -${R}; dy <= ${R}; dy++) {
        for (int dx = -${R}; dx <= ${R}; dx++) {
            ivec2 q = p + ivec2(dx, dy);
            if (dx * dx + dy * dy > ${R * R} || any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size))) continue;
            vec4 trials = texelFetch(pickDepth, q, 0);
            for (int c = 0; c < ${PICK_TRIALS}; c++) {
                float v = trials[c];
                n++;
                if (v < nearest[${NEAREST - 1}]) {
                    int i = ${NEAREST - 1};
                    while (i > 0 && nearest[i - 1] > v) {
                        nearest[i] = nearest[i - 1];
                        i--;
                    }
                    nearest[i] = v;
                }
            }
        }
    }
    float depth = nearest[clamp(int(ceil(float(n) * surfaceOpacity)) - 1, 0, ${NEAREST - 1})];
    float z = depth < 1.0 ? pickRange.x + depth * (pickRange.y - pickRange.x) : 0.0;
    gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
}
`;

const resolveWgsl = /* wgsl */ `
var pickDepth: texture_2d<uff>;
uniform pickRange: vec2f;
uniform surfaceOpacity: f32;
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let size = vec2i(textureDimensions(pickDepth, 0));
    let p = vec2i(pcPosition.xy);
    var nearest: array<f32, ${NEAREST}>;
    for (var i = 0; i < ${NEAREST}; i++) {
        nearest[i] = 2.0;
    }
    var n = 0;
    for (var dy = -${R}; dy <= ${R}; dy++) {
        for (var dx = -${R}; dx <= ${R}; dx++) {
            let q = p + vec2i(dx, dy);
            if (dx * dx + dy * dy > ${R * R} || any(q < vec2i(0)) || any(q >= size)) {
                continue;
            }
            let trials = textureLoad(pickDepth, q, 0);
            for (var c = 0; c < ${PICK_TRIALS}; c++) {
                let v = trials[c];
                n++;
                if (v < nearest[${NEAREST - 1}]) {
                    var i = ${NEAREST - 1};
                    loop {
                        if (i == 0 || nearest[i - 1] <= v) {
                            break;
                        }
                        nearest[i] = nearest[i - 1];
                        i--;
                    }
                    nearest[i] = v;
                }
            }
        }
    }
    let depth = nearest[clamp(i32(ceil(f32(n) * uniform.surfaceOpacity)) - 1, 0, ${NEAREST - 1})];
    let z = select(0.0, uniform.pickRange.x + depth * (uniform.pickRange.y - uniform.pickRange.x), depth < 1.0);
    output.color = vec4f(z, 0.0, 0.0, 1.0);
    return output;
}
`;

// Turbo colour map, polynomial approximation
const turboGlsl = /* glsl */ `
vec3 turbo(float x) {
    const vec4 r4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    const vec4 g4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    const vec4 b4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    const vec2 r2 = vec2(-152.94239396, 59.28637943);
    const vec2 g2 = vec2(4.27729857, 2.82956604);
    const vec2 b2 = vec2(-89.90310912, 27.34824973);
    vec4 v4 = vec4(1.0, x, x * x, x * x * x);
    vec2 v2 = v4.zw * v4.z;
    return vec3(dot(v4, r4) + dot(v2, r2), dot(v4, g4) + dot(v2, g2), dot(v4, b4) + dot(v2, b2));
}
`;

const turboWgsl = /* wgsl */ `
fn turbo(x: f32) -> vec3f {
    let r4 = vec4f(0.13572138, 4.61539260, -42.66032258, 132.13108234);
    let g4 = vec4f(0.09140261, 2.19418839, 4.84296658, -14.18503333);
    let b4 = vec4f(0.10667330, 12.64194608, -60.58204836, 110.36276771);
    let r2 = vec2f(-152.94239396, 59.28637943);
    let g2 = vec2f(4.27729857, 2.82956604);
    let b2 = vec2f(-89.90310912, 27.34824973);
    let v4 = vec4f(1.0, x, x * x, x * x * x);
    let v2 = v4.zw * v4.z;
    return vec3f(dot(v4, r4) + dot(v2, r2), dot(v4, g4) + dot(v2, g2), dot(v4, b4) + dot(v2, b2));
}
`;

// Colour: the resolved depth at this pixel, looked up at the pick render's css resolution from
// the target being drawn, whose size the renderer supplies as viewport_size: the backbuffer, or
// captureFrame's supersampled offscreen target
const colourGlsl = /* glsl */ `
uniform highp sampler2D surfaceDepth;
uniform vec4 viewport_size;
${turboGlsl}
void main(void) {
    ivec2 size = textureSize(surfaceDepth, 0);
    float z = texelFetch(surfaceDepth, ivec2(gl_FragCoord.xy * vec2(size) * viewport_size.zw), 0).r;
    gl_FragColor = z > 0.0 ? vec4(turbo(fract(log2(z))), 1.0) : vec4(0.6, 0.0, 0.6, 1.0);
}
`;

const colourWgsl = /* wgsl */ `
var surfaceDepth: texture_2d<uff>;
uniform viewport_size: vec4f;
${turboWgsl}
@fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let size = vec2f(textureDimensions(surfaceDepth, 0));
    let z = textureLoad(surfaceDepth, vec2i(pcPosition.xy * size * uniform.viewport_size.zw), 0).r;
    output.color = select(vec4f(0.6, 0.0, 0.6, 1.0), vec4f(turbo(fract(log2(z))), 1.0), z > 0.0);
    return output;
}
`;

/**
 * Debug view of the depth the picker resolves: every pixel shows the surface a navigation pick
 * there would find, the same SURFACE_OPACITY quantile of the pick render's nearest survivors
 * over the same disc, so no clicking around. Two passes: the depth is resolved once per pick
 * pixel, then coloured at the size of the target drawn. The colour runs through the map once
 * per doubling of distance, so noise and steps show at any scale; magenta is where no surface
 * is found.
 *
 * The pick and the resolve run after each frame, as a pick pass rendered during a frame can
 * come out empty, and only when the pick render changed (the camera moved, or new detail
 * landed), which then asks for a frame to show it: the view trails the camera by a frame while
 * it moves, and costs a pick pass per frame then. Offscreen renders (captureFrame) do not show
 * it, as it follows the on-screen camera, whose framing a capture need not share.
 */
class PickDepthOverlay {
    private readonly app: AppBase;

    private readonly camera: Entity;

    private readonly picker: ScenePicker;

    private readonly resolveShader: Shader;

    private readonly material = new ShaderMaterial();

    private depthTarget: RenderTarget | null = null;

    private readonly onFrameEnd = () => this.resolve();

    private readonly onPrerender = () => this.draw();

    // the pick render the resolved depth came from, by the picker's render count
    private resolvedRenders = -1;

    private _enabled = false;

    constructor(app: AppBase, camera: Entity, picker: ScenePicker) {
        this.app = app;
        this.camera = camera;
        this.picker = picker;

        this.resolveShader = ShaderUtils.createShader(app.graphicsDevice, {
            uniqueName: 'PickDepthResolve',
            attributes: { vertex_position: SEMANTIC_POSITION },
            vertexChunk: 'fullscreenQuadVS',
            fragmentGLSL: resolveGlsl,
            fragmentWGSL: resolveWgsl
        });

        const material = this.material;
        material.cull = CULLFACE_NONE;
        material.blendType = BLEND_NONE;
        material.depthTest = false;
        material.depthWrite = false;
        material.shaderDesc = {
            uniqueName: 'PickDepthColour',
            vertexGLSL: /* glsl */ `
                attribute vec2 vertex_position;
                uniform mat4 matrix_model;
                void main(void) {
                    gl_Position = matrix_model * vec4(vertex_position, 0, 1);
                }
            `,
            vertexWGSL: /* wgsl */ `
                attribute vertex_position: vec2f;
                uniform matrix_model: mat4x4f;
                @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    output.position = uniform.matrix_model * vec4f(input.vertex_position, 0.0, 1.0);
                    return output;
                }
            `,
            fragmentGLSL: colourGlsl,
            fragmentWGSL: colourWgsl,
            attributes: { vertex_position: SEMANTIC_POSITION }
        };
        material.update();
    }

    get enabled() {
        return this._enabled;
    }

    set enabled(value: boolean) {
        if (value === this._enabled) return;
        this._enabled = value;
        if (value) {
            this.app.on('frameend', this.onFrameEnd);
            this.app.on('prerender', this.onPrerender);
        } else {
            this.app.off('frameend', this.onFrameEnd);
            this.app.off('prerender', this.onPrerender);
            this.resolvedRenders = -1;
        }
        this.app.renderNextFrame = true;
    }

    private ensureDepthTarget(width: number, height: number) {
        const target = this.depthTarget;
        if (target && target.width === width && target.height === height) {
            return target;
        }
        target?.colorBuffer.destroy();
        target?.destroy();
        const device = this.app.graphicsDevice;
        const colorBuffer = new Texture(device, {
            name: 'pick-depth-resolved',
            width,
            height,
            format: device.textureFloatRenderable ? PIXELFORMAT_R32F : PIXELFORMAT_R16F,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        this.depthTarget = new RenderTarget({ name: 'pick-depth-resolved', colorBuffer, depth: false });
        return this.depthTarget;
    }

    private resolve() {
        if (this.camera.camera.renderTarget) return;
        const view = this.picker.renderView();
        if (!view || view.renders === this.resolvedRenders) return;
        this.resolvedRenders = view.renders;

        const device = this.app.graphicsDevice;
        const cam = this.camera.camera;
        const target = this.ensureDepthTarget(view.texture.width, view.texture.height);

        device.scope.resolve('pickDepth').setValue(view.texture);
        device.scope.resolve('pickRange').setValue([cam.nearClip, cam.farClip]);
        device.scope.resolve('surfaceOpacity').setValue(SURFACE_OPACITY);
        device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(device, target, this.resolveShader);

        // show it
        this.app.renderNextFrame = true;
    }

    private draw() {
        // nothing resolved yet: the first frame's end resolves, and asks for the next
        if (!this.depthTarget || this.resolvedRenders < 0 || this.camera.camera.renderTarget) return;
        this.material.setParameter('surfaceDepth', this.depthTarget.colorBuffer);
        this.app.drawTexture(0, 0, 2, 2, null, this.material);
    }

    destroy() {
        this.enabled = false;
        this.material.destroy();
        this.resolveShader.destroy();
        this.depthTarget?.colorBuffer.destroy();
        this.depthTarget?.destroy();
        this.depthTarget = null;
    }
}

export { PickDepthOverlay };
