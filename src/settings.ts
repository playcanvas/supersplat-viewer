import { ExperienceSettings as V1, AnimTrack as AnimTrackV1 } from './schemas/v1';
import { ExperienceSettings as V2, AnimTrack as AnimTrackV2 } from './schemas/v2';

const migrateV1 = (settings: V1): V1 => {
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
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: v1.background.color as [number, number, number] || [0, 0, 0]
        },
        postEffectSettings: {
            sharpness: {
                enabled: false,
                amount: 0
            },
            bloom: {
                enabled: false,
                intensity: 1,
                blurLevel: 2
            },
            grading: {
                enabled: false,
                brightness: 0,
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
        },
        animTracks: v1.animTracks.map((animTrackV1: AnimTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || 60);
        }),
        cameras: [{
            initial: {
                position: (v1.camera.position || [0, 0, 5]) as [number, number, number],
                target: (v1.camera.target || [0, 0, 0]) as [number, number, number],
                fov: v1.camera.fov || 65
            }
        }],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default',
        hasStartPose: !!(v1.camera.position && v1.camera.target)
    };
};

// import a json object to conform to the latest settings schema. settings is assumed to be one of the well-formed schemas
const importSettings = (settings: any): V2 => {
    let result: V2;

    const version = settings.version;
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

// export the latest/current schema types
export type { AnimTrack, Camera, Annotation, PostEffectSettings, ExperienceSettings } from './schemas/v2';

export { importSettings };
