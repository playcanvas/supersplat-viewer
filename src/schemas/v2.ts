type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
            fov: number[],
        }
    }
};

type Constraint = {
    min: number,
    max: number
};

type PositionConstraints = {
    x: Constraint,
    y: Constraint,
    z: Constraint
};

type OrbitConstraints = {
    distance: Constraint,
    azimuth: Constraint,
    elevation: Constraint
};

type CameraPose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type Camera = {
    initialPose: CameraPose,
    positionConstraints?: PositionConstraints,
    orbitConstraints?: OrbitConstraints
};

type Annotation = {
    position: [number, number, number],
    title: string,
    text: string,
    extras: any,
    camera: Camera;
};

type PostEffectSettings = {
    bloom?: {
        intensity: number,
        blurLevel: number,
    },
    grading?: {
        brightness: number,
        contrast: number,
        saturation: number,
        tint: [number, number, number],
    },
    vignette?: {
        intensity: number,
        inner: number,
        outer: number,
        curvature: number,
    },
    fringing?: {
        intensity: number
    }
};

type ExperienceSettings = {
    version: 2,
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral',
    highPrecisionRendering: boolean,
    background: {
        color: [number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,
    audioUrl?: string,

    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],

    cameraStartMode: 'default' | 'animTrack' | 'annotation'
};

export type { AnimTrack, Camera, Annotation, PostEffectSettings, ExperienceSettings };
