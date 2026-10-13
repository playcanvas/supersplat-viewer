import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NORMAL,
    Entity,
    Mat4,
    PIXELFORMAT_SRGBA8,
    StandardMaterial,
    Texture,
    Vec3
} from 'playcanvas';
import type { AppBase, XrInputSource } from 'playcanvas';

import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// The burger icon, in the camera's space (meters): low and to the left of the view, a metre away,
// out of the scene's middle but a glance from it. Eye targeting on Apple Vision Pro is good to a
// degree or two, so its hit area is ICON_HIT times its drawn size, about 4.6 degrees across
const ICON_POSITION = new Vec3(-0.28, -0.22, -1);
const ICON_SIZE = 0.05;
const ICON_HIT = 1.6;

// The open menu's rows, stacked down from MENU_TOP in the middle of the view a metre away, each
// ROW_HEIGHT tall (4 degrees, for the eyes too) and drawn at PIXELS per meter
const MENU_TOP = -0.04;
const MENU_DISTANCE = 1;
const ROW_WIDTH = 0.34;
const ROW_HEIGHT = 0.07;
const ROW_GAP = 0.012;
const PIXELS = 1600;

const GLASS = 'rgba(20, 22, 28, 0.86)';
// the icon is always in view, so it is fainter than the menu
const ICON_GLASS = 'rgba(20, 22, 28, 0.55)';
const ICON_BARS = 'rgba(255, 255, 255, 0.7)';
const GLASS_HOVER = 'rgba(58, 62, 72, 0.92)';
const ON = '#4cc38a';
const OFF = 'rgba(255, 255, 255, 0.28)';

/** A row of the menu: a button, or a switch when it has `checked`. */
type XrHeadMenuItem = {
    label: () => string;
    action: () => void;
    checked?: () => boolean;
    visible?: () => boolean;
};

type Quad = {
    entity: Entity;
    canvas: HTMLCanvasElement;
    texture: Texture;
    material: StandardMaterial;
};

const rayOrigin = new Vec3();
const rayDirection = new Vec3();
const localOrigin = new Vec3();
const localDirection = new Vec3();
const inverse = new Mat4();

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
};

/**
 * A head-locked menu for XR sessions: a burger icon low in the view, which opens a column of
 * rows in front of the eyes. A select (a pinch, a trigger) on the icon opens and closes it, on a
 * row runs it, and anywhere else while it is open closes it. The viewer hands the menu every
 * select before the navigation aims with it ({@link XrHeadMenu#select}), so the selects it takes
 * do not teleport. It follows the camera, so it also scales with a scaled rig, staying the same
 * size in view. Controllers' rays highlight what they point at; Apple Vision Pro shows the eyes'
 * direction only as a pinch starts, so nothing highlights there.
 */
class XrHeadMenu {
    private app: AppBase;

    private items: XrHeadMenuItem[];

    private icon: Quad;

    private rows: Quad[];

    private open = false;

    // the hovered quad, highlighted
    private hovered: Quad | null = null;

    private handles: { off(): void }[];

    /**
     * @param app - The application.
     * @param camera - The XR camera's entity, which the menu follows.
     * @param items - The menu's rows, top to bottom.
     */
    constructor(app: AppBase, camera: Entity, items: XrHeadMenuItem[]) {
        this.app = app;
        this.items = items;

        this.icon = this.createQuad(camera, ICON_SIZE, ICON_SIZE);
        this.icon.entity.setLocalPosition(ICON_POSITION);
        this.rows = items.map(() => this.createQuad(camera, ROW_WIDTH, ROW_HEIGHT));

        const { xr } = app;
        this.handles = [
            xr.on('start', () => this.show(true)),
            xr.on('end', () => this.show(false)),
            app.on('update', () => this.updateHover())
        ];
        this.show(xr.active);
    }

    /**
     * Takes a select that starts on the menu, running what it selects, and one anywhere while the
     * menu is open, closing it.
     *
     * @param source - The input source whose select starts.
     * @returns True when the menu took the select.
     */
    select(source: XrInputSource) {
        if (!this.icon.entity.enabled) return false;
        rayOrigin.copy(source.getOrigin());
        rayDirection.copy(source.getDirection());

        if (this.hits(this.icon, ICON_HIT)) {
            this.setOpen(!this.open);
            return true;
        }
        if (!this.open) return false;

        const index = this.rows.findIndex((row) => row.entity.enabled && this.hits(row, 1));
        if (index >= 0) {
            const item = this.items[index];
            item.action();
            // a switch stays open to show its new state
            if (item.checked) this.draw();
            else this.setOpen(false);
        } else {
            this.setOpen(false);
        }
        return true;
    }

    destroy() {
        for (const handle of this.handles) handle.off();
        for (const quad of [this.icon, ...this.rows]) {
            quad.entity.destroy();
            quad.material.destroy();
            quad.texture.destroy();
        }
    }

