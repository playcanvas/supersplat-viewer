import {
    AppBase,
    AppOptions,
    CameraComponentSystem,
    LightComponentSystem,
    RenderComponentSystem,
    GSplatComponentSystem,
    ScriptComponentSystem,
    ContainerHandler,
    TextureHandler,
    GSplatHandler,
    BinaryHandler,
    XrManager
} from 'playcanvas';
import type { GraphicsDevice, Keyboard, Mouse, TouchDevice } from 'playcanvas';
import { SpzParser } from 'playcanvas/scripts/esm/parsers/spz-parser.mjs';

type AppConstructorOptions = {
    graphicsDevice: GraphicsDevice;
    mouse: Mouse;
    touch: TouchDevice;
    keyboard: Keyboard;
};

class App extends AppBase {
    constructor(canvas: HTMLCanvasElement, options: AppConstructorOptions) {
        super(canvas);

        const appOptions = new AppOptions();

        appOptions.graphicsDevice = options.graphicsDevice;

        appOptions.componentSystems = [
            CameraComponentSystem,
            LightComponentSystem,
            RenderComponentSystem,
            GSplatComponentSystem,
            ScriptComponentSystem
        ];

        appOptions.resourceHandlers = [ContainerHandler, TextureHandler, GSplatHandler, BinaryHandler];

        appOptions.mouse = options.mouse;
        appOptions.touch = options.touch;
        appOptions.keyboard = options.keyboard;

        appOptions.xr = XrManager;

        this.init(appOptions);

        // spz files, and the spz chunks of lcc2 scenes. Version 3 files are gzip compressed;
        // version 4 files need the ZSTD decoder module, which the viewer does not register
        this.loader.getHandler('gsplat').addParser(new SpzParser(this));
    }
}

export { App };
