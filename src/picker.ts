import {
    type AppBase,
    type Entity,
    Picker as EnginePicker,
    Vec3
} from 'playcanvas';

const pickerScale = 0.25;

class Picker {
    pick: (x: number, y: number) => Promise<Vec3 | null>;

    release: () => void;

    constructor(app: AppBase, camera: Entity) {
        const picker = new EnginePicker(app, 1, 1, true);
        app.scene.gsplat.enableIds = true;

        this.pick = async (x: number, y: number) => {
            const width = Math.ceil(app.graphicsDevice.width * pickerScale);
            const height = Math.ceil(app.graphicsDevice.height * pickerScale);

            picker.resize(width, height);

            const worldLayer = app.scene.layers.getLayerByName('World');
            picker.prepare(camera.camera, app.scene, [worldLayer]);

            return picker.getWorldPointAsync(
                Math.floor(x * width),
                Math.floor(y * height)
            );
        };

        this.release = () => picker.destroy();
    }
}

export { Picker };
