type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    target: 'camera',
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
        }
    }
};

type ExperienceSettings = {
    camera: {
        fov?: number,
        position?: number[],
        target?: number[],
        startAnim: 'none' | 'orbit' | 'animTrack',
        animTrack: string
    },
    background: {
        color?: number[]
    },
    animTracks: AnimTrack[]
};

const migrate = (settings: ExperienceSettings): ExperienceSettings => {
    settings.animTracks?.forEach((track: AnimTrack) => {
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

export type { AnimTrack, ExperienceSettings };

export { migrate };
