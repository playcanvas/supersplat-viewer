import {
    assertObject,
    assertNumber,
    assertString,
    assertEnum,
    assertArray,
    assertNumberArray
} from './validate-utils';

type AnimTrack = {
    name: string,
    duration: number,
    frameRate?: number,
    target: 'camera',
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness?: number,
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
        startAnim?: 'none' | 'orbit' | 'animTrack',
        animTrack?: string | null
    },
    background: {
        color?: number[]
    },
    animTracks?: AnimTrack[]
};

const validateAnimTrack = (data: unknown, path: string): AnimTrack => {
    const obj = assertObject(data, path);
    assertString(obj.name, `${path}.name`);
    assertNumber(obj.duration, `${path}.duration`);
    if (obj.frameRate !== undefined) assertNumber(obj.frameRate, `${path}.frameRate`);
    assertEnum(obj.target, ['camera'] as const, `${path}.target`);
    assertEnum(obj.loopMode, ['none', 'repeat', 'pingpong'] as const, `${path}.loopMode`);
    assertEnum(obj.interpolation, ['step', 'spline'] as const, `${path}.interpolation`);
    if (obj.smoothness !== undefined) assertNumber(obj.smoothness, `${path}.smoothness`);

    const kf = assertObject(obj.keyframes, `${path}.keyframes`);
    assertNumberArray(kf.times, `${path}.keyframes.times`);
    const vals = assertObject(kf.values, `${path}.keyframes.values`);
    assertNumberArray(vals.position, `${path}.keyframes.values.position`);
    assertNumberArray(vals.target, `${path}.keyframes.values.target`);

    return data as AnimTrack;
};

const validateV1 = (data: unknown): ExperienceSettings => {
    const obj = assertObject(data, 'settings');

    const camera = assertObject(obj.camera, 'settings.camera');
    if (camera.fov !== undefined) assertNumber(camera.fov, 'settings.camera.fov');
    if (camera.position !== undefined) assertNumberArray(camera.position, 'settings.camera.position');
    if (camera.target !== undefined) assertNumberArray(camera.target, 'settings.camera.target');
    if (camera.startAnim !== undefined) assertEnum(camera.startAnim, ['none', 'orbit', 'animTrack'] as const, 'settings.camera.startAnim');
    if (camera.animTrack != null) assertString(camera.animTrack, 'settings.camera.animTrack');

    const bg = assertObject(obj.background, 'settings.background');
    if (bg.color !== undefined) assertNumberArray(bg.color, 'settings.background.color');

    if (obj.animTracks !== undefined) {
        const tracks = assertArray(obj.animTracks, 'settings.animTracks');
        tracks.forEach((t: unknown, i: number) => validateAnimTrack(t, `settings.animTracks[${i}]`));
    }

    return data as ExperienceSettings;
};

export { validateV1 };
export type { AnimTrack, ExperienceSettings };
