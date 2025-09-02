const migrateAnimTrack = (track) => {
    if (!track.frameRate) {
        const defaultFrameRate = 30;

        track.frameRate = defaultFrameRate;
        const times = track.keyframes.times;
        for (let i = 0; i < times.length; i++) {
            times[i] *= defaultFrameRate;
        }
    }
};

const migrateSettings = (settings) => {
    settings.animTracks?.forEach((track) => {
        migrateAnimTrack(track);
    });
    return settings;
};

export { migrateSettings };
