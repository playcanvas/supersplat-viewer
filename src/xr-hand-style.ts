import { BLEND_NORMAL, SHADERLANGUAGE_GLSL, SHADERLANGUAGE_WGSL, StandardMaterial } from 'playcanvas';
import type { Entity, RenderComponent } from 'playcanvas';

import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// The glitter is laid out in the model's rest pose (its vertices before the bones bend them), in
// metres, so it is continuous over the whole hand, uv seams or not, and stays on the skin as the
// fingers bend. The input profiles' generic hand (the model every headset gets: the Oculus hand
// profile has none) is 21 cm along its y axis, fingers included.
// The glitter's lattice: a flake in a random GLITTER_SHARE of its cells, so it shows no rows, a
// ball of the given radius as a share of the cell; its facing strays from the skin's by up to
// GLITTER_TILT, and it lights up as it turns to the eye by the power GLITTER_SHARPNESS, out again
// some 12 degrees away. The two eyes see a hand at arm's length some 9 degrees apart, so they catch
// flakes of their own too, as with real glitter.
// The cells are GLITTER_CELL (0.55 mm) where the pixels are small enough, and coarsen by powers of
// two until a cell spans GLITTER_CELL_PIXELS pixels, so a flake stays about a pixel across at any
// distance and on any headset (the Quest's pixels are twice the Vision Pro's); the next coarser
// level fades in over the last GLITTER_BLEND of each step, so nothing pops
const GLITTER_CELL = 0.00055;
const GLITTER_CELL_PIXELS = 2.5;
const GLITTER_BLEND = 0.3;
const GLITTER_SHARE = 0.75;
const GLITTER_RADIUS = 0.17;
const GLITTER_TILT = 0.8;
const GLITTER_SHARPNESS = 32;
// The glitter shows only where the skin faces the eye: all of it within 4 degrees of facing, fading
// to none by 25 degrees, as cosines
const GLITTER_FULL = Math.cos((4 * Math.PI) / 180).toFixed(4);
const GLITTER_GONE = Math.cos((25 * Math.PI) / 180).toFixed(4);

// The hand fades out between these heights of the rest pose, from the heel of the palm to the
// model's end, 2 cm past the wrist joint (at 0.056), so it does not end in a cut
const WRIST_FADE_START = 0.025;
const WRIST_FADE_END = 0.075;

const COLOR = [0.3, 0.85, 1.0];
const OPACITY = 0.45;

// The vertex shader passes the rest pose's position on
const declarationVSWGSL = /* wgsl */ `
varying vRestPosition: vec3f;
`;

const mainEndVSWGSL = /* wgsl */ `
    output.vRestPosition = vertex_position.xyz;
`;

const declarationVSGLSL = /* glsl */ `
varying vec3 vRestPosition;
`;

const mainEndVSGLSL = /* glsl */ `
    vRestPosition = vertex_position.xyz;
`;

