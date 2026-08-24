import type { CameraPose, ExperienceSettings, PostEffectSettings } from './v2';

// The single source of default experience settings, so every tool that writes a settings file
// agrees. Several independent copies of these values had drifted apart; these are the ones
// matching the settings already published in the wild, which means some producers change:
// `tonemapping` is 'linear' rather than 'none', `background.color` is black rather than 0.4
// grey, `bloom.intensity` is 0.1 rather than 1 (1 falls outside the authoring range in
// ranges.ts) and `grading.brightness` is 1 rather than 0.

// Frozen: `defaultSettings()` copies this, so a consumer mutating it would otherwise change
// every later call's result.
/** Default page and scene background, as normalized 0..1 rgb components. */
const DEFAULT_BACKGROUND_COLOR: readonly [number, number, number] = Object.freeze([0, 0, 0]);
/** Default tonemapping curve. */
const DEFAULT_TONEMAPPING: ExperienceSettings['tonemapping'] = 'linear';
/** Default vertical field of view, in degrees. */
// Annotated so the published declaration widens to `number`; without it the emitted type is
// the literal `75`, which bakes the value into the api.
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
const DEFAULT_CAMERA_FOV: number = 85;

/**
 * How the default camera is placed: `environment` frames a captured space from inside it,
 * `object` frames a subject from outside.
 */
type CameraFit = 'environment' | 'object';

const defaultCameraPose = (fit: CameraFit = 'environment'): CameraPose => {
    return fit === 'environment'
        ? { position: [0, 2, 0], target: [2, 2, 0], fov: DEFAULT_CAMERA_FOV }
        : { position: [2, 2, -2], target: [0, 0, 0], fov: DEFAULT_CAMERA_FOV };
};

/**
 * Default post-processing settings, with every effect disabled.
 *
 * @returns A fresh object; callers may mutate it freely.
 */
const defaultPostEffectSettings = (): PostEffectSettings => ({
    sharpness: {
        enabled: false,
        amount: 0
    },
    bloom: {
        enabled: false,
        intensity: 0.1,
        blurLevel: 2
    },
    grading: {
        enabled: false,
        brightness: 1,
        contrast: 1,
        saturation: 1,
        tint: [1, 1, 1]
    },
    vignette: {
        enabled: false,
        intensity: 0.5,
        inner: 0.3,
        outer: 0.75,
        curvature: 1
    },
    fringing: {
        enabled: false,
        intensity: 0.5
    }
});

/**
 * Default experience settings, shared by every tool that writes a settings file.
 *
 * @param fit - How to place the default camera. Defaults to `environment`.
 * @returns A fresh object; callers may mutate it freely.
 */
const defaultSettings = (fit: CameraFit = 'environment'): ExperienceSettings => ({
    version: 2,
    tonemapping: DEFAULT_TONEMAPPING,
    highPrecisionRendering: false,
    background: {
        color: [...DEFAULT_BACKGROUND_COLOR]
    },
    postEffectSettings: defaultPostEffectSettings(),
    animTracks: [],
    cameras: [{ initial: defaultCameraPose(fit) }],
    annotations: [],
    startMode: 'default'
});

export type { CameraFit };
export {
    DEFAULT_BACKGROUND_COLOR,
    DEFAULT_TONEMAPPING,
    DEFAULT_CAMERA_FOV,
    defaultPostEffectSettings,
    defaultSettings
};
