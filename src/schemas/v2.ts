import { AnimTrack as AnimTrackV1, ExperienceSettings as V1 } from './v1';

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
    target: [number, number, number]
};

type Camera = {
    fov: number,
    initialPose: CameraPose,
    positionConstraints?: PositionConstraints,
    orbitConstraints?: OrbitConstraints
};

type Annotation = {
    position: [number, number, number],
    title: string,
    text: string,
    extras: any,
    camera: number
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
        color: [number, number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,
    audioUrl?: string,

    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],

    cameraStartMode: 'default' | 'animTrack' | 'annotation'
};

const migrateAnimTrack = (animTrackV1: AnimTrackV1, fov: number): AnimTrack => {
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

const migrate = (v1: V1): ExperienceSettings => {
    return {
        version: 2,
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: v1.background.color as [number, number, number, number] || [0, 0, 0, 1],
        },
        postEffectSettings: {},
        animTracks: v1.animTracks.map((animTrackV1: AnimTrackV1) => {
            return migrateAnimTrack(animTrackV1, v1.camera.fov || 60);
        }),
        cameras: [{
            fov: v1.camera.fov || 60,
            initialPose: {
                position: v1.camera.position as [number, number, number] || [0, 0, 5],
                target: v1.camera.target as [number, number, number] || [0, 0, 0]
            }
        }],
        annotations: [],
        cameraStartMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default'
    }
};

export type { AnimTrack, Camera, Annotation, PostEffectSettings, ExperienceSettings };

export { migrate };
