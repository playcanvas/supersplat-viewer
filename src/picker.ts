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

        this.pick = async (x: number, y: number) => {
            const width = Math.ceil(app.graphicsDevice.width * pickerScale);
            const height = Math.ceil(app.graphicsDevice.height * pickerScale);

            // bail out if the device hasn't been sized yet
            if (width <= 0 || height <= 0) {
                return null;
            }

            // clamp normalized inputs and convert to integer pixel coordinates
            // in [0, width-1] / [0, height-1] so an exact 1.0 doesn't fall off the texture.
            const px = Math.min(width - 1, Math.max(0, Math.floor(x * width)));
            const py = Math.min(height - 1, Math.max(0, Math.floor(y * height)));

            // enable gsplat IDs only for the duration of the pick so we don't pay the
            // memory/perf cost between picks (picker instances are typically long-lived).
            const prevEnableIds = app.scene.gsplat.enableIds;
            app.scene.gsplat.enableIds = true;

            picker.resize(width, height);

            const worldLayer = app.scene.layers.getLayerByName('World');
            picker.prepare(camera.camera, app.scene, [worldLayer]);

            const result = await picker.getWorldPointAsync(px, py);

            app.scene.gsplat.enableIds = prevEnableIds;

            return result;
        };

        this.release = () => {
            picker.destroy();
        };
    }
}

export { Picker };
