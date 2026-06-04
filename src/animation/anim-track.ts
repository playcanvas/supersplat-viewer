// The runtime animation-track contract the camera-animation playback consumes.
// Kept here (not in app `settings`) so the animation library is self-contained.
// The app's serialized settings track (`schemas/v2` `AnimTrack`) is structurally
// identical, so settings-loaded tracks flow straight in without conversion.
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

export type { AnimTrack };
