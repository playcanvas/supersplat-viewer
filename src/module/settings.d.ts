export type AnimTrack = {
    name: string;
    duration: number;
    frameRate: number;
    loopMode: 'none' | 'repeat' | 'pingpong';
    interpolation: 'step' | 'spline';
    smoothness: number;
    keyframes: {
        times: number[];
        values: {
            position: number[];
            target: number[];
            fov: number[];
        };
    };
};

export type CameraPose = {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
};

export type Camera = {
    initial: CameraPose;
};

export type Annotation = {
    position: [number, number, number];
    title: string;
    text: string;
    extras?: unknown;
    camera: Camera;
};

export type PostEffectSettings = {
    sharpness: {
        enabled: boolean;
        amount: number;
    };
    bloom: {
        enabled: boolean;
        intensity: number;
        blurLevel: number;
    };
    grading: {
        enabled: boolean;
        brightness: number;
        contrast: number;
        saturation: number;
        tint: [number, number, number];
    };
    vignette: {
        enabled: boolean;
        intensity: number;
        inner: number;
        outer: number;
        curvature: number;
    };
    fringing: {
        enabled: boolean;
        intensity: number;
    };
};

export type ExperienceSettings = {
    version: 2;
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral';
    highPrecisionRendering: boolean;
    soundUrl?: string;
    background: {
        color: [number, number, number];
        skyboxUrl?: string;
    };
    postEffectSettings: PostEffectSettings;
    animTracks: AnimTrack[];
    cameras: Camera[];
    annotations: Annotation[];
    startMode: 'default' | 'animTrack' | 'annotation';
};

export type CameraFit = 'environment' | 'object';

export type NumericRange = {
    readonly min: number;
    readonly max: number;
    readonly step: number;
};

export type PostEffectRanges = {
    sharpness: NumericRange;
    bloom: { intensity: NumericRange; blurLevel: NumericRange };
    grading: { brightness: NumericRange; contrast: NumericRange; saturation: NumericRange };
    vignette: { intensity: NumericRange; inner: NumericRange; outer: NumericRange; curvature: NumericRange };
    fringing: { intensity: NumericRange };
};

export type ValidateOptions = {
    /**
     * Also check the authoring bounds in the exported ranges. Off by default: those bounds
     * are stricter than what the viewer can render, and some settings in the wild fail
     * them. Producers writing new settings should turn this on.
     */
    limits?: boolean;
};

/**
 * Authoring bounds, shared by the settings validators and by editor UIs that need slider
 * ranges. Frozen at runtime, so writing to them throws in strict mode.
 */
export const CAMERA_FOV_RANGE: NumericRange;
export const POST_EFFECT_RANGES: PostEffectRanges;
export const ANIM_TRACK_LIMITS: {
    readonly duration: { readonly min: number; readonly max: number };
    readonly frameRate: { readonly min: number; readonly max: number };
    readonly smoothness: { readonly min: number; readonly max: number };
    readonly maxKeyframes: number;
    readonly nameMax: number;
    readonly maxTracks: number;
};
export const ANNOTATION_LIMITS: {
    readonly maxCount: number;
    readonly titleMax: number;
    readonly textMax: number;
};
export function isCameraFovInRange(fov: number): boolean;

export const DEFAULT_BACKGROUND_COLOR: readonly [number, number, number];
export const DEFAULT_TONEMAPPING: ExperienceSettings['tonemapping'];
export const DEFAULT_CAMERA_FOV: number;

/** The single source of default experience settings for every producer. */
export function defaultSettings(fit?: CameraFit): ExperienceSettings;
export function defaultPostEffectSettings(): PostEffectSettings;
export function defaultCameraPose(fit?: CameraFit): CameraPose;

/** Migrate any supported version to the latest. Does not mutate its argument. */
export function importSettings(settings: unknown): ExperienceSettings;
export function validateSettings(settings: unknown, options?: ValidateOptions): void;
