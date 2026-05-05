import { Vec3 } from 'playcanvas';

import type { Global } from '../../types';
import {
    DISPLACEMENT_SCALE,
    screenToWorld
} from '../shared';
import type { CameraInputFrame, InputDevice, UpdateContext } from '../shared';
import { WheelClassifier } from '../wheel-classifier';

const tmpV = new Vec3();

class TrackpadDevice implements InputDevice {
    orbitSpeed: number = 18;

    wheelSpeed: number = 0.06;

    trackpadOrbitSensitivity: number = 0.75;

    trackpadPanSensitivity: number = 1.0;

    trackpadZoomSensitivity: number = 2.0;

    private _classifier = new WheelClassifier();

    private _global: Global | null = null;

    private _orbit: [number, number] = [0, 0];

    private _pan: [number, number] = [0, 0];

    private _zoom: number = 0;

    private _onWheel = (event: WheelEvent) => {
        if (this._classifier.classify(event)) {
            // physical mouse wheel — KeyboardMouseSource handles it
            return;
        }

        const mode = this._global!.state.cameraMode;
        const isFirstPersonMode = mode === 'fly' || mode === 'walk';
        const hasZoomModifier = event.ctrlKey || event.metaKey;

        if (mode === 'orbit') {
            // route everything
        } else if (isFirstPersonMode && !hasZoomModifier) {
            // route swipes (with or without shift) to look-around;
            // pinch / Ctrl+swipe fall through to forward/back. Shift is a
            // WASD speed modifier in these modes, not a gesture modifier.
        } else {
            return;
        }

        event.preventDefault();
        // stopImmediatePropagation() blocks KeyboardMouseSource's wheel
        // handler (also attached to this canvas) so the wheel delta
        // doesn't double-up on the existing forward/back path. It also
        // blocks the canvas-level interrupt listener registered elsewhere,
        // so fire interrupt explicitly to keep parity with mouse-wheel.
        event.stopImmediatePropagation();
        this._global!.events.fire('inputEvent', 'interrupt', event);

        const { deltaX, deltaY } = event;

        if (mode === 'orbit') {
            if (event.ctrlKey || event.metaKey) {
                // pinch on macOS arrives as ctrl+wheel; ctrl/meta+scroll routes here too
                this._zoom += deltaY;
            } else if (event.shiftKey) {
                this._pan[0] += deltaX;
                this._pan[1] += deltaY;
            } else {
                this._orbit[0] += deltaX;
                this._orbit[1] += deltaY;
            }
        } else {
            // fly / walk: always rotate (shift is a speed modifier, not a gesture)
            if (mode === 'fly') {
                this._global!.events.fire('flyCancel');
            }
            this._orbit[0] += deltaX;
            this._orbit[1] += deltaY;
        }
    };

    private _canvas: HTMLCanvasElement | null = null;

    /**
     * Trackpad must attach BEFORE KeyboardMouseSource so its
     * `stopImmediatePropagation()` blocks the mouse-source wheel handler
     * for trackpad bursts. The coordinator enforces this by attaching
     * trackpad before keyboard-mouse.
     *
     * @param canvas - The canvas element to listen to.
     * @param global - The global app context (state, events, etc.).
     */
    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._canvas = canvas;
        this._global = global;
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
    }

    detach(): void {
        if (this._canvas) {
            this._canvas.removeEventListener('wheel', this._onWheel);
            this._canvas = null;
        }
        this._global = null;
        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { isOrbit, isFirstPerson, distance, cameraComponent } = ctx;
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const { deltas } = frame;

        if (isOrbit) {
            // orbit rotate
            const v = tmpV.set(this._orbit[0], this._orbit[1], 0);
            v.mulScalar(this.orbitSpeed * this.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
            deltas.rotate.append([v.x, v.y, 0]);

            // pan in world space (matches desktop pan path); reuse tmpV after rotate append
            screenToWorld(cameraComponent, this._pan[0], this._pan[1], distance, tmpV);
            tmpV.mulScalar(this.trackpadPanSensitivity);
            deltas.move.append([tmpV.x, tmpV.y, 0]);

            // zoom along z; positive deltaY (scroll-down / pinch-in) → zoom out → +z for orbit
            const zoomZ = this._zoom * this.wheelSpeed * this.trackpadZoomSensitivity * DISPLACEMENT_SCALE;
            deltas.move.append([0, 0, zoomZ]);
        } else if (isFirstPerson) {
            // fly / walk look-around (only the no-modifier swipe is captured;
            // pinch / Ctrl-swipe fall through to the wheel→forward path)
            const v = tmpV.set(this._orbit[0], this._orbit[1], 0);
            v.mulScalar(this.orbitSpeed * orbitFactor * this.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
            deltas.rotate.append([v.x, v.y, 0]);
        }

        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
    }
}

export { TrackpadDevice };
