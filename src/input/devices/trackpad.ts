import { Vec3 } from 'playcanvas';

import type { Global } from '../../types';
import {
    DISPLACEMENT_SCALE,
    screenToWorld
} from '../shared';
import type { CameraInputFrame, InputDevice, UpdateContext } from '../shared';

const tmpV = new Vec3();

class TrackpadDevice implements InputDevice {
    orbitSpeed: number = 18;

    wheelSpeed: number = 0.06;

    trackpadOrbitSensitivity: number = 0.75;

    trackpadPanSensitivity: number = 1.0;

    trackpadZoomSensitivity: number = 2.0;

    private _global: Global | null = null;

    private _orbit: [number, number] = [0, 0];

    private _pan: [number, number] = [0, 0];

    private _zoom: number = 0;

    // Tracks physical Ctrl key state so we can distinguish macOS-synthesized
    // pinch events (wheel + ctrlKey, no physical Ctrl) from a user holding
    // Ctrl while spinning a mouse wheel. The synthetic-Ctrl signal is the
    // one reliable trackpad indicator the platform gives us — every other
    // per-event heuristic has been tried (wheelDelta % 120, deltaMode,
    // fractional/diagonal deltas) and misfires on hi-res mice or in
    // momentum tails. Modifier-key state we can trust 100%.
    private _ctrlDown = false;

    private _onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Control') {
            this._ctrlDown = true;
        }
    };

    private _onKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Control') {
            this._ctrlDown = false;
        }
    };

    // Window blur (alt-tab, focus another app) drops keyup events, so
    // clear Ctrl state defensively to avoid getting stuck.
    private _onBlur = () => {
        this._ctrlDown = false;
    };

    private _onWheel = (event: WheelEvent) => {
        const mode = this._global!.state.cameraMode;

        // Synthetic Ctrl (macOS pinch-to-zoom, Magic Mouse pinch): ctrlKey
        // is true on the event but the user isn't physically holding Ctrl.
        // Routes to trackpad-tuned zoom.
        const isPinch = event.ctrlKey && !this._ctrlDown;
        // Physical Ctrl + wheel/swipe: rotate. In orbit mode rotates around
        // the target; in fly/walk mode looks around. Applies to both mouse
        // wheel and trackpad swipe — we can't distinguish them, and the
        // modifier signals intent either way.
        // Corner case: user physically holds Ctrl AND pinches at the same
        // time — both flags are true, the gesture lands here as rotate
        // rather than pinch. Intentional: physical Ctrl is the explicit
        // signal, so it wins over the synthetic-Ctrl pinch heuristic.
        const isCtrlRotate = event.ctrlKey && this._ctrlDown;
        // Shift + wheel/swipe: pan (= strafe + vertical) in all modes. The
        // downstream camera controllers translate the screen-space pan
        // vector appropriately (orbit pans around the target plane; fly
        // strafes sideways and translates vertically; walk strafes).
        const isShiftPan = event.shiftKey;

        if (!isPinch && !isCtrlRotate && !isShiftPan) {
            // Bare wheel (mouse or trackpad swipe), unmodified fly/walk
            // wheels — all fall through to KeyboardMouseDevice for
            // standard forward/back motion (which dollys toward the orbit
            // target in orbit mode via flipZForOrbit, giving the universal
            // bare-scroll-zooms behavior).
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
        if (mode === 'fly') {
            this._global!.events.fire('navigateCancel');
        }

        const { deltaX, deltaY } = event;

        if (isPinch) {
            this._zoom += deltaY;
        } else if (isCtrlRotate) {
            this._orbit[0] += deltaX;
            this._orbit[1] += deltaY;
        } else {
            this._pan[0] += deltaX;
            this._pan[1] += deltaY;
        }
    };

    private _canvas: HTMLCanvasElement | null = null;

    /**
     * Trackpad must attach BEFORE KeyboardMouseSource so its
     * `stopImmediatePropagation()` blocks the mouse-source wheel handler
     * for trackpad bursts. The coordinator enforces this by attaching
     * trackpad before keyboard-mouse.
     *
     * Keyboard listeners attach on `window` (not the canvas) so we still
     * see Ctrl keydown/keyup when focus is on a UI overlay.
     *
     * @param canvas - The canvas element to listen to.
     * @param global - The global app context (state, events, etc.).
     */
    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._canvas = canvas;
        this._global = global;
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('blur', this._onBlur);
    }

    detach(): void {
        if (this._canvas) {
            this._canvas.removeEventListener('wheel', this._onWheel);
            this._canvas = null;
        }
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
        window.removeEventListener('blur', this._onBlur);
        this._global = null;
        this._ctrlDown = false;
        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { isOrbit, isFirstPerson, distance, cameraComponent } = ctx;
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const { deltas } = frame;

        if (isOrbit) {
            // Ctrl + scroll → orbit rotate
            const v = tmpV.set(this._orbit[0], this._orbit[1], 0);
            v.mulScalar(this.orbitSpeed * this.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
            deltas.rotate.append([v.x, v.y, 0]);

            // shift + scroll → pan in world space (matches desktop pan path); reuse tmpV after rotate append
            screenToWorld(cameraComponent, this._pan[0], this._pan[1], distance, tmpV);
            tmpV.mulScalar(this.trackpadPanSensitivity);
            deltas.move.append([tmpV.x, tmpV.y, 0]);

            // synthetic-Ctrl pinch → zoom along z; positive deltaY (scroll-down / pinch-in) → zoom out → +z for orbit
            const zoomZ = this._zoom * this.wheelSpeed * this.trackpadZoomSensitivity * DISPLACEMENT_SCALE;
            deltas.move.append([0, 0, zoomZ]);
        } else if (isFirstPerson) {
            // Ctrl + scroll → look around in fly/walk
            const v = tmpV.set(this._orbit[0], this._orbit[1], 0);
            v.mulScalar(this.orbitSpeed * orbitFactor * this.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
            deltas.rotate.append([v.x, v.y, 0]);

            // shift + scroll → strafe (X) + vertical (Y) via the same
            // screen-space pan pipeline as orbit mode; the fly/walk
            // controllers translate this into sideways/vertical motion
            screenToWorld(cameraComponent, this._pan[0], this._pan[1], distance, tmpV);
            tmpV.mulScalar(this.trackpadPanSensitivity);
            deltas.move.append([tmpV.x, tmpV.y, 0]);

            // synthetic-Ctrl pinch → forward/back along z (same sign as the
            // bare-wheel path in KeyboardMouseDevice, so pinch and scroll
            // produce identical motion in fly/walk modes)
            const moveZ = -this._zoom * this.wheelSpeed * this.trackpadZoomSensitivity * DISPLACEMENT_SCALE;
            deltas.move.append([0, 0, moveZ]);
        }

        this._orbit[0] = this._orbit[1] = 0;
        this._pan[0] = this._pan[1] = 0;
        this._zoom = 0;
    }
}

export { TrackpadDevice };
