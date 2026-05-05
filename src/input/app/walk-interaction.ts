import { Vec3 } from 'playcanvas';

import type { Collision } from '../../collision';
import type { Picker } from '../../picker';
import type { Global } from '../../types';
import { TAP_EPSILON } from '../shared';

const tmpV = new Vec3();

const canTargetFly = (global: Global) => (
    global.state.cameraMode === 'fly' &&
    !(global.state.inputMode === 'desktop' && global.state.gamingControls)
);

type PickTarget = {
    position: Vec3;
    normal: Vec3;
};

/**
 * Click-to-walk / click-to-fly / click-to-focus (desktop), tap equivalents
 * on mobile, and double-click-to-pick fallback. Uses collision first and
 * rendered-scene picking when collision is unavailable.
 */
class WalkInteraction {
    collision: Collision | null = null;

    private _picker: Picker;

    private _global: Global | null = null;

    private _canvas: HTMLCanvasElement | null = null;

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

    private _onCameraModeChanged = () => {
        this._targetPickRequest++;
        this._updateCursor();
    };

    private _pickCollision(offsetX: number, offsetY: number): PickTarget | null {
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

    private async _pickSceneTarget(offsetX: number, offsetY: number): Promise<PickTarget | null> {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return null;

        const collisionTarget = this._pickCollision(offsetX, offsetY);
        if (collisionTarget) {
            return collisionTarget;
        }

        const result = await this._picker.pickSurface(
            offsetX / canvas.clientWidth,
            offsetY / canvas.clientHeight
        );
        if (result) {
            return result;
        }

        return null;
    }

    private async _flyToPickedPosition(offsetX: number, offsetY: number) {
        const global = this._global;
        if (!global || !canTargetFly(global)) return;

        const request = ++this._targetPickRequest;
        const target = await this._pickSceneTarget(offsetX, offsetY);
        if (target && request === this._targetPickRequest && this._global && canTargetFly(this._global)) {
            this._global.events.fire('flyTo', target.position, target.normal);
        }
    }

    private async _focusPickedPosition(offsetX: number, offsetY: number) {
        const global = this._global;
        if (!global || global.state.cameraMode !== 'orbit') return;

        const request = ++this._targetPickRequest;
        const target = await this._pickSceneTarget(offsetX, offsetY);
        if (target && request === this._targetPickRequest && this._global?.state.cameraMode === 'orbit') {
            const { events } = this._global;
            events.fire('orbitTarget:set', target.position, target.normal);
            events.fire('pick', target.position);
        }
    }

    private _onPointerDown = (event: PointerEvent) => {
        const global = this._global;
        if (!global) return;
        const { events } = global;

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
        const global = this._global;
        if (!global) return;
        const { state, events } = global;

        if (this._mouseClickTracking && event.pointerType !== 'touch') {
            const prev = this._mouseClickDelta;
            this._mouseClickDelta += Math.abs(event.movementX) + Math.abs(event.movementY);
            if (prev < TAP_EPSILON && this._mouseClickDelta >= TAP_EPSILON) {
                if (state.cameraMode === 'walk' && !state.gamingControls) {
                    events.fire('walkCancel');
                } else if (state.cameraMode === 'fly') {
                    events.fire('flyCancel');
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
            if (this._suppressClick) {
                this._suppressClick = false;
                return;
            }
            if (this._mouseClickDelta < TAP_EPSILON) {
                if (state.cameraMode === 'walk' && !state.gamingControls) {
                    const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
                    if (result) {
                        events.fire('walkTo', result.position, result.normal);
                    }
                } else if (state.cameraMode === 'fly') {
                    this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
                } else if (state.cameraMode === 'orbit') {
                    this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
                }
            }
        }
    };

    private _onInputEvent = async (eventName: string, event: Event) => {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return;
        if (eventName !== 'dblclick') return;
        if (!(event instanceof MouseEvent)) return;
        const { events, state } = global;
        const cameraMode = state.cameraMode;
        if (cameraMode === 'walk') return;

        if (cameraMode === 'fly') {
            this._flyToPickedPosition(event.offsetX, event.offsetY);
        } else if (cameraMode === 'orbit') {
            const request = ++this._targetPickRequest;
            const target = await this._pickSceneTarget(event.offsetX, event.offsetY);
            if (target && request === this._targetPickRequest && this._global?.state.cameraMode === cameraMode) {
                events.fire('orbitTarget:set', target.position, target.normal);
                events.fire('pick', target.position);
            }
        }
    };

    private _onMobileTap = () => {
        const global = this._global;
        if (!global) return;
        const { state, events } = global;
        if (this._suppressClick) {
            this._suppressClick = false;
            return;
        }

        if (state.cameraMode === 'walk' && !state.gamingControls) {
            const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
            if (result) {
                events.fire('walkTo', result.position, result.normal);
            }
        } else if (state.cameraMode === 'fly') {
            this._flyToPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
        } else if (state.cameraMode === 'orbit') {
            this._focusPickedPosition(this._lastPointerOffsetX, this._lastPointerOffsetY);
        }
    };

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._canvas = canvas;
        this._global = global;
        const { events } = global;

        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);

        // double-click/tap fallback -> fly target or orbit focus (skipped in walk mode)
        events.on('inputEvent', this._onInputEvent);

        // mobile tap (no movement) → walk/fly target or orbit focus
        events.on('mobileTap', this._onMobileTap);

        // refresh cursor on mode / gaming-controls change
        events.on('cameraMode:changed', this._onCameraModeChanged);
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
            events.off('cameraMode:changed', this._onCameraModeChanged);
            events.off('gamingControls:changed', this._updateCursor);
        }
        this._canvas = null;
        this._global = null;
    }
}

export { WalkInteraction };
