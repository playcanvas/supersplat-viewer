import type { Entity, EventHandler, AppBase } from 'playcanvas';

import type { ExperienceSettings } from './settings';

type CameraMode = 'orbit' | 'anim' | 'fly';

type InputMode = 'desktop' | 'touch';

// configuration options are immutable at runtime
type Config = {
    poster?: HTMLImageElement;
    skyboxUrl?: string;
    contentUrl?: string;
    contents?: Promise<Response>;

    noui: boolean;
    noanim: boolean;
    ministats: boolean;
    colorize: boolean;                          // render with LOD colorization
    unified: boolean;                           // force unified rendering mode
    aa: boolean;                                // render with antialiasing
};

// observable state that can change at runtime
type State = {
    readyToRender: boolean;                     // don't render till this is set
    hqMode: boolean;
    progress: number;                           // content loading progress 0-100
    inputMode: InputMode;
    cameraMode: CameraMode;
    hasAnimation: boolean;
    animationDuration: number;
    animationTime: number;
    animationPaused: boolean;
    hasAR: boolean;
    hasVR: boolean;
    isFullscreen: boolean;
    controlsHidden: boolean;
};

type Global = {
    app: AppBase;
    settings: ExperienceSettings;
    config: Config;
    state: State;
    events: EventHandler;
    camera: Entity;
};

export { CameraMode, InputMode, Config, State, Global };
