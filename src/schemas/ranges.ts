// Authoring bounds for experience settings, shared by the settings validators and by editor
// UIs that need slider ranges. Pure data with no imports, so a consumer can take these
// without pulling in the schema.
//
// These are *authoring* limits, not read limits: the viewer renders values outside them
// perfectly well, and settings in the wild contain some (see validate-limits.ts).
// `step` is UI granularity, not a constraint.

/** An inclusive numeric bound. `step` is UI granularity, not a constraint. */
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

/**
 * Bounds for each post-processing parameter, taken from the PlayCanvas engine's documented
 * ranges (`CameraFrame`, and `RenderPassBloom` for `blurLevel`).
 */
type PostEffectRanges = {
    readonly sharpness: {
        readonly amount: NumericRange;
    };
    readonly bloom: {
        readonly intensity: NumericRange;
        readonly blurLevel: NumericRange;
    };
    readonly grading: {
        readonly brightness: NumericRange;
        readonly contrast: NumericRange;
        readonly saturation: NumericRange;
    };
    readonly vignette: {
        readonly intensity: NumericRange;
        readonly inner: NumericRange;
        readonly outer: NumericRange;
        readonly curvature: NumericRange;
    };
    readonly fringing: {
        readonly intensity: NumericRange;
    };
};

/** Bounds for a camera's vertical field of view, in degrees. */
const CAMERA_FOV_RANGE: NumericRange = deepFreeze({
    min: 10,
    max: 120,
    step: 1
});

/** Bounds for each post-processing parameter. */
const POST_EFFECT_RANGES: PostEffectRanges = deepFreeze({
    sharpness: {
        amount: { min: 0, max: 1, step: 0.01 }
    },
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

/** An inclusive bound with no UI step. */
type Bounds = {
    readonly min: number;
    readonly max: number;
};

/** Bounds and size limits for camera animation tracks. */
type AnimTrackLimits = {
    readonly duration: Bounds;
    readonly frameRate: Bounds;
    readonly smoothness: Bounds;
    readonly maxKeyframes: number;
    readonly nameMax: number;
    readonly maxTracks: number;
};

/** Size limits for annotations. */
type AnnotationLimits = {
    readonly maxCount: number;
    readonly titleMax: number;
    readonly textMax: number;
};

// Annotated rather than `as const`: the annotation keeps them readonly while widening the
// values, so the published types do not bake in numbers we may want to relax later.

/** Bounds and size limits for camera animation tracks. Intentionally tight for now. */
const ANIM_TRACK_LIMITS: AnimTrackLimits = deepFreeze({
    duration: { min: 0.1, max: 600 },
    frameRate: { min: 1, max: 120 },
    smoothness: { min: 0, max: 1 },
    maxKeyframes: 1000,
    nameMax: 120,
    maxTracks: 10
});

/** Size limits for annotations. Intentionally tight for now. */
const ANNOTATION_LIMITS: AnnotationLimits = deepFreeze({
    maxCount: 25,
    titleMax: 60,
    textMax: 280
});

/**
 * Test a field of view against {@link CAMERA_FOV_RANGE}.
 *
 * @param fov - Vertical field of view in degrees.
 * @returns Whether the value is within the authoring bounds.
 */
const isCameraFovInRange = (fov: number) => {
    return fov >= CAMERA_FOV_RANGE.min && fov <= CAMERA_FOV_RANGE.max;
};

export type { AnimTrackLimits, AnnotationLimits, Bounds, NumericRange, PostEffectRanges };
export { CAMERA_FOV_RANGE, POST_EFFECT_RANGES, ANIM_TRACK_LIMITS, ANNOTATION_LIMITS, isCameraFovInRange };
