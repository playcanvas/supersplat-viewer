import { Script, Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

const vec = new Vec3();

/**
 * A script for creating interactive 3D annotations in a scene. Each annotation consists of:
 *
 * - A hotspot: a dom circle with the annotation's number, kept over the annotation's position.
 * `Annotations` tests it against the scene and marks it occluded, which fades it rather than
 * letting the scene cover it pixel by pixel. It stays clickable either way.
 * - An annotation panel that shows title and description text, shared by every annotation.
 *
 * Styles live in `index.scss`, under `.sse-annotations`.
 */
export class Annotation extends Script {
    static scriptName = 'annotation';

    /**
     * State shared by every annotation of one viewer. Set by `Annotations` before the script
     * initialises.
     */
    context: AnnotationContext;

    /**
     * @attribute
     */
    label: string;

    /**
     * @attribute
     */
    title: string;

    /**
     * @attribute
     */
    text: string;

    /**
     * @private
     */
    hotspotDom: HTMLDivElement | null = null;

    /**
     * The hotspot's position in canvas pixels, its distance from the camera and its depth
     * along the view, as of the last update; null while it is behind the camera. Read by the
     * occlusion test.
     * @private
     */
    screen: { x: number; y: number; distance: number; depth: number } | null = null;

    /**
     * Set once the entity is destroyed, so a prerender still queued for this frame does not
     * touch torn-down state.
     * @private
     */
    destroyed = false;

    initialize() {
        const ctx = this.context;

        this.hotspotDom = document.createElement('div');
        // dimmed until the occlusion test first shows it in view, rather than every hotspot
        // showing at full strength on the reveal and the hidden ones fading afterwards
        this.hotspotDom.className = 'sse-annotation-hotspot sse-occluded';
        this.hotspotDom.textContent = this.label;

        const onClick = (e: MouseEvent) => {
            e.stopPropagation();
            this.fire('select');
        };
        this.hotspotDom.addEventListener('click', onClick);

        ctx.hotspotsDom.appendChild(this.hotspotDom);

        const onPrerender = () => this._update();
        this.app.on('prerender', onPrerender);

        // Clean up on entity destruction
        this.on('destroy', () => {
            this.destroyed = true;
            this.app.off('prerender', onPrerender);
            this.hotspotDom.removeEventListener('click', onClick);
            this.hotspotDom.remove();
            if (ctx.activeAnnotation === this) {
                this.hideTooltip();
            }
        });
    }

    /**
     * Update the screen-space elements for this annotation. Called each frame from the
     * prerender callback, and also directly from showTooltip to ensure the tooltip is positioned
     * correctly even when the camera hasn't moved (e.g. annotations sharing the same camera pose).
     * @private
     */
    _update() {
        if (this.destroyed) return;

        const { camera } = this.context;
        const position = this.entity.getPosition();

        camera.camera.viewMatrix.transformPoint(position, vec);
        if (vec.z >= 0) {
            this.screen = null;
            this._hideElements();
            return;
        }

        const screenPos = camera.camera.worldToScreen(position);
        const distance = camera.getPosition().distance(position);
        this.screen = { x: screenPos.x, y: screenPos.y, distance, depth: -vec.z };
        this._updatePositions(screenPos, distance);
    }

    /**
     * Mark the hotspot as hidden behind the scene, which fades it to a faint outline.
     * @param occluded - Whether scene content covers the annotation's position.
     * @private
     */
    setOccluded(occluded: boolean) {
        this.hotspotDom.classList.toggle('sse-occluded', occluded);
    }

    /**
     * @private
     */
    showTooltip() {
        const ctx = this.context;
        ctx.activeAnnotation = this;
        ctx.titleDom.textContent = this.title;
        ctx.textDom.textContent = this.text;
        ctx.tooltipDom.classList.add('sse-visible');
        this.hotspotDom.classList.add('sse-active');

        // Immediately update incase the camera doesn't move
        this._update();
    }

    /**
     * @private
     */
    hideTooltip() {
        const ctx = this.context;
        ctx.activeAnnotation = null;
        ctx.tooltipDom.classList.remove('sse-visible');
        this.hotspotDom.classList.remove('sse-active');
    }

    /**
     * Hide all elements when annotation is behind camera.
     * @private
     */
    _hideElements() {
        this.hotspotDom.style.display = 'none';
        if (this.context.activeAnnotation === this) {
            this.context.tooltipDom.classList.remove('sse-visible');
        }
    }

    /**
     * Update screen-space positions of HTML elements.
     * @param {Vec3} screenPos - Screen coordinate
     * @param {number} distance - Distance from the camera, which orders overlapping hotspots
     * @private
     */
    _updatePositions(screenPos: Vec3, distance: number) {
        // Show and position hotspot; a transform rather than left/top, so moving it each frame
        // does not trigger layout
        const hotspot = this.hotspotDom;
        hotspot.style.display = 'flex';
        hotspot.style.transform = `translate(${screenPos.x}px, ${screenPos.y}px) translate(-50%, -50%)`;
        // nearer hotspots draw over farther ones
        hotspot.style.zIndex = String(Math.round(100000 / (1 + distance)));

        const ctx = this.context;
        if (ctx.activeAnnotation !== this) {
            return;
        }

        // Re-show tooltip if it was hidden while behind camera
        const tooltip = ctx.tooltipDom;
        tooltip.classList.add('sse-visible');

        // Position tooltip, clamped to the canvas (screenPos is in canvas pixels)
        const margin = 8;
        const arrowOffset = 24;
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        const vw = ctx.canvas.clientWidth;
        const vh = ctx.canvas.clientHeight;

        // Default position: to the right of hotspot, vertically centered
        let left = screenPos.x + arrowOffset;
        let top = screenPos.y - th / 2;
        let flipped = false;

        // If tooltip overflows right edge, flip to left side of hotspot
        if (left + tw > vw - margin) {
            left = screenPos.x - arrowOffset - tw;
            flipped = true;
        }

        // Clamp horizontal
        left = Math.max(margin, Math.min(left, vw - tw - margin));

        // Clamp vertical
        top = Math.max(margin, Math.min(top, vh - th - margin));

        // Position arrow to point at the hotspot, clamped within the tooltip
        const arrowY = Math.max(16, Math.min(screenPos.y - top, th - 16));
        tooltip.style.setProperty('--arrow-top', `${arrowY}px`);

        tooltip.classList.toggle('sse-arrow-right', !flipped);
        tooltip.classList.toggle('sse-arrow-left', flipped);
        tooltip.style.transform = `translate(${left}px, ${top}px)`;
    }
}

/**
 * Everything the annotations of one viewer share: the dom they live in, the camera they follow,
 * the single tooltip, and the active bookkeeping. One per viewer, so two viewers on a page never
 * fight over shared state. Owned by `Annotations`, which removes `parentDom` on destroy.
 */
class AnnotationContext {
    parentDom: HTMLElement;

    // the hotspots' own layer, beneath the tooltip: their depth ordering stays inside it, so
    // no hotspot can draw over the tooltip
    hotspotsDom: HTMLDivElement;

    canvas: HTMLCanvasElement;

    camera: Entity;

    tooltipDom: HTMLDivElement;

    titleDom: HTMLDivElement;

    textDom: HTMLDivElement;

    activeAnnotation: Annotation | null = null;

    constructor(canvas: HTMLCanvasElement, camera: Entity, parentDom: HTMLElement) {
        this.parentDom = parentDom;
        this.canvas = canvas;
        this.camera = camera;

        this.hotspotsDom = document.createElement('div');
        this.hotspotsDom.className = 'sse-annotation-hotspots';
        parentDom.appendChild(this.hotspotsDom);

        // the tooltip: the title, then the text. No number: the selected hotspot beside it
        // already shows it
        this.tooltipDom = document.createElement('div');
        this.tooltipDom.className = 'sse-annotation';

        this.titleDom = document.createElement('div');
        this.titleDom.className = 'sse-annotation-title';

        this.textDom = document.createElement('div');
        this.textDom.className = 'sse-annotation-text';

        this.tooltipDom.append(this.titleDom, this.textDom);
        parentDom.appendChild(this.tooltipDom);
    }
}

export { AnnotationContext };
