/* eslint-disable no-unused-vars */
interface Window {
    // Handoff from the document's inline bootstrap to the module. `settings` is a plain
    // object when the embedder inlined one into the #sse-bootstrap block, and a promise of
    // the fetched json otherwise.
    sse: {
        config: import('./src/types').Config,
        settings: object | Promise<object>
    }

    firstFrame?: () => void;

    app?: import('playcanvas').AppBase;

    scrubTo?: (time: number) => Promise<void>;

    captureFrame?: (options?: { time?: number; width?: number; height?: number; supersample?: number }) => Promise<{ width: number; height: number; data: string }>;

    animationDuration?: number;

    getCameraState?: () => {
        position: [number, number, number];
        angles: [number, number, number];
        distance: number;
        fov: number;
        mode: 'orbit' | 'anim' | 'fly' | 'walk';
    };

    setCameraState?: (snapshot: {
        position: [number, number, number];
        angles: [number, number, number];
        distance: number;
        fov: number;
        mode: 'orbit' | 'anim' | 'fly' | 'walk';
    }) => void;
}

declare module 'playcanvas/scripts/esm/xr/xr-controllers.mjs' {
    const XrControllers: typeof pc.Script;
    export { XrControllers };
}

declare module 'playcanvas/scripts/esm/xr/xr-navigation.mjs' {
    const XrNavigation: typeof pc.Script;
    export { XrNavigation };
}

declare module '*.html' {
    const content: string;
    export default content;
}

declare module '*.css' {
    const content: string;
    export default content;
}

declare module '*.js' {
    const content: string;
    export default content;
}
