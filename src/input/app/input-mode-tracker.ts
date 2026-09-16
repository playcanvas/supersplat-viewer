import type { Global } from '../../types';

/**
 * Watches pointer events over the instance root and updates `state.inputMode`
 * to reflect whether the user is on a touch device or desktop.
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
        global.root.addEventListener('pointerdown', this._onPointer);
        global.root.addEventListener('pointermove', this._onPointer);
    }

    detach(): void {
        this._global?.root.removeEventListener('pointerdown', this._onPointer);
        this._global?.root.removeEventListener('pointermove', this._onPointer);
        this._global = null;
    }
}

export { InputModeTracker };
