import type { Entity, EventHandler, AppBase } from 'playcanvas';
import type { ExperienceSettings } from './settings';

type CameraMode = 'orbit' | 'anim' | 'fly';

type InputMode = 'desktop' | 'touch';

type Config = {
    noui: boolean;
    ministats: boolean;
    skyboxUrl?: string;
    poster?: HTMLImageElement;
    contentUrl?: string;
    contents?: Promise<Response>;
};

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
    gsplat?: Entity;
};

export { CameraMode, InputMode, State, Global };
