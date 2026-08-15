import type { CameraPose, ExperienceSettings, PostEffectSettings } from './v2';

// The single source of default experience settings, replacing four objects that disagreed:
// this package's v1 migration, the monorepo's sse/schemas/defaults.ts, the editor's
// defaultPostEffectSettings and splat-transform's defaultSettings literal.
//
// Values follow the monorepo's, because those are what published experiences already carry.
// Two consequences for the other producers: `tonemapping` becomes 'linear' rather than 'none',
// `background.color` becomes black rather than 0.4 grey, `bloom.intensity` becomes 0.1 rather
// than 1 (1 is outside the authoring range in ranges.ts) and `grading.brightness` becomes 1
// rather than 0.

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
