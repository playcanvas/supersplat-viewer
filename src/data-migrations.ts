const migrateAnimTrack = (track: { frameRate: number, smoothness: number, keyframes: { times: number[] } }) => {
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
};

const migrateSettings = (settings: { animTracks?: any[] }) => {
    settings.animTracks?.forEach((track) => {
        migrateAnimTrack(track);
    });
    return settings;
};

export { migrateSettings };
