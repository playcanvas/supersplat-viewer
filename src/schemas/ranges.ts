// Authoring bounds for experience settings, shared by the viewer, the web experience editor's
// slider components and the settings validators. Pure data with no imports, so any consumer
// can take these without pulling in the schema.
//
// These are *authoring* limits, not read limits: the viewer renders values outside them
// perfectly well, and historical published settings contain some (see validate-limits.ts).
// `step` is UI granularity, not a constraint.

type NumericRange = {
    readonly min: number;
    readonly max: number;
    readonly step: number;
};

// These are published constants that the validators themselves read, so a consumer mutating
// one would silently change validation for everyone in the realm. Freeze rather than rely on
// `as const`, which is erased at runtime.
const deepFreeze = <T>(value: T): T => {
    if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
};

// Sources (PlayCanvas engine v2.15.1):
// - CameraFrame JSDoc ranges: src/extras/render-passes/camera-frame.js
// - Bloom blurLevel bounds: src/extras/render-passes/render-pass-bloom.js
//   (clamps passes to [1, blurLevel], default 16).
type PostEffectRanges = {
    sharpness: NumericRange;
    bloom: {
        intensity: NumericRange;
        blurLevel: NumericRange;
    };
    grading: {
        brightness: NumericRange;
        contrast: NumericRange;
        saturation: NumericRange;
    };
    vignette: {
        intensity: NumericRange;
        inner: NumericRange;
        outer: NumericRange;
        curvature: NumericRange;
    };
    fringing: {
        intensity: NumericRange;
    };
};

const CAMERA_FOV_RANGE: NumericRange = deepFreeze({
    min: 10,
    max: 120,
    step: 1
});

const POST_EFFECT_RANGES: PostEffectRanges = deepFreeze({
    sharpness: { min: 0, max: 1, step: 0.01 },
    bloom: {
        intensity: { min: 0, max: 0.1, step: 0.01 },
        blurLevel: { min: 1, max: 16, step: 1 }
    },
    grading: {
        brightness: { min: 0, max: 3, step: 0.01 },
        contrast: { min: 0.5, max: 1.5, step: 0.01 },
        saturation: { min: 0, max: 2, step: 0.01 }
    },
    vignette: {
        intensity: { min: 0, max: 1, step: 0.01 },
        inner: { min: 0, max: 3, step: 0.01 },
        outer: { min: 0, max: 3, step: 0.01 },
        curvature: { min: 0.01, max: 10, step: 0.01 }
    },
    fringing: {
        intensity: { min: 0, max: 100, step: 1 }
    }
});

// Intentionally tight; can be relaxed later.
const ANIM_TRACK_LIMITS = deepFreeze({
    duration: { min: 0.1, max: 600 },
    frameRate: { min: 1, max: 120 },
    smoothness: { min: 0, max: 1 },
    maxKeyframes: 1000,
    nameMax: 120,
    maxTracks: 10
} as const);

// Intentionally tight; can be relaxed later.
const ANNOTATION_LIMITS = deepFreeze({
    maxCount: 25,
    titleMax: 60,
    textMax: 280
} as const);

const isCameraFovInRange = (fov: number) => {
    return fov >= CAMERA_FOV_RANGE.min && fov <= CAMERA_FOV_RANGE.max;
};

export type { NumericRange, PostEffectRanges };
export { CAMERA_FOV_RANGE, POST_EFFECT_RANGES, ANIM_TRACK_LIMITS, ANNOTATION_LIMITS, isCameraFovInRange };
