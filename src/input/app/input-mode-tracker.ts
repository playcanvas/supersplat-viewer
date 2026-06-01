import type { Global } from '../../types';
import type { DomEventSource } from '../dom-event-source';

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

    attach(global: Global, source: DomEventSource): void {
        this._global = global;
        source.on('window', 'pointerdown', this._onPointer);
        source.on('window', 'pointermove', this._onPointer);
    }

    detach(): void {
        // window pointer listeners are owned by the DomEventSource
        this._global = null;
    }
}

export { InputModeTracker };
