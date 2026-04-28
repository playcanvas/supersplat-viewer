import { Vec3 } from 'playcanvas';

import type { Collision } from '../../collision';
import { Picker } from '../../picker';
import type { Global } from '../../types';
import { TAP_EPSILON } from '../shared';

const tmpV = new Vec3();

/**
 * Click-to-walk (desktop), tap-to-walk (mobile), and double-click-to-pick
 * (orbit / fly) interaction. Uses a Picker against the collision mesh to
 * resolve the world-space target and fires `walkTo` / `pick` for the
 * camera manager to consume.
 */
class WalkInteraction {
    collision: Collision | null = null;

    private _global: Global | null = null;

    private _canvas: HTMLCanvasElement | null = null;

    private _picker: Picker | null = null;

    private _lastPointerOffsetX = 0;

    private _lastPointerOffsetY = 0;

    private _mouseClickTracking = false;

    private _mouseClickDelta = 0;

    private _lastTap = { time: 0, x: 0, y: 0 };

    private _updateCursor = () => {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return;
        const { state } = global;
        if (state.cameraMode === 'walk' && !state.gamingControls && state.inputMode === 'desktop') {
            canvas.style.cursor = this._mouseClickTracking ? 'default' : 'pointer';
        } else {
            canvas.style.cursor = '';
        }
    };

    private _pickCollision(offsetX: number, offsetY: number): { position: Vec3; normal: Vec3 } | null {
        if (!this.collision || !this._global) return null;

        const camera = this._global.camera;
        const cameraPos = camera.getPosition();

        camera.camera!.screenToWorld(offsetX, offsetY, 1.0, tmpV);
        tmpV.sub(cameraPos).normalize();

        const hit = this.collision.queryRay(
            cameraPos.x, cameraPos.y, cameraPos.z,
            tmpV.x, tmpV.y, tmpV.z,
            camera.camera!.farClip
        );

        if (!hit) return null;

        const sn = this.collision.querySurfaceNormal(hit.x, hit.y, hit.z, tmpV.x, tmpV.y, tmpV.z);
        return {
            position: new Vec3(hit.x, hit.y, hit.z),
            normal: new Vec3(sn.nx, sn.ny, sn.nz)
        };
    }

    private _onPointerDown = (event: PointerEvent) => {
        const global = this._global;
        if (!global) return;
        const { events } = global;

        // record offsets for click/tap-to-walk picking
        this._lastPointerOffsetX = event.offsetX;
        this._lastPointerOffsetY = event.offsetY;

        // start desktop click-to-walk tracking
        if (event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = true;
            this._mouseClickDelta = 0;
            this._updateCursor();
        }

        // manual double-tap detection (iOS doesn't send dblclick)
        const now = Date.now();
        const delay = Math.max(0, now - this._lastTap.time);
        if (delay < 300 &&
            Math.abs(event.clientX - this._lastTap.x) < 8 &&
            Math.abs(event.clientY - this._lastTap.y) < 8) {
            events.fire('inputEvent', 'dblclick', event);
            this._lastTap.time = 0;
        } else {
            this._lastTap.time = now;
            this._lastTap.x = event.clientX;
            this._lastTap.y = event.clientY;
        }
    };

    private _onPointerMove = (event: PointerEvent) => {
        const global = this._global;
        if (!global) return;
        const { state, events } = global;

        if (this._mouseClickTracking && event.pointerType !== 'touch') {
            const prev = this._mouseClickDelta;
            this._mouseClickDelta += Math.abs(event.movementX) + Math.abs(event.movementY);
            if (prev < TAP_EPSILON && this._mouseClickDelta >= TAP_EPSILON) {
                if (state.cameraMode === 'walk' && !state.gamingControls) {
                    events.fire('walkCancel');
                }
            }
        }
    };

    private _onPointerUp = (event: PointerEvent) => {
        const global = this._global;
        if (!global) return;
        const { state, events } = global;

        if (this._mouseClickTracking && event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = false;
            this._updateCursor();
            if (this._mouseClickDelta < TAP_EPSILON && state.cameraMode === 'walk' && !state.gamingControls) {
                const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
                if (result) {
                    events.fire('walkTo', result.position, result.normal);
                }
            }
        }
    };

    private _onInputEvent = async (eventName: string, event: PointerEvent) => {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return;
        if (eventName !== 'dblclick') return;
        const { app, camera, events, state } = global;
        if (state.cameraMode === 'walk') return;
        if (!this._picker) {
            this._picker = new Picker(app, camera);
        }
        const result = await this._picker.pick(
            event.offsetX / canvas.clientWidth,
            event.offsetY / canvas.clientHeight
        );
        if (result) {
            events.fire('pick', result);
        }
    };

    private _onMobileTap = () => {
        const global = this._global;
        if (!global) return;
        const { state, events } = global;
        if (state.cameraMode !== 'walk' || state.gamingControls) return;
        const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
        if (result) {
            events.fire('walkTo', result.position, result.normal);
        }
    };

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._canvas = canvas;
        this._global = global;
        const { events } = global;

        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);

        // double-click → pick → fire 'pick' event (skipped in walk mode)
        events.on('inputEvent', this._onInputEvent);

        // mobile tap (no movement) → walkTo
        events.on('mobileTap', this._onMobileTap);

        // refresh cursor on mode / gaming-controls change
        events.on('cameraMode:changed', this._updateCursor);
        events.on('gamingControls:changed', this._updateCursor);
    }

    detach(): void {
        if (this._canvas) {
            this._canvas.removeEventListener('pointerdown', this._onPointerDown);
            this._canvas.removeEventListener('pointermove', this._onPointerMove);
            this._canvas.removeEventListener('pointerup', this._onPointerUp);
        }
        if (this._global) {
            const { events } = this._global;
            events.off('inputEvent', this._onInputEvent);
            events.off('mobileTap', this._onMobileTap);
            events.off('cameraMode:changed', this._updateCursor);
            events.off('gamingControls:changed', this._updateCursor);
        }
        this._canvas = null;
        this._global = null;
        this._picker = null;
    }
}

export { WalkInteraction };
