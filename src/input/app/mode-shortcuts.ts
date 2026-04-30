import type { PointerLockManager } from './pointer-lock';
import type { Global } from '../../types';

/**
 * Keyboard shortcuts that switch camera mode and toggle UI affordances.
 * Listens on `window` so the user can press 1/2/3, V, G, H, F, R, Space,
 * or Escape regardless of which element has focus.
 */
class ModeShortcuts {
    private _global: Global | null = null;

    private _pointerLock: PointerLockManager | null = null;

    private _onKeyDown = (event: KeyboardEvent) => {
        const global = this._global;
        if (!global) return;
        const { state, events } = global;

        if (event.key === 'Escape') {
            if (this._pointerLock?.recentlyExitedWalk) {
                // already handled by pointerlockchange
            } else if (state.cameraMode === 'walk' && state.gamingControls && state.inputMode === 'desktop') {
                state.gamingControls = false;
            } else if (state.cameraMode === 'walk') {
                events.fire('inputEvent', 'exitWalk', event);
            } else {
                events.fire('inputEvent', 'cancel', event);
            }
            return;
        }

        if (event.ctrlKey || event.altKey || event.metaKey) {
            return;
        }

        switch (event.key) {
            case '1':
                state.cameraMode = 'orbit';
                break;
            case '2':
                state.cameraMode = 'fly';
                break;
            case '3':
                events.fire('inputEvent', 'toggleWalk');
                break;
            case 'v':
                if (state.hasCollisionOverlay) {
                    state.collisionOverlayEnabled = !state.collisionOverlayEnabled;
                }
                break;
            case 'g':
                state.gamingControls = !state.gamingControls;
                break;
            case 'h':
                events.fire('inputEvent', 'toggleHelp');
                break;
            default:
                if ((event.code === 'KeyW' || event.code === 'KeyA' || event.code === 'KeyS' || event.code === 'KeyD') &&
                    state.cameraMode === 'walk' && state.inputMode === 'desktop' && !state.gamingControls) {
                    state.gamingControls = true;
                }
                break;
        }

        if (state.cameraMode !== 'walk') {
            switch (event.key) {
                case 'f':
                    events.fire('inputEvent', 'frame', event);
                    break;
                case 'r':
                    events.fire('inputEvent', 'reset', event);
                    break;
                case ' ':
                    events.fire('inputEvent', 'playPause', event);
                    break;
            }
        }
    };

    attach(global: Global, pointerLock: PointerLockManager): void {
        this._global = global;
        this._pointerLock = pointerLock;
        window.addEventListener('keydown', this._onKeyDown);
    }

    detach(): void {
        window.removeEventListener('keydown', this._onKeyDown);
        this._global = null;
        this._pointerLock = null;
    }
}

export { ModeShortcuts };
