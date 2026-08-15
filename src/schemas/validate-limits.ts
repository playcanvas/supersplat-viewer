import { ANIM_TRACK_LIMITS, ANNOTATION_LIMITS, CAMERA_FOV_RANGE, POST_EFFECT_RANGES } from './ranges';
import type { NumericRange } from './ranges';
import type { ExperienceSettings } from './v2';

// Authoring-limit checks, deliberately separate from the shape validation in v2.ts.
//
// Shape validation answers "can the viewer read this" and must keep accepting every settings
// file ever published. These limits answer "is this sane input from an editor" and are
// stricter — strictly enough that some historical data fails them. `bloom.intensity` is the
// known case: the range caps it at 0.1, while the editor's own default, splat-transform's
// default and the viewer's v1 migration all wrote 1. So this runs only on request, via
// `validateSettings(x, { limits: true })`, and never on the viewer's read path.

type Bounds = Pick<NumericRange, 'min' | 'max'>;

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
        maxCount(track.keyframes.times, ANIM_TRACK_LIMITS.maxKeyframes, `${path}.keyframes.times`);
        // Deliberately no CAMERA_FOV_RANGE check on keyframes.values.fov, even though those
        // values are splined straight onto the camera. The upstream zod schema this replaces
        // types them as a bare number array, so adding a bound here would make this validator
        // stricter than the one it consolidates and could reject already-published animations.
        // Tighten in both places together, or not at all.
        track.keyframes.times.forEach((time, k) => {
            if (time < 0) {
                throw new Error(`${path}.keyframes.times[${k}] must be non-negative, got ${time}`);
            }
        });
    });

    maxCount(settings.annotations, ANNOTATION_LIMITS.maxCount, 'settings.annotations');
    settings.annotations.forEach((annotation, i) => {
        const path = `settings.annotations[${i}]`;
        maxLength(annotation.title, ANNOTATION_LIMITS.titleMax, `${path}.title`);
        maxLength(annotation.text, ANNOTATION_LIMITS.textMax, `${path}.text`);
        range(annotation.camera.initial.fov, CAMERA_FOV_RANGE, `${path}.camera.initial.fov`);
    });
};

export { validateLimitsV2 };