// The rim and the glitter are worked out in the opacity chunk, which every pass includes first,
// and the emissive chunk, forward pass only, reuses them. They need the world normal and view
// direction, which only a lit forward pass computes (LIT_NEEDS_NORMAL). The glitter
// is projected not at all: each flake is a ball at a random place in the middle of its cell of a 3d
// lattice, so the skin shows the flakes it passes through, larger the nearer their centres,
// anti-aliased over a pixel. A flake's tilt is random in world space rather than the hand's, which
// glitter cannot show. The derivatives are taken up front, so the second level can be skipped
// where it has no weight
const opacityWGSL = /* wgsl */ `
uniform material_opacity: f32;
uniform material_alphaDitherScale: f32;

var<private> sseRim: f32;
var<private> sseSparkle: f32;

// three random numbers in [0, 1) for a cell (pcg3d)
fn sseHash(cell: vec3i) -> vec3f {
    var v = vec3u(cell) * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v = v ^ (v >> vec3u(16u));
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return vec3f(v >> vec3u(8u)) * (1.0 / 16777216.0);
}

#if defined(FORWARD_PASS) && defined(LIT_NEEDS_NORMAL)
// The flake of p's cell in a lattice of cells of the given size, px a pixel's size in metres and
// seed the lattice's level: a crisp disc where the skin cuts its ball, so every flake is as bright,
// faint until it faces the eye
fn sseFlake(p: vec3f, size: f32, px: f32, seed: i32) -> f32 {
    let q = p / size;
    let base = floor(q);
    let cell = vec3i(base) + vec3i(seed * 7919, seed * 104729, seed * 1299709);
    let centre = base + 0.25 + 0.5 * sseHash(cell);
    let tilt = sseHash(cell + vec3i(4096)) * 2.0 - 1.0;
    let shown = step(sseHash(cell + vec3i(8192)).x, ${GLITTER_SHARE});
    let w = 0.5 * px / size;
    let flake = 1.0 - smoothstep(${GLITTER_RADIUS} - w, ${GLITTER_RADIUS} + w, distance(q, centre));
    let facing = saturate(dot(normalize(dVertexNormalW + ${GLITTER_TILT} * tilt), dViewDirW));
    return shown * flake * (0.3 + 3.7 * pow(facing, ${GLITTER_SHARPNESS}.0));
}

// the lattice at the level whose cells span GLITTER_CELL_PIXELS, and the next coarser near its step
fn sseGlitter(p: vec3f, px: f32) -> f32 {
    let level = max(0.0, log2(px * ${GLITTER_CELL_PIXELS.toFixed(1)} / ${GLITTER_CELL}));
    let l0 = floor(level);
    let size = ${GLITTER_CELL} * exp2(l0);
    let next = smoothstep(${1 - GLITTER_BLEND}, 1.0, level - l0);
    var sparkle = sseFlake(p, size, px, i32(l0)) * (1.0 - next);
    if (next > 0.0) {
        sparkle += sseFlake(p, size * 2.0, px, i32(l0) + 1) * next;
    }
    return sparkle;
}
#endif

fn getOpacity() {
    sseRim = 0.0;
    sseSparkle = 0.0;
    var alpha = uniform.material_opacity;
    var wrist = 1.0;
    #ifdef FORWARD_PASS
        wrist = 1.0 - smoothstep(${WRIST_FADE_START}, ${WRIST_FADE_END}, vRestPosition.y);
        #ifdef LIT_NEEDS_NORMAL
            let facing = saturate(abs(dot(dVertexNormalW, dViewDirW)));
            sseRim = pow(1.0 - facing, 2.5);
            alpha = alpha * (0.4 + 1.6 * sseRim);
            let p = vRestPosition;
            let px = length(fwidth(p));
            sseSparkle = sseGlitter(p, px) * smoothstep(${GLITTER_GONE}, ${GLITTER_FULL}, facing);
        #endif
    #endif
    dAlpha = saturate((alpha + 0.4 * sseSparkle) * wrist);
}
`;

const emissiveWGSL = /* wgsl */ `
uniform material_emissive: vec3f;
uniform material_emissiveIntensity: f32;

fn getEmission() {
    dEmission = uniform.material_emissive * uniform.material_emissiveIntensity * (0.5 + 1.5 * sseRim + 1.3 * sseSparkle);
}
`;

