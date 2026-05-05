import { GamepadSource, Vec3 } from 'playcanvas';

import type { Global } from '../../types';
import type { CameraInputFrame, InputDevice, UpdateContext } from '../shared';

const tmpV = new Vec3();
const stickMove = new Vec3();
const stickRotate = new Vec3();

class GamepadDevice implements InputDevice {
    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    gamepadRotateSensitivity: number = 1.0;

    private _source = new GamepadSource();

    private _global: Global | null = null;

    attach(_canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        // GamepadSource polls navigator.getGamepads() — no DOM attach needed.
    }

    detach(): void {
        this._global = null;
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { dt, cameraComponent, isFly, isFirstPerson } = ctx;
        const { leftStick, rightStick } = this._source.read();
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const { deltas } = frame;

        if (isFly && (leftStick[0] !== 0 || leftStick[1] !== 0 || rightStick[0] !== 0 || rightStick[1] !== 0)) {
            this._global?.events.fire('flyCancel');
        }

        const v = tmpV.set(0, 0, 0);
        stickMove.set(leftStick[0], 0, -leftStick[1]);
        v.add(stickMove.mulScalar(this.moveSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);

        v.set(0, 0, 0);
        stickRotate.set(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(this.orbitSpeed * orbitFactor * this.gamepadRotateSensitivity * dt));
        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

export { GamepadDevice };
