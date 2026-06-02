import type { Global } from '../../types';

/**
 * Watches global pointer events and updates `state.inputMode` to reflect
 * whether the user is on a touch device or desktop.
 */
class InputModeTracker {
    private _global: Global | null = null;

    private _onPointer = (event: PointerEvent) => {
        if (this._global) {
            this._global.state.inputMode = event.pointerType === 'touch' ? 'touch' : 'desktop';
        }
    };

    attach(global: Global): void {
        this._global = global;
        window.addEventListener('pointerdown', this._onPointer);
        window.addEventListener('pointermove', this._onPointer);
    }

    detach(): void {
        window.removeEventListener('pointerdown', this._onPointer);
        window.removeEventListener('pointermove', this._onPointer);
        this._global = null;
    }
}

export { InputModeTracker };
