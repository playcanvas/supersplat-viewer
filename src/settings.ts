import { ExperienceSettings as V1, AnimTrack as AnimTrackV1 } from './schemas/v1';

const migrateV1 = (settings: V1): V1 => {
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

    return settings;
};

// import a json object to conform to the latest settings schema. settings is assumed to be one of the well-formed schemas
const importSettings = (settings: any): V1 => {
    let result: V1;

    const version = settings.version;
    if (version === undefined) {
        result = migrateV1(settings as V1);
    } else {
        throw new Error(`Unsupported experience settings version: ${version}`);
    }

    return result;
};

// export the latest/current schema types
export type { AnimTrack, ExperienceSettings } from './schemas/v1';

export { importSettings };
