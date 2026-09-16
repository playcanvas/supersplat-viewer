import {
    CULLFACE_NONE,
    FILTER_LINEAR,
    PIXELFORMAT_RGBA8,
    BlendState,
    Color,
    Entity,
    Layer,
    Mesh,
    MeshInstance,
    PlaneGeometry,
    Script,
    StandardMaterial,
    Texture,
    Vec3,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA
} from 'playcanvas';
import type { AppBase, Quat } from 'playcanvas';

// clamp the vertices of the hotspot so it is never clipped by the near or far plane
const depthClampGlsl = `
    float f = gl_Position.z / gl_Position.w;
    if (f > 1.0) {
        gl_Position.z = gl_Position.w;
    } else if (f < -1.0) {
        gl_Position.z = -gl_Position.w;
    }
`;

const depthClampWgsl = `
    let f = output.position.z / output.position.w;
    if (f > 1.0) {
        output.position.z = output.position.w;
    } else if (f < -1.0) {
        output.position.z = -output.position.w;
    }
`;

const vec = new Vec3();

const HOTSPOT_SIZE = 25;
const HOTSPOT_COLOR = new Color(0.8, 0.8, 0.8);
const HOVER_COLOR = new Color(1.0, 0.4, 0.0);

/**
 * A script for creating interactive 3D annotations in a scene. Each annotation consists of:
 *
 * - A 3D hotspot that maintains constant screen-space size. The hotspot is rendered with muted
 * appearance when obstructed by geometry but is still clickable. The hotspot relies on an
 * invisible DOM element that matches the hotspot's size and position to detect clicks.
 * - An annotation panel that shows title and description text.
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
     * @private
     */
    texture: Texture | null = null;

    /**
     * @private
     */
    materials: StandardMaterial[] = [];

    /**
     * Set once the entity is destroyed, so a prerender still queued for this frame does not
     * touch torn-down state.
     * @private
     */
    destroyed = false;

    /**
     * Creates the stylesheet the annotation dom needs.
     * @param {number} size - The size of the hotspot in screen pixels.
     * @returns {HTMLStyleElement} The style element, not yet attached.
     * @private
     */
    static _createStyleSheet(size: number) {
        const css = `
            .sse-annotation {
                display: block;
                position: absolute;
                background-color: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 8px;
                border-radius: 4px;
                font-size: 14px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
                pointer-events: none;
                max-width: 200px;
                word-wrap: break-word;
                overflow-x: visible;
                white-space: normal;
                width: fit-content;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
                visibility: hidden;
            }

            .sse-annotation-title {
                font-weight: bold;
                margin-bottom: 4px;
            }

            /* Tooltip arrow */
            .sse-annotation.sse-arrow-right::before,
            .sse-annotation.sse-arrow-left::before {
                content: "";
                position: absolute;
                top: var(--arrow-top, 50%);
                transform: translateY(-50%);
                border-top: 8px solid transparent;
                border-bottom: 8px solid transparent;
            }

            .sse-annotation.sse-arrow-right::before {
                left: -8px;
                border-right: 8px solid rgba(0, 0, 0, 0.8);
            }

            .sse-annotation.sse-arrow-left::before {
                right: -8px;
                border-left: 8px solid rgba(0, 0, 0, 0.8);
            }

            .sse-annotation-hotspot {
                display: none;
                position: absolute;
                width: ${size + 5}px;
                height: ${size + 5}px;
                opacity: 0;
                cursor: pointer;
                transform: translate(-50%, -50%);
            }
        `;

        const style = document.createElement('style');
        style.textContent = css;
        return style;
    }

    /**
     * Creates a circular hotspot texture.
     * @param {AppBase} app - The PlayCanvas AppBase
     * @param {string} label - Label text to draw on the hotspot
     * @param {number} [size] - The texture size (should be power of 2)
     * @param {number} [borderWidth] - The border width in pixels
     * @returns {Texture} The hotspot texture
     * @private
     */
    static _createHotspotTexture(app: AppBase, label: string, size = 64, borderWidth = 6) {
        // Create canvas for hotspot texture
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // First clear with stroke color at zero alpha
        ctx.fillStyle = 'white';
        ctx.globalAlpha = 0;
        ctx.fillRect(0, 0, size, size);
        ctx.globalAlpha = 1.0;

        // Draw dark circle with light border
        const centerX = size / 2;
        const centerY = size / 2;
        const radius = size / 2 - 4; // Leave space for border

        // Draw main circle
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'black';
        ctx.fill();

        // Draw border
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.lineWidth = borderWidth;
        ctx.strokeStyle = 'white';
        ctx.stroke();

        // Draw text
        ctx.font = 'bold 32px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'white';
        ctx.fillText(label, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2) + 1);

        // get pixel data
        const imageData = ctx.getImageData(0, 0, size, size);
        const data = imageData.data;

        // set the color channel of semitransparent pixels to white so the blending at
        // the edges is correct
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 255) {
                data[i] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
            }
        }

        const texture = new Texture(app.graphicsDevice, {
            width: size,
            height: size,
            format: PIXELFORMAT_RGBA8,
            magFilter: FILTER_LINEAR,
            minFilter: FILTER_LINEAR,
            mipmaps: false,
            levels: [new Uint8Array(data.buffer)]
        });

        return texture;
    }

    /**
     * Creates a material for hotspot rendering.
     * @param {Texture} texture - The texture to use for emissive and opacity
     * @param {Color} color - The emissive colour
     * @param {object} [options] - Material options
     * @param {number} [options.opacity] - Base opacity multiplier
     * @param {boolean} [options.depthTest] - Whether to perform depth testing
     * @param {boolean} [options.depthWrite] - Whether to write to depth buffer
     * @returns {StandardMaterial} The configured material
     * @private
     */
    static _createHotspotMaterial(
        texture: Texture,
        color: Color,
        { opacity = 1, depthTest = true, depthWrite = true } = {}
    ) {
        const material = new StandardMaterial();

        // Base properties
        material.diffuse = Color.BLACK;
        material.emissive.copy(color);
        material.emissiveMap = texture;
        material.opacityMap = texture;

        // Alpha properties
        material.opacity = opacity;
        material.alphaTest = 0.01;
        material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD,
            BLENDMODE_SRC_ALPHA,
            BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD,
            BLENDMODE_ONE,
            BLENDMODE_ONE
        );

        // Depth properties
        material.depthTest = depthTest;
        material.depthWrite = depthWrite;

        // Rendering properties
        material.cull = CULLFACE_NONE;
        material.useLighting = false;

        material.shaderChunks.glsl.add({
            litUserMainEndVS: depthClampGlsl
        });
        material.shaderChunks.wgsl.add({
            litUserMainEndVS: depthClampWgsl
        });

        material.update();
        return material;
    }

    initialize() {
        const ctx = this.context;

        // Create texture
        this.texture = Annotation._createHotspotTexture(this.app, this.label);

        // Create material the base and overlay material
        this.materials = [
            Annotation._createHotspotMaterial(this.texture, ctx.hotspotColor, {
                opacity: 1,
                depthTest: true,
                depthWrite: true
            }),
            Annotation._createHotspotMaterial(this.texture, ctx.hotspotColor, {
                opacity: 0.25,
                depthTest: false,
                depthWrite: false
            })
        ];

        const base = new Entity('base', this.app);
        const baseMi = new MeshInstance(ctx.mesh, this.materials[0]);
        baseMi.cull = false;
        base.addComponent('render', {
            layers: [ctx.layers[0].id],
            meshInstances: [baseMi]
        });

        const overlay = new Entity('overlay', this.app);
        const overlayMi = new MeshInstance(ctx.mesh, this.materials[1]);
        overlayMi.cull = false;
        overlay.addComponent('render', {
            layers: [ctx.layers[1].id],
            meshInstances: [overlayMi]
        });

        this.entity.addChild(base);
        this.entity.addChild(overlay);

        // Create hotspot dom
        this.hotspotDom = document.createElement('div');
        this.hotspotDom.className = 'sse-annotation-hotspot';

        // Add click handlers
        this.hotspotDom.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTooltip();
        });

        const leave = () => {
            if (ctx.hoverAnnotation === this) {
                ctx.hoverAnnotation = null;
                this.setHover(false);
            }
        };

        const enter = () => {
            if (ctx.hoverAnnotation !== null) {
                ctx.hoverAnnotation.setHover(false);
            }
            ctx.hoverAnnotation = this;
            this.setHover(true);
        };

        this.hotspotDom.addEventListener('pointerenter', enter);
        this.hotspotDom.addEventListener('pointerleave', leave);

        const onDocumentClick = () => {
            if (ctx.activeAnnotation === this) {
                this.hideTooltip();
            }
        };
        document.addEventListener('click', onDocumentClick);

        ctx.parentDom.appendChild(this.hotspotDom);

        // Clean up on entity destruction
        this.on('destroy', () => {
            this.destroyed = true;
            document.removeEventListener('click', onDocumentClick);
            this.hotspotDom.remove();
            if (ctx.hoverAnnotation === this) {
                ctx.hoverAnnotation = null;
            }
            if (ctx.activeAnnotation === this) {
                this.hideTooltip();
            }

            this.materials.forEach((mat) => mat.destroy());
            this.materials = [];

            this.texture.destroy();
            this.texture = null;
        });

        this.app.on('prerender', () => {
            this._update();
        });
    }

    /**
     * Update screen-space elements and materials for this annotation. Called each frame from the
     * prerender callback, and also directly from showTooltip to ensure the tooltip is positioned
     * correctly even when the camera hasn't moved (e.g. annotations sharing the same camera pose).
     * @private
     */
    _update() {
        if (this.destroyed) return;

        const { camera } = this.context;
        const position = this.entity.getPosition();
        const screenPos = camera.camera.worldToScreen(position);

        const { viewMatrix } = camera.camera;
        viewMatrix.transformPoint(position, vec);
        if (vec.z >= 0) {
            this._hideElements();
            return;
        }

        this._updatePositions(screenPos);
        this._updateRotationAndScale(-vec.z);

        // update material opacity and also directly on the uniform so we
        // can avoid a full material update
        const { opacity } = this.context;
        this.materials[0].opacity = opacity;
        this.materials[1].opacity = 0.25 * opacity;
        this.materials[0].setParameter('material_opacity', opacity);
        this.materials[1].setParameter('material_opacity', 0.25 * opacity);
    }

    /**
     * Set the hover state of the annotation.
     * @param hover - Whether the annotation is hovered
     * @private
     */
    setHover(hover: boolean) {
        this.materials.forEach((material) => {
            material.emissive.copy(hover ? this.context.hoverColor : this.context.hotspotColor);
            material.update();
        });
        this.fire('hover', hover);
    }

    /**
     * @private
     */
    showTooltip() {
        const ctx = this.context;
        ctx.activeAnnotation = this;
        ctx.tooltipDom.style.visibility = 'visible';
        ctx.tooltipDom.style.opacity = '1';
        ctx.titleDom.textContent = this.title;
        ctx.textDom.textContent = this.text;

        // Immediately update incase the camera doesn't move
        this._update();

        this.fire('show', this);
    }

    /**
     * @private
     */
    hideTooltip() {
        const { tooltipDom } = this.context;
        this.context.activeAnnotation = null;
        tooltipDom.style.opacity = '0';

        // Wait for fade out before hiding
        setTimeout(() => {
            if (tooltipDom.style.opacity === '0') {
                tooltipDom.style.visibility = 'hidden';
                this.fire('hide');
            }
        }, 200); // Match the transition duration
    }

    /**
     * Hide all elements when annotation is behind camera.
     * @private
     */
    _hideElements() {
        this.hotspotDom.style.display = 'none';
        if (this.context.activeAnnotation === this) {
            this.context.tooltipDom.style.visibility = 'hidden';
            this.context.tooltipDom.style.opacity = '0';
        }
    }

    /**
     * Update screen-space positions of HTML elements.
     * @param {Vec3} screenPos - Screen coordinate
     * @private
     */
    _updatePositions(screenPos: Vec3) {
        // Show and position hotspot
        this.hotspotDom.style.display = 'block';
        this.hotspotDom.style.left = `${screenPos.x}px`;
        this.hotspotDom.style.top = `${screenPos.y}px`;

        const ctx = this.context;

        // Re-show tooltip if it was hidden while behind camera
        if (ctx.activeAnnotation === this) {
            ctx.tooltipDom.style.visibility = 'visible';
            ctx.tooltipDom.style.opacity = '1';
        }

        // Position tooltip, clamped to the canvas (screenPos is in canvas pixels)
        if (ctx.activeAnnotation === this) {
            const tooltip = ctx.tooltipDom;
            const margin = 8;
            const arrowOffset = 25;
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
            tooltip.style.transform = 'none';
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        }
    }

    /**
     * Update 3D rotation and scale of hotspot planes.
     * @param {number} viewDepth - The view-space depth (positive distance along the camera's forward direction)
     * @private
     */
    _updateRotationAndScale(viewDepth: number) {
        // Copy camera rotation to align with view plane
        const cameraRotation = this.context.camera.getRotation();
        this._updateHotspotTransform(this.entity, cameraRotation);

        // Calculate scale based on view depth to maintain constant screen size
        const scale = this._calculateScreenSpaceScale(viewDepth);
        this.entity.setLocalScale(scale, scale, scale);
    }

    /**
     * Update rotation of a single hotspot entity.
     * @param {Entity} hotspot - The hotspot entity to update
     * @param {Quat} cameraRotation - The camera's current rotation
     * @private
     */
    _updateHotspotTransform(hotspot: Entity, cameraRotation: Quat) {
        hotspot.setRotation(cameraRotation);
        hotspot.rotateLocal(90, 0, 0);
    }

    /**
     * Calculate scale factor to maintain constant screen-space size.
     * @param {number} viewDepth - The view-space depth (positive distance along the camera's forward direction)
     * @returns {number} The scale to apply to hotspot entities
     * @private
     */
    _calculateScreenSpaceScale(viewDepth: number) {
        // Use the canvas's CSS/client height instead of graphics device height
        const canvas = this.app.graphicsDevice.canvas;
        const screenHeight = canvas.clientHeight;

        // Use view-space depth (not Euclidean distance) to match the projection matrix
        const projMatrix = this.context.camera.camera.projectionMatrix;
        const worldSize = (HOTSPOT_SIZE / screenHeight) * ((2 * viewDepth) / projMatrix.data[5]);

        return worldSize;
    }
}

