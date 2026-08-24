import { ANIM_TRACK_LIMITS, ANNOTATION_LIMITS, CAMERA_FOV_RANGE, POST_EFFECT_RANGES } from './ranges';
import type { Bounds } from './ranges';
import type { ExperienceSettings as ExperienceSettingsV1 } from './v1';
import type { ExperienceSettings } from './v2';

// Authoring-limit checks, deliberately separate from the shape validation in v2.ts.
//
// Shape validation answers "can the viewer read this" and must keep accepting every settings
// file ever written. These limits answer "is this sane input from an editor" and are stricter
// — strictly enough that some existing data fails them. `bloom.intensity` is the known case:
// the range caps it at 0.1, while several older default objects wrote 1. So this runs only on
// request, via `validateSettings(x, { limits: true })`, and never on the viewer's read path.

const range = (value: number, bounds: Bounds, path: string) => {
    if (value < bounds.min || value > bounds.max) {
        throw new Error(`${path} must be between ${bounds.min} and ${bounds.max}, got ${value}`);
    }
};

const maxLength = (value: string, max: number, path: string) => {
    if (value.length > max) {
        throw new Error(`${path} must be at most ${max} characters, got ${value.length}`);
    }
};

const maxCount = (value: readonly unknown[], max: number, path: string) => {
    if (value.length > max) {
        throw new Error(`${path} must have at most ${max} entries, got ${value.length}`);
    }
};

