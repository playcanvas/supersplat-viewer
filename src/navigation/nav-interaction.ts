import { Vec3 } from 'playcanvas';
import type { EventHandler } from 'playcanvas';

import type { NavHost } from './nav-host';
import type { Picker } from './picker';
import { probeCollision, probeSurface } from './scene-probe';
import type { PickTarget } from './scene-probe';
import type { Collision } from '../collision';
import type { DomEventSource } from '../input/dom-event-source';
import { TAP_EPSILON } from '../input/shared';

const canTargetFly = (host: NavHost) => (
    host.cameraMode === 'fly' &&
    !(host.inputMode === 'desktop' && host.gamingControls)
);

// Mirror gaming-controls speed modifiers: shift = run/boost, ctrl = crawl/slow.
// Multipliers match keyboard-mouse.ts so click-nav and held-key movement feel the same.
const computeClickSpeedMul = (event: MouseEvent | undefined, mode: string): number => {
    if (!event) return 1;
    if (mode === 'walk') {
        if (event.shiftKey) return 2;
        if (event.ctrlKey) return 0.5;
    } else if (mode === 'fly') {
        if (event.shiftKey) return 4;
        if (event.ctrlKey) return 0.25;
    }
    return 1;
};

/**
 * Navigation interaction — the input→intent half of the target-control modality:
 * click-to-walk / click-to-fly / click-to-focus (desktop), tap equivalents on
 * mobile, and the double-click mode-swap. Resolves a screen point to a world
 * target via the shared scene-probe (collision first, splat-depth fallback) and
 * fires the discrete navigation intents (`navigateTo` / `orbitTarget:set` /
 * `pick` / `navigateCancel`) the camera manager animates to. Decoupled from
 * `global` — reads/writes the app via the injected `NavHost` + intent `events`.
 */
class NavInteraction {
    collision: Collision | null = null;

    private _picker: Picker;

    private _host: NavHost | null = null;

    private _events: EventHandler | null = null;

    private _lastPointerOffsetX = 0;

    private _lastPointerOffsetY = 0;

    private _mouseClickTracking = false;

    private _mouseClickDelta = 0;

    private _suppressClick = false;

    private _targetPickRequest = 0;

    private _lastTap = { time: 0, x: 0, y: 0 };

    constructor(picker: Picker) {
        this._picker = picker;
    }

    private _updateCursor = () => {
        const host = this._host;
        if (!host) return;
        const { canvas } = host;
        const canClickTarget = host.inputMode === 'desktop' && (
            (host.cameraMode === 'walk' && !host.gamingControls) ||
            canTargetFly(host) ||
            host.cameraMode === 'orbit'
        );
        if (canClickTarget) {
            canvas.style.cursor = this._mouseClickTracking ? 'default' : 'pointer';
        } else {
            canvas.style.cursor = '';
        }
    };

    private _onCameraModeChanged = () => {
        this._targetPickRequest++;
        this._updateCursor();
    };

    private async _flyToPickedPosition(offsetX: number, offsetY: number, event?: MouseEvent) {
        const host = this._host;
        const events = this._events;
        if (!host || !events || !canTargetFly(host)) return;

        const request = ++this._targetPickRequest;
        const target = await probeSurface(host.camera, this.collision, this._picker, host.canvas, offsetX, offsetY);
        if (target && request === this._targetPickRequest && this._host && canTargetFly(this._host)) {
            const speedMul = computeClickSpeedMul(event, this._host.cameraMode);
            events.fire('navigateTo', target.position, target.normal, speedMul);
        }
    }

    private async _focusPickedPosition(offsetX: number, offsetY: number) {
        const host = this._host;
        const events = this._events;
        if (!host || !events || host.cameraMode !== 'orbit') return;

        const request = ++this._targetPickRequest;
        const target = await probeSurface(host.camera, this.collision, this._picker, host.canvas, offsetX, offsetY);
        if (target && request === this._targetPickRequest && this._host?.cameraMode === 'orbit') {
            events.fire('orbitTarget:set', target.position, target.normal);
            events.fire('pick', target.position);
        }
    }

    private _onPointerDown = (event: PointerEvent) => {
        const host = this._host;
        const events = this._events;
        if (!host || !events) return;

        // record offsets for click/tap target picking
        this._lastPointerOffsetX = event.offsetX;
        this._lastPointerOffsetY = event.offsetY;

        // start desktop click target tracking
        if (event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = true;
            this._mouseClickDelta = 0;
            this._updateCursor();
        }

        // Manual double-click/tap detection for platforms that do not emit
        // reliable native dblclick events on the canvas.
        const now = Date.now();
        const delay = Math.max(0, now - this._lastTap.time);
        if (delay < 300 &&
            Math.abs(event.clientX - this._lastTap.x) < 8 &&
            Math.abs(event.clientY - this._lastTap.y) < 8) {
            this._suppressClick = true;
            events.fire('inputEvent', 'dblclick', event);
            this._lastTap.time = 0;
        } else {
            this._lastTap.time = now;
            this._lastTap.x = event.clientX;
            this._lastTap.y = event.clientY;
        }
    };