/**
 * Everything the annotations of one viewer share: the dom they live in and its stylesheet, the
 * camera they face, their render layers and quad mesh, the single tooltip, and the hover and
 * active bookkeeping. One per viewer, so two viewers on a page never fight over shared state.
 * Owned by `Annotations`, which removes `parentDom` on destroy; the mesh is released through
 * the mesh instances when the annotation entities go.
 */
class AnnotationContext {
    parentDom: HTMLElement;

    canvas: HTMLCanvasElement;

    camera: Entity;

    layers: Layer[];

    mesh: Mesh;

    tooltipDom: HTMLDivElement;

    titleDom: HTMLDivElement;

    textDom: HTMLDivElement;

    // Mutable copies: `Annotations` converts them to gamma space when post effects are active.
    hotspotColor = HOTSPOT_COLOR.clone();

    hoverColor = HOVER_COLOR.clone();

    activeAnnotation: Annotation | null = null;

    hoverAnnotation: Annotation | null = null;

    opacity = 1.0;

    constructor(app: AppBase, camera: Entity, parentDom: HTMLElement) {
        this.parentDom = parentDom;
        this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        this.camera = camera;

        parentDom.appendChild(Annotation._createStyleSheet(HOTSPOT_SIZE));

        const { layers } = app.scene;
        const worldLayer = layers.getLayerByName('World');

        const createLayer = (name: string, semitrans: boolean) => {
            const layer = new Layer({ name: name });
            const idx = semitrans ? layers.getTransparentIndex(worldLayer) : layers.getOpaqueIndex(worldLayer);
            layers.insert(layer, idx + 1);
            return layer;
        };

        this.layers = [createLayer('HotspotBase', false), createLayer('HotspotOverlay', true)];

        camera.camera.layers = [...camera.camera.layers, ...this.layers.map((layer) => layer.id)];

        this.mesh = Mesh.fromGeometry(
            app.graphicsDevice,
            new PlaneGeometry({
                widthSegments: 1,
                lengthSegments: 1
            })
        );

        // Initialize tooltip dom
        this.tooltipDom = document.createElement('div');
        this.tooltipDom.className = 'sse-annotation';

        this.titleDom = document.createElement('div');
        this.titleDom.className = 'sse-annotation-title';
        this.tooltipDom.appendChild(this.titleDom);

        this.textDom = document.createElement('div');
        this.textDom.className = 'sse-annotation-text';
        this.tooltipDom.appendChild(this.textDom);

        parentDom.appendChild(this.tooltipDom);
    }
}

export { AnnotationContext };
