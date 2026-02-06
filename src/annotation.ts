import {
    type AppBase,
    BlendState,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA,
    CULLFACE_NONE,
    Color,
    Entity,
    EventHandler,
    FILTER_LINEAR,
    Layer,
    Mesh,
    MeshInstance,
    PIXELFORMAT_RGBA8,
    PlaneGeometry,
    Script,
    StandardMaterial,
    Texture,
    type Quat,
    Vec3
} from 'playcanvas';

// clamp the vertices of the hotspot so it is never clipped by the near or far plane
const depthClamp = `
    float f = gl_Position.z / gl_Position.w;
    if (f > 1.0) {
        gl_Position.z = gl_Position.w;
    } else if (f < -1.0) {
        gl_Position.z = -gl_Position.w;
    }
`;

const vec = new Vec3();

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

    static hotspotSize = 25;

    static hotspotColor = new Color(1.0, 0.4, 0.0);

    static hoverColor = new Color(1.0, 0.55, 0.2);

    static parentDom: HTMLElement | null = null;

    static styleSheet: HTMLStyleElement | null = null;

    static camera: Entity | null = null;

    static tooltipDom: HTMLDivElement | null = null;

    static titleDom: HTMLDivElement | null = null;

    static textDom: HTMLDivElement | null = null;

    static events: EventHandler | null = null;

    static layers: Layer[] = [];

    static mesh: Mesh | null = null;

    static activeAnnotation: Annotation | null = null;

    static hoverAnnotation: Annotation | null = null;

    static opacity = 1.0;

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
     * Injects required CSS styles into the document.
     * @param {number} size - The size of the hotspot in screen pixels.
     * @private
     */
    static _injectStyles(_size: number) {
        const hitSize = Math.max(_size + 8, 34);
        const css = `
            .pc-annotation {
                display: block;
                position: absolute;
                background-color: rgba(20, 20, 20, 0.78);
                border: 1px solid rgba(255, 255, 255, 0.12);
                backdrop-filter: blur(10px);
                color: white;
                border-radius: 10px;
                font-size: 12px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
                pointer-events: auto;
                max-width: 240px;
                word-wrap: break-word;
                overflow: hidden;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
                visibility: hidden;
                transform: translate(16px, -50%);
                box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
            }

            .pc-annotation-header {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 10px;
                background-color: rgba(0, 0, 0, 0.18);
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            }

            .pc-annotation-label {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.4px;
                text-transform: uppercase;
                white-space: nowrap;
            }

            .pc-annotation-label::before {
                content: "";
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background-color: #F60;
                box-shadow: 0 0 0 2px rgba(255, 102, 0, 0.25);
            }

            .pc-annotation-actions {
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }

            .pc-annotation-footer {
                display: flex;
                justify-content: flex-end;
                padding: 0 10px 10px;
            }

            .pc-annotation-nav {
                display: grid;
                place-items: center;
                width: 22px;
                height: 22px;
                padding: 0;
                border: 0;
                border-radius: 8px;
                cursor: pointer;
                color: #F60;
                background: rgba(255, 255, 255, 0.06);
                opacity: 0.95;
                transition: background-color 150ms ease, opacity 150ms ease, transform 120ms ease;
            }

            .pc-annotation-nav:hover {
                opacity: 1;
                background: rgba(255, 255, 255, 0.1);
            }

            .pc-annotation-nav:active {
                transform: translateY(1px);
            }

            .pc-annotation-nav > svg {
                width: 14px;
                height: 14px;
                display: block;
            }

            .pc-annotation-text {
                padding: 8px 10px;
                color: rgba(255, 255, 255, 0.78);
                line-height: 1.35;
                white-space: pre-line;
            }

            .pc-annotation-text a {
                color: #F60;
                text-decoration: none;
            }

            .pc-annotation-text a:hover {
                text-decoration: underline;
            }

            .pc-annotation-hotspot {
                display: none;
                position: absolute;
                width: ${hitSize}px;
                height: ${hitSize}px;
                padding: 0;
                border-radius: 50%;
                cursor: pointer;
                transform: translate(-50%, -50%);
                background: transparent;
                border: 0;
                box-shadow: none;
            }

            .pc-annotation-hotspot:focus-visible {
                outline: 2px solid rgba(255, 102, 0, 0.9);
                outline-offset: 2px;
            }
        `;

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        Annotation.styleSheet = style;
    }

    /**
     * Initialize static resources.
     * @param {AppBase} app - The application instance
     * @private
     */
    static _initializeStatic(app: AppBase) {
        if (Annotation.styleSheet) {
            return;
        }

        Annotation._injectStyles(Annotation.hotspotSize);

        if (Annotation.parentDom === null) {
            Annotation.parentDom = document.body;
        }

        const { layers } = app.scene;
        const worldLayer = layers.getLayerByName('World');

        const createLayer = (name: string, semitrans: boolean) => {
            const layer = new Layer({ name: name });
            const idx = semitrans ? layers.getTransparentIndex(worldLayer) : layers.getOpaqueIndex(worldLayer);
            layers.insert(layer, idx + 1);
            return layer;
        };

        Annotation.layers = [
            createLayer('HotspotBase', false),
            createLayer('HotspotOverlay', true)
        ];

        if (Annotation.camera === null) {
            Annotation.camera = app.root.findComponent('camera').entity;
        }

        Annotation.camera.camera.layers = [
            ...Annotation.camera.camera.layers,
            ...Annotation.layers.map(layer => layer.id)
        ];

        Annotation.mesh = Mesh.fromGeometry(app.graphicsDevice, new PlaneGeometry({
            widthSegments: 1,
            lengthSegments: 1
        }));

        // Initialize tooltip dom
        Annotation.tooltipDom = document.createElement('div');
        Annotation.tooltipDom.className = 'pc-annotation';
        Annotation.tooltipDom.addEventListener('pointerdown', (event) => event.stopPropagation());
        Annotation.tooltipDom.addEventListener('click', (event) => event.stopPropagation());

        const header = document.createElement('div');
        header.className = 'pc-annotation-header';

        Annotation.titleDom = document.createElement('div');
        Annotation.titleDom.className = 'pc-annotation-label';

        header.append(Annotation.titleDom);
        Annotation.tooltipDom.appendChild(header);

        Annotation.textDom = document.createElement('div');
        Annotation.textDom.className = 'pc-annotation-text';
        Annotation.tooltipDom.appendChild(Annotation.textDom);

        const footer = document.createElement('div');
        footer.className = 'pc-annotation-footer';

        const actions = document.createElement('div');
        actions.className = 'pc-annotation-actions';
        actions.append(
            Annotation._createNavButton('Previous annotation', 'prev'),
            Annotation._createNavButton('Next annotation', 'next')
        );

        footer.append(actions);
        Annotation.tooltipDom.appendChild(footer);

        Annotation.parentDom.appendChild(Annotation.tooltipDom);
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
        const radius = (size / 2) - 4; // Leave space for border

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
     * @param {object} [options] - Material options
     * @param {number} [options.opacity] - Base opacity multiplier
     * @param {boolean} [options.depthTest] - Whether to perform depth testing
     * @param {boolean} [options.depthWrite] - Whether to write to depth buffer
     * @returns {StandardMaterial} The configured material
     * @private
     */
    static _createHotspotMaterial(texture: Texture, { opacity = 1, depthTest = true, depthWrite = true } = {}) {
        const material = new StandardMaterial();

        // Base properties
        material.diffuse = Color.BLACK;
        material.emissive.copy(Annotation.hotspotColor);
        material.emissiveMap = texture;
        material.opacityMap = texture;

        // Alpha properties
        material.opacity = opacity;
        material.alphaTest = 0.01;
        material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE
        );

        // Depth properties
        material.depthTest = depthTest;
        material.depthWrite = depthWrite;

        // Rendering properties
        material.cull = CULLFACE_NONE;
        material.useLighting = false;

        material.shaderChunks.glsl.add({
            'litUserMainEndVS': depthClamp
        });

        material.update();
        return material;
    }

    static _createNavButton(label: string, direction: 'prev' | 'next') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pc-annotation-nav';
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', direction === 'prev' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-width', '2');

        svg.appendChild(path);
        button.appendChild(svg);

        button.addEventListener('click', (event) => {
            event.stopPropagation();
            Annotation.events?.fire('annotation.navigate', direction === 'prev' ? -1 : 1, event);
        });

        return button;
    }

    static _renderTextWithLinks(dom: HTMLElement, text: string) {
        while (dom.firstChild) {
            dom.removeChild(dom.firstChild);
        }

        // Linkify URLs (http(s) + www.*) without using innerHTML.
        const urlRe = /\b((?:https?:\/\/|www\.)[^\s]+)/gi;
        let lastIndex = 0;

        const appendText = (value: string) => {
            if (value) {
                dom.appendChild(document.createTextNode(value));
            }
        };

        let match: RegExpExecArray | null;
        while ((match = urlRe.exec(text)) !== null) {
            const start = match.index;
            const rawUrl = match[1];

            appendText(text.slice(lastIndex, start));

            const url = rawUrl.replace(/[),.!?]+$/, '');
            const trailing = rawUrl.slice(url.length);

            const a = document.createElement('a');
            a.href = url.startsWith('www.') ? `https://${url}` : url;
            a.textContent = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.addEventListener('click', (event) => event.stopPropagation());
            dom.appendChild(a);

            appendText(trailing);

            lastIndex = start + rawUrl.length;
        }

        appendText(text.slice(lastIndex));
    }

    initialize() {
        // Ensure static resources are initialized
        Annotation._initializeStatic(this.app);

        // Create texture
        this.texture = Annotation._createHotspotTexture(this.app, this.label);

        // Create material the base and overlay material
        this.materials = [
            Annotation._createHotspotMaterial(this.texture, {
                opacity: 1,
                depthTest: true,
                depthWrite: true
            }),
            Annotation._createHotspotMaterial(this.texture, {
                opacity: 0.25,
                depthTest: false,
                depthWrite: false
            })
        ];

        const base = new Entity('base');
        const baseMi = new MeshInstance(Annotation.mesh, this.materials[0]);
        baseMi.cull = false;
        base.addComponent('render', {
            layers: [Annotation.layers[0].id],
            meshInstances: [baseMi]
        });

        const overlay = new Entity('overlay');
        const overlayMi = new MeshInstance(Annotation.mesh, this.materials[1]);
        overlayMi.cull = false;
        overlay.addComponent('render', {
            layers: [Annotation.layers[1].id],
            meshInstances: [overlayMi]
        });

        this.entity.addChild(base);
        this.entity.addChild(overlay);

        // Create hotspot dom
        this.hotspotDom = document.createElement('div');
        this.hotspotDom.className = 'pc-annotation-hotspot';
        this.hotspotDom.setAttribute('role', 'button');
        this.hotspotDom.tabIndex = 0;
        this.updateLabel();

        // Add click handlers
        this.hotspotDom.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTooltip();
        });

        this.hotspotDom.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault();
                event.stopPropagation();
                this.showTooltip();
            }
        });

        const leave = () => {
            if (Annotation.hoverAnnotation === this) {
                Annotation.hoverAnnotation = null;
                this.setHover(false);
            }
        };

        const enter = () => {
            if (Annotation.hoverAnnotation !== null) {
                Annotation.hoverAnnotation.setHover(false);
            }
            Annotation.hoverAnnotation = this;
            this.setHover(true);
        };

        this.hotspotDom.addEventListener('pointerenter', enter);
        this.hotspotDom.addEventListener('pointerleave', leave);

        document.addEventListener('click', () => {
            this.hideTooltip();
        });

        Annotation.parentDom.appendChild(this.hotspotDom);

        // Clean up on entity destruction
        this.on('destroy', () => {
            this.hotspotDom.remove();
            if (Annotation.activeAnnotation === this) {
                this.hideTooltip();
            }

            this.materials.forEach(mat => mat.destroy());
            this.materials = [];

            this.texture.destroy();
            this.texture = null;
        });

        this.app.on('prerender', () => {
            if (!Annotation.camera) return;

            const position = this.entity.getPosition();
            const screenPos = Annotation.camera.camera.worldToScreen(position);

            const { viewMatrix } = Annotation.camera.camera;
            viewMatrix.transformPoint(position, vec);
            if (vec.z >= 0) {
                this._hideElements();
                return;
            }

            this._updatePositions(screenPos);
            this._updateRotationAndScale();

            // update material opacity and also directly on the uniform so we
            // can avoid a full material update
            this.materials[0].opacity = Annotation.opacity;
            this.materials[1].opacity = 0.25 * Annotation.opacity;
            this.materials[0].setParameter('material_opacity', Annotation.opacity);
            this.materials[1].setParameter('material_opacity', 0.25 * Annotation.opacity);
        });
    }

    /**
     * Set the hover state of the annotation.
     * @param hover - Whether the annotation is hovered
     * @private
     */
    setHover(hover: boolean) {
        this.materials.forEach((material) => {
            material.emissive.copy(hover ? Annotation.hoverColor : Annotation.hotspotColor);
            material.update();
        });
        this.fire('hover', hover);
    }

    /**
     * Update hotspot hit target label.
     */
    updateLabel() {
        if (this.hotspotDom) {
            // Keep the hotspot DOM element as an invisible hit target.
            this.hotspotDom.textContent = '';
            this.hotspotDom.setAttribute('aria-label', this.title);
        }
    }

    /**
     * @private
     */
    showTooltip() {
        Annotation.activeAnnotation = this;
        Annotation.tooltipDom.style.visibility = 'visible';
        Annotation.tooltipDom.style.opacity = '1';
        const labelText = this.label ? `${this.label} ${this.title}` : this.title;
        Annotation.titleDom.textContent = labelText;
        Annotation._renderTextWithLinks(Annotation.textDom, this.text);
        this.fire('show', this);
    }

    /**
     * @private
     */
    hideTooltip() {
        Annotation.activeAnnotation = null;
        Annotation.tooltipDom.style.opacity = '0';

        // Wait for fade out before hiding
        setTimeout(() => {
            if (Annotation.tooltipDom.style.opacity === '0') {
                Annotation.tooltipDom.style.visibility = 'hidden';
            }
            this.fire('hide');
        }, 200); // Match the transition duration
    }

    /**
     * Hide all elements when annotation is behind camera.
     * @private
     */
    _hideElements() {
        this.hotspotDom.style.display = 'none';
        if (Annotation.activeAnnotation === this) {
            if (Annotation.tooltipDom.style.visibility !== 'hidden') {
                this.hideTooltip();
            }
        }
    }

    /**
     * Update screen-space positions of HTML elements.
     * @param {Vec3} screenPos - Screen coordinate
     * @private
     */
    _updatePositions(screenPos: Vec3) {
        // Show and position hotspot
        this.hotspotDom.style.display = 'inline-flex';
        this.hotspotDom.style.left = `${screenPos.x}px`;
        this.hotspotDom.style.top = `${screenPos.y}px`;

        // Position tooltip
        if (Annotation.activeAnnotation === this) {
            Annotation.tooltipDom.style.left = `${screenPos.x}px`;
            Annotation.tooltipDom.style.top = `${screenPos.y}px`;
        }
    }

    /**
     * Update 3D rotation and scale of hotspot planes.
     * @private
     */
    _updateRotationAndScale() {
        // Copy camera rotation to align with view plane
        const cameraRotation = Annotation.camera.getRotation();
        this._updateHotspotTransform(this.entity, cameraRotation);

        // Calculate scale based on distance to maintain constant screen size
        const scale = this._calculateScreenSpaceScale();
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
     * @returns {number} The scale to apply to hotspot entities
     * @private
     */
    _calculateScreenSpaceScale() {
        const cameraPos = Annotation.camera.getPosition();
        const toAnnotation = this.entity.getPosition().sub(cameraPos);
        const distance = toAnnotation.length();

        // Use the canvas's CSS/client height instead of graphics device height
        const canvas = this.app.graphicsDevice.canvas;
        const screenHeight = canvas.clientHeight;

        // Get the camera's projection matrix vertical scale factor
        const projMatrix = Annotation.camera.camera.projectionMatrix;
        const worldSize = (Annotation.hotspotSize / screenHeight) * (2 * distance / projMatrix.data[5]);

        return worldSize;
    }
}
