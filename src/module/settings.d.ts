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
    extras?: any;
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

export function importSettings(settings: any): ExperienceSettings;
export function validateSettings(settings: unknown): void;
