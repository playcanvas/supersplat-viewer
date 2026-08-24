import { defaultPostEffectSettings } from './schemas/defaults';
import type { ExperienceSettings as V1, AnimTrack as AnimTrackV1 } from './schemas/v1';
import { validateV1 } from './schemas/v1';
import type { ExperienceSettings as V2, AnimTrack as AnimTrackV2 } from './schemas/v2';
import { validateV2 } from './schemas/v2';
import { validateLimitsV2 } from './schemas/validate-limits';
import { assertObject } from './schemas/validate-utils';

const migrateV1 = (input: V1): V1 => {
    // Copy first: callers own the object they pass in, and an API consumer holding a
    // reference should not see it rewritten underneath them.
    const settings: V1 = structuredClone(input);

    if (settings.animTracks) {
        settings.animTracks?.forEach((track: AnimTrackV1) => {
            // some early settings did not have frameRate set on anim tracks
            if (!track.frameRate) {
                const defaultFrameRate = 30;

                track.frameRate = defaultFrameRate;
                const times = track.keyframes.times;
                for (let i = 0; i < times.length; i++) {
                    times[i] *= defaultFrameRate;
                }
            }

            // smoothness property added in v1.4.0
            // eslint-disable-next-line no-prototype-builtins -- preserve property lookup semantics
            if (!track.hasOwnProperty('smoothness')) {
                track.smoothness = 0;
            }
        });
    } else {
        // some scenes were published without animTracks
        settings.animTracks = [];
    }

    return settings;
};

const migrateAnimTrackV2 = (animTrackV1: AnimTrackV1, fov: number): AnimTrackV2 => {
    return {
        name: animTrackV1.name,
        duration: animTrackV1.duration,
        frameRate: animTrackV1.frameRate,
        loopMode: animTrackV1.loopMode,
        interpolation: animTrackV1.interpolation,
        smoothness: animTrackV1.smoothness,
        keyframes: {
            times: animTrackV1.keyframes.times,
            values: {
                position: animTrackV1.keyframes.values.position,
                target: animTrackV1.keyframes.values.target,
                fov: new Array(animTrackV1.keyframes.times.length).fill(fov)
            }
        }
    };
};

const migrateV2 = (v1: V1): V2 => {
    return {
        version: 2,
        // Not the shared default ('linear'): tonemapping applies unconditionally, so changing
        // it here would alter how existing v1 content renders.
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: (v1.background.color as [number, number, number]) || [0, 0, 0]
        },
        // Shared defaults rather than a private copy, so a migrated document lands inside the
        // authoring bounds and `validateSettings(v1, { limits: true })` reports the caller's
        // data instead of values invented here. Every effect is `enabled: false`, so which
        // numbers they carry is inert.
        postEffectSettings: defaultPostEffectSettings(),
        animTracks: v1.animTracks.map((animTrackV1: AnimTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || 60);
        }),
        cameras:
            v1.camera.position && v1.camera.target
                ? [
                      {
                          initial: {
                              position: v1.camera.position as [number, number, number],
                              target: v1.camera.target as [number, number, number],
                              fov: v1.camera.fov || 75
                          }
                      }
                  ]
                : [],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default'
    };
};

/**
 * Migrate settings of any supported version to the latest schema.
 *
 * Assumes valid input — call {@link validateSettings} first if the source is untrusted. Does
 * not mutate the object passed in.
 *
 * @param settings - Parsed contents of a settings file.
 * @returns The settings at the latest version.
 * @throws If the version is not supported.
 */
const importSettings = (settings: unknown): V2 => {
    let result: V2;

    const version = (settings as { version?: unknown }).version;
    if (version === undefined) {
        // v1 -> v2
        result = migrateV2(migrateV1(settings as V1));
    } else if (version === 2) {
        // already v2
        result = settings as V2;
    } else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }

    return result;
};

/** Options for {@link validateSettings}. */
type ValidateOptions = {
    /**
     * Also check the exported authoring bounds. Off by default: those bounds are stricter
     * than what the viewer will render, and some settings in the wild fail them. Producers
     * writing new settings should turn this on.
     */
    limits?: boolean;
};

/**
 * Validate unknown data against any supported settings schema version.
 *
 * @param settings - Data to validate.
 * @param options - See {@link ValidateOptions}.
 * @throws If the data is not valid settings, with a message naming the offending field.
 */
const validateSettings = (settings: unknown, options: ValidateOptions = {}): void => {
    const obj = assertObject(settings, 'settings');
    const version = obj.version;

    if (version === undefined) {
        validateV1(settings);
        if (options.limits) {
            // v1 has no direct limit checks; validate what it migrates to
            validateLimitsV2(migrateV2(migrateV1(settings as V1)));
        }
    } else if (version === 2) {
        validateV2(settings);
        if (options.limits) {
            validateLimitsV2(settings as V2);
        }
    } else if (typeof version !== 'number') {
        throw new Error(`settings.version must be a number, got ${typeof version}`);
    } else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }
};

export type { AnimTrack, Camera, Annotation, CameraPose, PostEffectSettings, ExperienceSettings } from './schemas/v2';
export type { AnimTrackLimits, AnnotationLimits, Bounds, NumericRange, PostEffectRanges } from './schemas/ranges';
export type { CameraFit } from './schemas/defaults';
export type { ValidateOptions };

export {
    ANIM_TRACK_LIMITS,
    ANNOTATION_LIMITS,
    CAMERA_FOV_RANGE,
    POST_EFFECT_RANGES,
    isCameraFovInRange
} from './schemas/ranges';
export {
    DEFAULT_BACKGROUND_COLOR,
    DEFAULT_CAMERA_FOV,
    DEFAULT_TONEMAPPING,
    defaultPostEffectSettings,
    defaultSettings
} from './schemas/defaults';

export { importSettings, validateSettings };
