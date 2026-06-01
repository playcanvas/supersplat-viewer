import type { Global } from '../../types';
import type { InputDevice, UpdateContext } from '../shared';
import { GamepadSource } from '../sources/gamepad';

/**
 * Gamepad reader. Polls the gamepad source, fires the (fly-mode) navigateCancel
 * intent, and exposes the stick signals + tuning constants for the control
 * schemes to map.
 */
class GamepadDevice implements InputDevice {
    moveSpeed: number = 4;

    orbitSpeed: number = 18;

    gamepadRotateSensitivity: number = 1.0;

    /** This-frame left stick [x, y]. */
    leftStick: [number, number] = [0, 0];

    /** This-frame right stick [x, y]. */
    rightStick: [number, number] = [0, 0];

    private _source = new GamepadSource();

    private _global: Global | null = null;

    attach(_canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        // GamepadSource polls navigator.getGamepads() — no DOM attach needed.
    }

    detach(): void {
        this._source.detach();
        this._global = null;
    }

    update(ctx: UpdateContext): void {
        const { leftStick, rightStick } = this._source.read();

        this.leftStick[0] = leftStick[0];
        this.leftStick[1] = leftStick[1];
        this.rightStick[0] = rightStick[0];
        this.rightStick[1] = rightStick[1];

        if (ctx.isFly && (leftStick[0] !== 0 || leftStick[1] !== 0 || rightStick[0] !== 0 || rightStick[1] !== 0)) {
            this._global?.events.fire('navigateCancel');
        }
    }
}

export { GamepadDevice };