const validateLimitsV2 = (settings: ExperienceSettings) => {
    const fx = settings.postEffectSettings;
    range(fx.sharpness.amount, POST_EFFECT_RANGES.sharpness, 'settings.postEffectSettings.sharpness.amount');
    range(fx.bloom.intensity, POST_EFFECT_RANGES.bloom.intensity, 'settings.postEffectSettings.bloom.intensity');
    range(fx.bloom.blurLevel, POST_EFFECT_RANGES.bloom.blurLevel, 'settings.postEffectSettings.bloom.blurLevel');
    range(
        fx.grading.brightness,
        POST_EFFECT_RANGES.grading.brightness,
        'settings.postEffectSettings.grading.brightness'
    );
    range(fx.grading.contrast, POST_EFFECT_RANGES.grading.contrast, 'settings.postEffectSettings.grading.contrast');
    range(
        fx.grading.saturation,
        POST_EFFECT_RANGES.grading.saturation,
        'settings.postEffectSettings.grading.saturation'
    );
    range(
        fx.vignette.intensity,
        POST_EFFECT_RANGES.vignette.intensity,
        'settings.postEffectSettings.vignette.intensity'
    );
    range(fx.vignette.inner, POST_EFFECT_RANGES.vignette.inner, 'settings.postEffectSettings.vignette.inner');
    range(fx.vignette.outer, POST_EFFECT_RANGES.vignette.outer, 'settings.postEffectSettings.vignette.outer');
    range(
        fx.vignette.curvature,
        POST_EFFECT_RANGES.vignette.curvature,
        'settings.postEffectSettings.vignette.curvature'
    );
    range(
        fx.fringing.intensity,
        POST_EFFECT_RANGES.fringing.intensity,
        'settings.postEffectSettings.fringing.intensity'
    );

    // no count limit on cameras — the viewer only reads cameras[0], but the format allows more
    settings.cameras.forEach((camera, i) => {
        range(camera.initial.fov, CAMERA_FOV_RANGE, `settings.cameras[${i}].initial.fov`);
    });

    maxCount(settings.animTracks, ANIM_TRACK_LIMITS.maxTracks, 'settings.animTracks');
    settings.animTracks.forEach((track, i) => {
        const path = `settings.animTracks[${i}]`;
        maxLength(track.name, ANIM_TRACK_LIMITS.nameMax, `${path}.name`);
        range(track.duration, ANIM_TRACK_LIMITS.duration, `${path}.duration`);
        range(track.frameRate, ANIM_TRACK_LIMITS.frameRate, `${path}.frameRate`);
        if (!Number.isInteger(track.frameRate)) {
            throw new Error(`${path}.frameRate must be an integer, got ${track.frameRate}`);
        }
        range(track.smoothness, ANIM_TRACK_LIMITS.smoothness, `${path}.smoothness`);
        // Keyframe times are frame numbers: non-negative integers, strictly ascending, since
        // the spline is built from them in order.
        const { times, values } = track.keyframes;
        maxCount(times, ANIM_TRACK_LIMITS.maxKeyframes, `${path}.keyframes.times`);
        // At least one: `CubicSpline.calcKnots` derives its dimension as
        // `points.length / times.length`, so an empty track computes 0/0 and allocates
        // `new Array(NaN)`, which throws. A track the viewer cannot load is not valid input.
        if (times.length === 0) {
            throw new Error(`${path}.keyframes.times must have at least one keyframe`);
        }
        times.forEach((time, k) => {
            const at = `${path}.keyframes.times[${k}]`;
            if (time < 0) {
                throw new Error(`${at} must be non-negative, got ${time}`);
            }
            if (!Number.isInteger(time)) {
                throw new Error(`${at} must be an integer, got ${time}`);
            }
            if (k > 0 && time <= times[k - 1]) {
                throw new Error(`${at} must be greater than the previous frame, got ${time}`);
            }
        });

        // The track is flattened into one spline, so a mis-sized array silently stops the
        // animation rather than failing loudly at runtime.
        const vectorValues = times.length * 3;
        if (values.position.length !== vectorValues) {
            throw new Error(
                `${path}.keyframes.values.position must have 3 values per keyframe (${vectorValues}), got ${values.position.length}`
            );
        }
        if (values.target.length !== vectorValues) {
            throw new Error(
                `${path}.keyframes.values.target must have 3 values per keyframe (${vectorValues}), got ${values.target.length}`
            );
        }
        if (values.fov.length !== times.length) {
            throw new Error(
                `${path}.keyframes.values.fov must have 1 value per keyframe (${times.length}), got ${values.fov.length}`
            );
        }

        // No CAMERA_FOV_RANGE check on keyframes.values.fov: the validator this reaches parity
        // with does not bound those either, and they are splined rather than set directly.
    });

    maxCount(settings.annotations, ANNOTATION_LIMITS.maxCount, 'settings.annotations');
    settings.annotations.forEach((annotation, i) => {
        const path = `settings.annotations[${i}]`;
        maxLength(annotation.title, ANNOTATION_LIMITS.titleMax, `${path}.title`);
        maxLength(annotation.text, ANNOTATION_LIMITS.textMax, `${path}.text`);
        range(annotation.camera.initial.fov, CAMERA_FOV_RANGE, `${path}.camera.initial.fov`);
    });
};

// The v1 -> v2 migration substitutes defaults for falsy values — `frameRate: 0` becomes 30,
// `camera.fov: 0` becomes 75 — so a post-migration check cannot see them and an explicitly
// invalid zero would pass. Check those fields as the caller supplied them.
//
// Only the coerced fields are checked here; everything else survives migration unchanged and
// is covered by validateLimitsV2.
const validateLimitsV1 = (settings: ExperienceSettingsV1) => {
    if (settings.camera.fov !== undefined) {
        range(settings.camera.fov, CAMERA_FOV_RANGE, 'settings.camera.fov');
    }

    settings.animTracks?.forEach((track, i) => {
        if (track.frameRate === undefined) {
            return;
        }
        const path = `settings.animTracks[${i}].frameRate`;
        range(track.frameRate, ANIM_TRACK_LIMITS.frameRate, path);
        if (!Number.isInteger(track.frameRate)) {
            throw new Error(`${path} must be an integer, got ${track.frameRate}`);
        }
    });
};

export { validateLimitsV1, validateLimitsV2 };
