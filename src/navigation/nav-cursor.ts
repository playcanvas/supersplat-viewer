import { type AppBase, type Entity, type EventHandler, Vec3 } from 'playcanvas';

import { CursorRing, SVGNS } from './cursor-ring';
import type { NavHost } from './nav-host';
import { probeCollision } from './scene-probe';
import type { PickTarget } from './scene-probe';
import type { Collision } from '../collision';
import type { DomEventSource } from '../input/dom-event-source';

// Screen-space diameter (in CSS pixels) used for both hover and target rings
// when the scene isn't walk-sized. Walk-sized scenes render world-space (the
// ring's BASE_OUTER_RADIUS) so it orients to the surface and reads as a physical
// footprint; smaller scenes (or no collision) fall back to a fixed pixel size,
// which keeps the ring legible when 0.2 world units would eat too much of the
// scene. Selection happens in screenPixelsForRing(), keyed on walkAllowed.
const SCREEN_OUTER_PIXELS = 48;

type TargetMode = 'walk' | 'fly' | 'orbit';

/**
 * Navigation feedback view (the cursor half of the target-control modality).
 * Owns two `CursorRing`s — a pointer-tracking hover ring (walk only) and the
 * active-target ring — and decides which to show from the navigation intents on
 * the `events` bus + the pointer. Probes the scene surface under the pointer via
 * the shared `scene-probe`; reads app state through the injected `NavHost`.
 */
class NavCursor {
    private svg: SVGSVGElement;

    private hoverRing: CursorRing;

    private targetRing: CursorRing;

    private camera: Entity;

    private collision: Collision | null;

    private canvas: HTMLCanvasElement;

    private host: NavHost;

    private app: AppBase;

    private onPrerender: () => void;

    // True when the hover ring should track the pointer. Only walk mode
    // (with mouse navigation, not gaming controls) shows the hover ring;
    // fly/orbit only show the target ring on click.
    private hoverActive = false;

    private navigating = false;

    private targetPos: Vec3 | null = null;

    private targetNormal: Vec3 | null = null;

    private targetMode: TargetMode | null = null;

    private onPointerMove: (e: PointerEvent) => void;

    private onPointerLeave: () => void;

    private readonly collisionTarget: PickTarget = {
        position: new Vec3(),
        normal: new Vec3()
    };

    constructor(
        app: AppBase,
        host: NavHost,
        collision: Collision | null,
        events: EventHandler,
        source: DomEventSource
    ) {
        this.camera = host.camera;
        this.collision = collision;
        this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        this.host = host;
        this.app = app;

        this.svg = document.createElementNS(SVGNS, 'svg');
        this.svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:1';
        this.canvas.parentElement!.appendChild(this.svg);

        this.hoverRing = new CursorRing(this.svg, this.canvas, this.camera, true);
        this.targetRing = new CursorRing(this.svg, this.canvas, this.camera, false);

        this.svg.style.display = 'none';

        this.onPointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch' || e.buttons) {
                this.hoverRing.hide();
                return;
            }
            this.updateCursor(e.offsetX, e.offsetY);
        };

        this.onPointerLeave = () => {
            this.hoverRing.hide();
        };

        source.pointermove.on(this.onPointerMove);
        source.pointerleave.on(this.onPointerLeave);

        const updateActive = () => {
            // Hover ring only in walk mode with mouse navigation. Gaming
            // controls use pointer-lock and don't need a hover preview.
            this.hoverActive = host.cameraMode === 'walk' && !host.gamingControls;
            this.hoverRing.hide();
            if (this.targetMode && this.targetMode !== host.cameraMode) {
                this.navigating = false;
                this.clearTarget();
            }
        };

        events.on('cameraMode:changed', updateActive);
        events.on('inputMode:changed', updateActive);
        events.on('gamingControls:changed', updateActive);

        events.on('navigateTo', () => {
            this.navigating = true;
            this.hoverRing.hide();
        });

        events.on('navigateCancel', () => {
            this.navigating = false;
            this.clearTarget();
        });

        events.on('navigateComplete', () => {
            this.navigating = false;
            this.clearTarget();
        });

        events.on('navTarget:set', (pos: Vec3, normal: Vec3) => {
            const mode = host.cameraMode === 'walk' || host.cameraMode === 'fly' ?
                host.cameraMode : 'walk';
            this.setTarget(pos, normal, mode);
        });

        events.on('navTarget:clear', () => {
            this.clearTarget();
        });

        events.on('orbitTarget:set', (pos: Vec3, normal: Vec3) => {
            this.navigating = false;
            this.setTarget(pos, normal, 'orbit');
        });

        events.on('orbitTarget:clear', () => {
            if (this.targetMode === 'orbit') {
                this.clearTarget();
            }
        });

        this.onPrerender = () => {
            this.updateTarget();
        };
        app.on('prerender', this.onPrerender);

        updateActive();
    }

    // Ring sizing is per-scene: walk-sized scenes (collision present and
    // bbox large enough — same predicate as walk mode) get world-space
    // rings, which read as physical footprints on the surface with visible
    // orientation. Smaller scenes or scenes without collision use a fixed
    // screen-pixel ring — 0.2 world units would dominate a small scene,
    // and the pick already falls back to splat depth without collision.
    private screenPixelsForRing(): number | null {
        return this.host.walkAllowed ? null : SCREEN_OUTER_PIXELS;
    }

    private setTarget(pos: Vec3, normal: Vec3, mode: TargetMode) {
        this.targetPos = pos.clone();
        this.targetNormal = normal.clone();
        this.targetMode = mode;
        this.hoverRing.hide();
        this.targetRing.hide();
    }

    private clearTarget() {
        this.targetPos = null;
        this.targetNormal = null;
        this.targetMode = null;
        this.targetRing.hide();
    }

    private updateCursor(offsetX: number, offsetY: number) {
        if (!this.hoverActive || this.navigating) {
            this.hoverRing.hide();
            return;
        }

        if (!this.collision ||
            !probeCollision(this.camera, this.collision, offsetX, offsetY, this.collisionTarget)) {
            this.hoverRing.hide();
            return;
        }

        this.hoverRing.render(this.collisionTarget.position, this.collisionTarget.normal, this.screenPixelsForRing());
    }

    private updateTarget() {
        if (!this.targetPos || !this.targetNormal || !this.targetMode) {
            return;
        }

        const camPos = this.camera.getPosition();
        const dist = camPos.distance(this.targetPos);
        if (this.targetMode !== 'orbit' && dist < 2.0) {
            this.targetRing.hide();
            return;
        }

        this.targetRing.render(this.targetPos, this.targetNormal, this.screenPixelsForRing());
    }

    destroy() {
        this.app.off('prerender', this.onPrerender);
        // pointer listeners are owned by the DomEventSource
        this.svg.remove();
    }
}

export { NavCursor };