    private createQuad(camera: Entity, width: number, height: number): Quad {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * PIXELS);
        canvas.height = Math.round(height * PIXELS);
        // the canvas holds srgb colours, which a linear texture would brighten on the way out
        const texture = new Texture(this.app.graphicsDevice, {
            name: 'sse-xr-head-menu',
            width: canvas.width,
            height: canvas.height,
            format: PIXELFORMAT_SRGBA8,
            mipmaps: false,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });
        const material = new StandardMaterial();
        // drawn as painted: no light, sky, fog or the scene's tonemapping
        material.useLighting = false;
        material.useSkybox = false;
        material.useFog = false;
        material.useTonemap = false;
        material.diffuse.set(0, 0, 0);
        material.emissive.set(1, 1, 1);
        material.emissiveMap = texture;
        material.opacityMap = texture;
        material.opacityMapChannel = 'a';
        material.blendType = BLEND_NORMAL;
        // its depth goes to the compositor where it is drawn, so the background is not
        // reprojected through it, and it draws over the scene
        material.alphaTest = 0.1;
        material.depthTest = false;
        material.update();

        const entity = new Entity('XrHeadMenu', this.app);
        entity.addComponent('render', { type: 'plane', castShadows: false, receiveShadows: false });
        entity.render.material = material;
        for (const meshInstance of entity.render.meshInstances) meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
        // the plane lies flat facing up; stood up, it faces the eyes
        entity.setLocalEulerAngles(90, 0, 0);
        entity.setLocalScale(width, 1, height);
        camera.addChild(entity);
        return { entity, canvas, texture, material };
    }

    // whether the ray meets a quad, its size times margin, from its front
    private hits(quad: Quad, margin: number) {
        inverse.copy(quad.entity.getWorldTransform()).invert();
        const origin = inverse.transformPoint(rayOrigin, localOrigin);
        const direction = inverse.transformVector(rayDirection, localDirection);
        if (origin.y <= 0 || direction.y >= 0) return false;
        const t = -origin.y / direction.y;
        const half = 0.5 * margin;
        return Math.abs(origin.x + direction.x * t) <= half && Math.abs(origin.z + direction.z * t) <= half;
    }

    private show(visible: boolean) {
        this.icon.entity.enabled = visible;
        this.setOpen(false);
    }

    private setOpen(open: boolean) {
        this.open = open;
        this.hovered = null;
        this.draw();
    }

    // Controllers' rays highlight what they point at; hands' rays do not, as a hand's ray points
    // along the hand rather than where it selects (Apple Vision Pro's look and pinch)
    private updateHover() {
        if (!this.icon.entity.enabled) return;
        let hovered: Quad | null = null;
        for (const source of this.app.xr.input.inputSources) {
            if (source.targetRayMode !== 'tracked-pointer' || source.hand) continue;
            rayOrigin.copy(source.getOrigin());
            rayDirection.copy(source.getDirection());
            if (this.hits(this.icon, ICON_HIT)) hovered = this.icon;
            else if (this.open) hovered = this.rows.find((row) => row.entity.enabled && this.hits(row, 1)) ?? hovered;
        }
        if (hovered !== this.hovered) {
            this.hovered = hovered;
            this.draw();
        }
    }

    private draw() {
        this.drawIcon();
        let y = MENU_TOP;
        this.items.forEach((item, i) => {
            const row = this.rows[i];
            const visible = this.open && this.icon.entity.enabled && (item.visible?.() ?? true);
            row.entity.enabled = visible;
            if (!visible) return;
            row.entity.setLocalPosition(0, y - ROW_HEIGHT * 0.5, -MENU_DISTANCE);
            y -= ROW_HEIGHT + ROW_GAP;
            this.drawRow(row, item);
        });
    }

    // three bars, or a cross while the menu is open
    private drawIcon() {
        const { canvas } = this.icon;
        const ctx = canvas.getContext('2d');
        const s = canvas.width;
        ctx.clearRect(0, 0, s, s);
        ctx.fillStyle = this.hovered === this.icon ? GLASS_HOVER : ICON_GLASS;
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = ICON_BARS;
        ctx.lineWidth = s * 0.07;
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (this.open) {
            const d = s * 0.17;
            ctx.moveTo(s / 2 - d, s / 2 - d);
            ctx.lineTo(s / 2 + d, s / 2 + d);
            ctx.moveTo(s / 2 + d, s / 2 - d);
            ctx.lineTo(s / 2 - d, s / 2 + d);
        } else {
            for (const dy of [-0.15, 0, 0.15]) {
                ctx.moveTo(s * 0.32, s * (0.5 + dy));
                ctx.lineTo(s * 0.68, s * (0.5 + dy));
            }
        }
        ctx.stroke();
        this.upload(this.icon);
    }

    private drawRow(row: Quad, item: XrHeadMenuItem) {
        const { canvas } = row;
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = this.hovered === row ? GLASS_HOVER : GLASS;
        roundRect(ctx, 1, 1, width - 2, height - 2, height * 0.3);
        ctx.fillStyle = '#ffffff';
        ctx.font = `500 ${Math.round(height * 0.36)}px -apple-system, system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(item.label(), height * 0.36, height / 2);
        if (item.checked) {
            // a switch at the end
            const on = item.checked();
            const w = height * 0.8;
            const h = height * 0.44;
            const x = width - height * 0.3 - w;
            const y = (height - h) / 2;
            ctx.fillStyle = on ? ON : OFF;
            roundRect(ctx, x, y, w, h, h / 2);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(on ? x + w - h / 2 : x + h / 2, height / 2, h * 0.4, 0, Math.PI * 2);
            ctx.fill();
        }
        this.upload(row);
    }

    private upload(quad: Quad) {
        quad.texture.setSource(quad.canvas);
        quad.texture.upload();
    }
}

export { XrHeadMenu };
export type { XrHeadMenuItem };
