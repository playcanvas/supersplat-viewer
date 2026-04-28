import type { Global } from '../../types';
import type { KeyboardMouseDevice } from '../devices/keyboard-mouse';

/**
 * Manages the browser's pointer-lock API for walk-mode + gaming controls
 * on desktop. Toggles in response to `cameraMode:changed` and
 * `gamingControls:changed`, and reverts state if the lock is exited or
 * rejected.
 *
 * Also exposes `recentlyExitedWalk` so the keyboard-shortcut handler can
 * de-duplicate the Escape keydown that triggered the lock exit.
 */
class PointerLockManager {
    private _global: Global | null = null;

    private _canvas: HTMLCanvasElement | null = null;

    private _keyboardMouse: KeyboardMouseDevice | null = null;

    private _recentlyExitedWalk = false;

    private _onPointerLockChange = () => {
        const global = this._global;
        if (!global) return;
        const { state, events } = global;
        if (!document.pointerLockElement && state.cameraMode === 'walk' && state.gamingControls) {
            this._recentlyExitedWalk = true;
            requestAnimationFrame(() => {
                this._recentlyExitedWalk = false;
            });
            if (state.inputMode === 'desktop') {
                state.gamingControls = false;
            } else {
                events.fire('inputEvent', 'exitWalk');
            }
        }
    };

    private _onPointerLockError = () => {
        // Pointer lock request rejected (no user gesture, document hidden,
        // etc). Revert state so we don't end up stuck in walk mode without
        // mouse capture.
        if (this._keyboardMouse) {
            (this._keyboardMouse.source as any)._pointerLock = false;
        }
        const global = this._global;
        if (!global) return;
        const { state, events } = global;
        if (state.inputMode === 'desktop') {
            state.gamingControls = false;
        } else {
            events.fire('inputEvent', 'exitWalk');
        }
    };

    private _onCameraModeChanged = (value: string, prev: string) => {
        const state = this._global?.state;
        if (!state) return;
        if (value === 'walk' && state.inputMode === 'desktop' && state.gamingControls) {
            this._activate();
        } else if (prev === 'walk') {
            this._deactivate();
        }
    };

    private _onGamingControlsChanged = (value: boolean) => {
        const state = this._global?.state;
        if (!state) return;
        if (state.cameraMode === 'walk' && state.inputMode === 'desktop') {
            if (value) {
                this._activate();
            } else {
                this._deactivate();
            }
        }
    };

    private _activate(): void {
        if (this._keyboardMouse) {
            (this._keyboardMouse.source as any)._pointerLock = true;
        }
        this._canvas?.requestPointerLock();
    }

    private _deactivate(): void {
        if (this._keyboardMouse) {
            (this._keyboardMouse.source as any)._pointerLock = false;
        }
        if (document.pointerLockElement === this._canvas) {
            document.exitPointerLock();
        }
    }

    get recentlyExitedWalk(): boolean {
        return this._recentlyExitedWalk;
    }

    attach(canvas: HTMLCanvasElement, global: Global, keyboardMouse: KeyboardMouseDevice): void {
        this._canvas = canvas;
        this._global = global;
        this._keyboardMouse = keyboardMouse;

        const { events } = global;

        events.on('cameraMode:changed', this._onCameraModeChanged);
        events.on('gamingControls:changed', this._onGamingControlsChanged);

        document.addEventListener('pointerlockchange', this._onPointerLockChange);
        document.addEventListener('pointerlockerror', this._onPointerLockError);
    }

    detach(): void {
        if (this._global) {
            const { events } = this._global;
            events.off('cameraMode:changed', this._onCameraModeChanged);
            events.off('gamingControls:changed', this._onGamingControlsChanged);
        }
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
        document.removeEventListener('pointerlockerror', this._onPointerLockError);
        this._canvas = null;
        this._global = null;
        this._keyboardMouse = null;
    }
}

export { PointerLockManager };
