import type { CameraPose, ExperienceSettings, PostEffectSettings } from './v2';

// The single source of default experience settings, so every tool that writes a settings file
// agrees. Several independent copies of these values had drifted apart; these are the ones
// matching the settings already published in the wild, which means some producers change:
// `tonemapping` is 'linear' rather than 'none', `background.color` is black rather than 0.4
// grey, `bloom.intensity` is 0.1 rather than 1 (1 falls outside the authoring range in
// ranges.ts) and `grading.brightness` is 1 rather than 0.

// Frozen: `defaultSettings()` copies this, so a consumer mutating it would otherwise change
// every later call's result.
const DEFAULT_BACKGROUND_COLOR: readonly [number, number, number] = Object.freeze([0, 0, 0]);
const DEFAULT_TONEMAPPING: ExperienceSettings['tonemapping'] = 'linear';
const DEFAULT_CAMERA_FOV = 75;

// 'environment' frames a captured space from inside it; 'object' frames a subject from outside.
type CameraFit = 'environment' | 'object';

const defaultCameraPose = (fit: CameraFit = 'environment'): CameraPose => {
    return fit === 'environment'
        ? { position: [0, 2, 0], target: [2, 2, 0], fov: DEFAULT_CAMERA_FOV }
        : { position: [2, 2, -2], target: [0, 0, 0], fov: DEFAULT_CAMERA_FOV };
};

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
    defaultCameraPose,
    defaultPostEffectSettings,
    defaultSettings
};