const opacityGLSL = /* glsl */ `
uniform float material_opacity;
uniform float material_alphaDitherScale;

float sseRim;
float sseSparkle;

vec3 sseHash(ivec3 cell) {
    uvec3 v = uvec3(cell) * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return vec3(v >> 8u) * (1.0 / 16777216.0);
}

#if defined(FORWARD_PASS) && defined(LIT_NEEDS_NORMAL)
float sseFlake(vec3 p, float size, float px, int seed) {
    vec3 q = p / size;
    vec3 base = floor(q);
    ivec3 cell = ivec3(base) + ivec3(seed * 7919, seed * 104729, seed * 1299709);
    vec3 centre = base + 0.25 + 0.5 * sseHash(cell);
    vec3 tilt = sseHash(cell + ivec3(4096)) * 2.0 - 1.0;
    float shown = step(sseHash(cell + ivec3(8192)).x, ${GLITTER_SHARE});
    float w = 0.5 * px / size;
    float flake = 1.0 - smoothstep(${GLITTER_RADIUS} - w, ${GLITTER_RADIUS} + w, distance(q, centre));
    float facing = saturate(dot(normalize(dVertexNormalW + ${GLITTER_TILT} * tilt), dViewDirW));
    return shown * flake * (0.3 + 3.7 * pow(facing, ${GLITTER_SHARPNESS}.0));
}

float sseGlitter(vec3 p, float px) {
    float level = max(0.0, log2(px * ${GLITTER_CELL_PIXELS.toFixed(1)} / ${GLITTER_CELL}));
    float l0 = floor(level);
    float size = ${GLITTER_CELL} * exp2(l0);
    float next = smoothstep(${1 - GLITTER_BLEND}, 1.0, level - l0);
    float sparkle = sseFlake(p, size, px, int(l0)) * (1.0 - next);
    if (next > 0.0) {
        sparkle += sseFlake(p, size * 2.0, px, int(l0) + 1) * next;
    }
    return sparkle;
}
#endif

void getOpacity() {
    sseRim = 0.0;
    sseSparkle = 0.0;
    float alpha = material_opacity;
    float wrist = 1.0;
    #ifdef FORWARD_PASS
        wrist = 1.0 - smoothstep(${WRIST_FADE_START}, ${WRIST_FADE_END}, vRestPosition.y);
        #ifdef LIT_NEEDS_NORMAL
            float facing = saturate(abs(dot(dVertexNormalW, dViewDirW)));
            sseRim = pow(1.0 - facing, 2.5);
            alpha *= 0.4 + 1.6 * sseRim;
            vec3 p = vRestPosition;
            float px = length(fwidth(p));
            sseSparkle = sseGlitter(p, px) * smoothstep(${GLITTER_GONE}, ${GLITTER_FULL}, facing);
        #endif
    #endif
    dAlpha = saturate((alpha + 0.4 * sseSparkle) * wrist);
}
`;

const emissiveGLSL = /* glsl */ `
uniform vec3 material_emissive;
uniform float material_emissiveIntensity;

void getEmission() {
    dEmission = material_emissive * material_emissiveIntensity * (0.5 + 1.5 * sseRim + 1.3 * sseSparkle);
}
`;

/**
 * The material every hand model draws with: faint, unlit in effect, over the splats like the rest
 * of XR's overlays, with a fresnel rim, glitter where the skin faces the eye, and a fade at the
 * wrist. It is lit only so that the forward pass computes the normal and view
 * direction the rim and glitter need; with black diffuse and specular, and no sky, lighting adds
 * nothing. Controllers keep their own models' materials.
 */
class XrHandStyle {
    readonly material = new StandardMaterial();

    constructor() {
        const { material } = this;
        material.useSkybox = false;
        material.useFog = false;
        material.useTonemap = false;
        material.diffuse.set(0, 0, 0);
        material.specular.set(0, 0, 0);
        material.emissive.set(COLOR[0], COLOR[1], COLOR[2]);
        material.opacity = OPACITY;
        material.blendType = BLEND_NORMAL;
        material.depthWrite = false;
        const wgsl = material.getShaderChunks(SHADERLANGUAGE_WGSL);
        wgsl.set('litUserDeclarationVS', declarationVSWGSL);
        wgsl.set('litUserMainEndVS', mainEndVSWGSL);
        wgsl.set('litUserDeclarationPS', declarationVSWGSL);
        wgsl.set('opacityPS', opacityWGSL);
        wgsl.set('emissivePS', emissiveWGSL);
        const glsl = material.getShaderChunks(SHADERLANGUAGE_GLSL);
        glsl.set('litUserDeclarationVS', declarationVSGLSL);
        glsl.set('litUserMainEndVS', mainEndVSGLSL);
        glsl.set('litUserDeclarationPS', declarationVSGLSL);
        glsl.set('opacityPS', opacityGLSL);
        glsl.set('emissivePS', emissiveGLSL);
        material.shaderChunksVersion = '2.23';
        material.update();
    }

    /** Give a hand model this material, drawn after the splats. */
    apply(entity: Entity) {
        for (const render of entity.findComponents('render') as RenderComponent[]) {
            for (const meshInstance of render.meshInstances) {
                meshInstance.material = this.material;
                meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
            }
        }
    }

    destroy() {
        this.material.destroy();
    }
}

export { XrHandStyle };