    private _onPointerMove = (event: PointerEvent) => {
        const host = this._host;
        const events = this._events;
        if (!host || !events) return;

        if (this._mouseClickTracking && event.pointerType !== 'touch') {
            const prev = this._mouseClickDelta;
            this._mouseClickDelta += Math.abs(event.movementX) + Math.abs(event.movementY);
            if (prev < TAP_EPSILON && this._mouseClickDelta >= TAP_EPSILON) {
                if ((host.cameraMode === 'walk' && !host.gamingControls) || canTargetFly(host)) {
                    events.fire('navigateCancel');
                }
            }
        }
    };

    private _onPointerUp = (event: PointerEvent) => {
        const host = this._host;
        const events = this._events;
        if (!host || !events) return;

        if (this._mouseClickTracking && event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = false;
            this._updateCursor();
            if (this._suppressClick) {
                this._suppressClick = false;
                return;
            }
            if (this._mouseClickDelta < TAP_EPSILON) {
                if (host.cameraMode === 'walk' && !host.gamingControls) {
                    const target: PickTarget = { position: new Vec3(), normal: new Vec3() };
                    if (this.collision && probeCollision(host.camera, this.collision, this._lastPointerOffsetX, this._lastPointerOffsetY, target)) {
                        const speedMul = computeClickSpeedMul(event, host.cameraMode);
                        events.fire('navigateTo', target.position, target.normal, speedMul);
                    }
                } else if (host.cameraMode === 'fly') {
                    this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY, event);
                } else if (host.cameraMode === 'orbit') {
                    this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
                }
            }
        }
    };

    private _onInputEvent = async (eventName: string, event: Event) => {
        const host = this._host;
        const events = this._events;
        if (!host || !events) return;
        if (eventName !== 'dblclick') return;
        if (!(event instanceof MouseEvent)) return;
        // dblclick swaps the active mode and uses the picked target:
        //   fly          → orbit, focus orbit at point
        //   orbit / walk → fly, navigate fly toward point
        const request = ++this._targetPickRequest;
        const target = await probeSurface(host.camera, this.collision, this._picker, host.canvas, event.offsetX, event.offsetY);
        if (!target || request !== this._targetPickRequest) return;

        const currentMode = this._host?.cameraMode;
        if (currentMode === 'fly') {
            // 'pick' switches mode to orbit, which cancels the active fly nav
            // and would clobber any pre-set orbit target — set it after.
            events.fire('pick', target.position);
            events.fire('orbitTarget:set', target.position, target.normal);
        } else if (currentMode === 'orbit' || currentMode === 'walk') {
            // request the switch to fly via the same intent the input core uses —
            // CameraManager sets cameraMode='fly' synchronously, mirroring the
            // fly→orbit branch's `pick` — then navigate in the now-fly mode.
            events.fire('inputEvent', 'requestFirstPerson');
            // Modifiers apply against the destination mode (fly), not the source.
            const speedMul = computeClickSpeedMul(event, 'fly');
            events.fire('navigateTo', target.position, target.normal, speedMul);
        }
    };

    private _onMobileTap = () => {
        const host = this._host;
        const events = this._events;
        if (!host || !events) return;
        if (this._suppressClick) {
            this._suppressClick = false;
            return;
        }

        if (host.cameraMode === 'walk' && !host.gamingControls) {
            const target: PickTarget = { position: new Vec3(), normal: new Vec3() };
            if (this.collision && probeCollision(host.camera, this.collision, this._lastPointerOffsetX, this._lastPointerOffsetY, target)) {
                events.fire('navigateTo', target.position, target.normal);
            }
        } else if (host.cameraMode === 'fly') {
            this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
        } else if (host.cameraMode === 'orbit') {
            this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
        }
    };

    attach(host: NavHost, events: EventHandler, source: DomEventSource): void {
        this._host = host;
        this._events = events;

        source.pointerdown.on(this._onPointerDown);
        source.pointermove.on(this._onPointerMove);
        source.pointerup.on(this._onPointerUp);

        // double-click/tap fallback -> fly target or orbit focus (skipped in walk mode)
        events.on('inputEvent', this._onInputEvent);

        // mobile tap (no movement) → walk/fly target or orbit focus
        events.on('mobileTap', this._onMobileTap);

        // refresh cursor on mode / gaming-controls change
        events.on('cameraMode:changed', this._onCameraModeChanged);
        events.on('inputMode:changed', this._updateCursor);
        events.on('gamingControls:changed', this._updateCursor);
    }

    detach(): void {
        // pointer listeners are owned by the DomEventSource; only the
        // app-event subscriptions are ours to remove.
        const events = this._events;
        if (events) {
            events.off('inputEvent', this._onInputEvent);
            events.off('mobileTap', this._onMobileTap);
            events.off('cameraMode:changed', this._onCameraModeChanged);
            events.off('inputMode:changed', this._updateCursor);
            events.off('gamingControls:changed', this._updateCursor);
        }
        this._host = null;
        this._events = null;
    }
}

export { NavInteraction };
