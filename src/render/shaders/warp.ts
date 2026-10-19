// The foveated target (variant warp): the splats render into a target whose pixels are spread
// over the screen unevenly, densest where the screen is, and every pass that maps between the
// screen and the target goes through one table. In a WebGPU XR session on Apple Vision Pro the
// table is the eye's own rasterization rate map, measured when the session starts (xr-rate-map.ts):
// visionOS draws a 4493 x 3604 logical eye into a 1856 x 1792 texture, one texel per logical pixel
// over a plateau toward the nose and as few as one per 14 at the edges, so a target with that
// layout puts its pixels where the display has them and the compose reads one texel per
// fragment. Variant warp:<m> builds the table from the SuperSplat editor's foveation experiment
// instead, q = m p / sqrt(1 + (m^2 - 1) p^2) per axis, for trying the warp on a flat screen.
//
// The warp is separable: per axis, the target's ndc is a monotonic function of the screen's
// (logical) ndc. The table holds, after the target's width and height, the forward map per axis
// at WARP_STEPS logical ndc evenly over [-1, 1], then the logical ndc at the centre of every
// target column, left to right, and of every row, top to bottom.

/** Forward samples per axis. Linear between them, which is exact where the map is piecewise
 * linear (a rate map's 32-texel zones) within a fifth of a texel. */
const WARP_STEPS = 1024;

/** A separable warp: the logical ndc at the centre of each target column, and of each row from the top. */
type WarpMap = {
    width: number;
    height: number;
    columns: Float32Array;
    rows: Float32Array;
};

// the editor's warp, inverted: the logical ndc a target ndc came from
const analyticWarpMap = (m: number, width: number, height: number): WarpMap => {
    const unwarp = (q: number) => q / Math.sqrt(Math.max(m * m - (m * m - 1) * q * q, 1e-6));
    const columns = new Float32Array(width);
    const rows = new Float32Array(height);
    for (let i = 0; i < width; i++) columns[i] = unwarp((2 * (i + 0.5)) / width - 1);
    for (let j = 0; j < height; j++) rows[j] = unwarp(1 - (2 * (j + 0.5)) / height);
    return { width, height, columns, rows };
};

// The continuous coordinate (texel centres at i + 0.5) at which an increasing sequence reaches a
// value: linear between centres, and beyond the ends along the end segments
const coordinateOf = (values: ArrayLike<number>, value: number, sign: number) => {
    let lo = 0;
    let hi = values.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (sign * values[mid] <= value) lo = mid;
        else hi = mid;
    }
    const a = sign * values[lo];
    const b = sign * values[hi];
    return lo + 0.5 + (b > a ? (value - a) / (b - a) : 0);
};

/** The table the shaders read (see above). */
const buildWarpTable = (map: WarpMap) => {
    const { width, height, columns, rows } = map;
    const table = new Float32Array(2 + 2 * WARP_STEPS + width + height);
    table[0] = width;
    table[1] = height;
    for (let k = 0; k < WARP_STEPS; k++) {
        const logical = -1 + (2 * k) / (WARP_STEPS - 1);
        table[2 + k] = (2 * coordinateOf(columns, logical, 1)) / width - 1;
        // rows run top down, where the ndc falls
        table[2 + WARP_STEPS + k] = 1 - (2 * coordinateOf(rows, -logical, -1)) / height;
    }
    table.set(columns, 2 + 2 * WARP_STEPS);
    table.set(rows, 2 + 2 * WARP_STEPS + width);
    return table;
};

// The lookups. Each shader declares the table itself, as `warpTable: array<f32>`
const warpWGSL = /* wgsl */ `
fn warpStep(p: f32) -> vec2f {
    let t = (p * 0.5 + 0.5) * ${WARP_STEPS - 1}.0;
    let i = clamp(floor(t), 0.0, ${WARP_STEPS - 2}.0);
    return vec2f(i, t - i);
}

// one axis of the forward map at a logical ndc; linear beyond the edges
fn warpAxis(p: f32, base: u32) -> f32 {
    let s = warpStep(p);
    let i = base + u32(s.x);
    let a = warpTable[i];
    return a + (warpTable[i + 1u] - a) * s.y;
}

// the target's ndc of a logical ndc
fn warpNdc(p: vec2f) -> vec2f {
    return vec2f(warpAxis(p.x, 2u), warpAxis(p.y, ${2 + WARP_STEPS}u));
}

// the forward map's slope at a logical ndc: the target's pixels per screen pixel
fn warpSlope(p: vec2f) -> vec2f {
    let sx = 2u + u32(warpStep(p.x).x);
    let sy = ${2 + WARP_STEPS}u + u32(warpStep(p.y).x);
    let scale = ${(WARP_STEPS - 1) / 2};
    return vec2f(warpTable[sx + 1u] - warpTable[sx], warpTable[sy + 1u] - warpTable[sy]) * scale;
}

// the logical ndc at the centre of a target texel, its row counted from the top
fn unwarpTexel(texel: vec2i) -> vec2f {
    let base = ${2 + 2 * WARP_STEPS}u;
    return vec2f(warpTable[base + u32(texel.x)], warpTable[base + u32(warpTable[0]) + u32(texel.y)]);
}
`;

export { analyticWarpMap, buildWarpTable, warpWGSL, WARP_STEPS };
export type { WarpMap };
