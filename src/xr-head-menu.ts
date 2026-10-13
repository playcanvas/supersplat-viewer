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

// The rows fade and drop in over ROW_TIME seconds each, STAGGER apart down the column, from DROP
// above and at ROW_GROW of their size; closing plays it back from the bottom row. The icon's bars
// turn into a cross over MORPH_TIME, and a switch's knob slides over KNOB_TIME. A pressed quad
// shrinks to PRESS_SCALE while the select stays on it
const ROW_TIME = 0.12;
const STAGGER = 0.04;
const DROP = 0.012;
const ROW_GROW = 0.96;
const MORPH_TIME = 0.15;
const KNOB_TIME = 0.15;
const PRESS_SCALE = 0.95;

// A press clicks, a short falling tone, and pulses a controller's haptic actuator
const CLICK_PITCH = 1500;
const CLICK_DROP = 700;
const CLICK_TIME = 0.05;
const CLICK_GAIN = 0.08;
const PULSE_STRENGTH = 0.4;
const PULSE_MS = 25;

const GLASS = 'rgba(20, 22, 28, 0.86)';
// the icon is always in view, so it is fainter than the menu
const ICON_GLASS = 'rgba(20, 22, 28, 0.55)';
const ICON_BARS = 'rgba(255, 255, 255, 0.7)';
const GLASS_HOVER = 'rgba(58, 62, 72, 0.92)';
const GLASS_PRESS = 'rgba(88, 94, 108, 0.96)';
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

// a select held on a quad: whether its ray is still on it, as of the last frame
type Press = {
    source: XrInputSource;
    quad: Quad;
    over: boolean;
    release: () => void;
};

// a controller's gamepad, with the WebXR haptic actuators the dom typings leave out
type HapticGamepad = Gamepad & {
    hapticActuators?: readonly { pulse(value: number, duration: number): Promise<boolean> }[];
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

const ease = (t: number) => t * t * (3 - 2 * t);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// moves value toward goal by step
const approach = (value: number, goal: number, step: number) =>
    value < goal ? Math.min(goal, value + step) : Math.max(goal, value - step);

/**
 * A head-locked menu for XR sessions: a burger icon low in the view, which opens a column of
 * rows in front of the eyes. A select (a pinch, a trigger) presses the icon or a row it starts on,
 * which runs when the select ends still on it, as a button does: sliding off before letting go
 * cancels it. A select anywhere else while the menu is open closes it. A press clicks, pulses a
 * controller, and shows on the quad while the select stays on it; the rows fade in and out, the
 * icon turns into a cross and the switches slide. The viewer hands the menu every select before
 * the navigation aims with it ({@link XrHeadMenu#select}), so the selects it takes do not
 * teleport. It follows the camera, so it also scales with a scaled rig, staying the same size in
 * view. Controllers' rays also highlight what they point at; Apple Vision Pro shows the eyes'
 * direction only as a pinch starts, so nothing highlights there before a press.
 */
class XrHeadMenu {
    private app: AppBase;

    private items: XrHeadMenuItem[];

    private icon: Quad;

    private rows: Quad[];

    private open = false;

    // how far the column is through opening (0 closed, 1 open), the icon's morph into a cross, each
    // switch's knob (0 off, 1 on), and each row's opacity as last set
    private openness = 0;

    private morph = 0;

    private knobs: number[];

    private shown: number[];

    // the hovered quad, highlighted, and the press, if any
    private hovered: Quad | null = null;

    private press: Press | null = null;

    // made on the first press
    private audio: AudioContext | null = null;

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
        this.knobs = items.map((item) => (item.checked?.() ? 1 : 0));
        this.shown = items.map(() => 0);

        const { xr } = app;
        this.handles = [
            xr.on('start', () => this.show(true)),
            xr.on('end', () => this.show(false)),
            app.on('update', (dt: number) => this.update(dt))
        ];
        this.show(xr.active);
    }

    /**
     * Takes a select that starts on the menu, pressing what it starts on, and one anywhere while
     * the menu is open, closing it.
     *
     * @param source - The input source whose select starts.
     * @returns True when the menu took the select.
     */
    select(source: XrInputSource) {
        if (!this.icon.entity.enabled) return false;
        const quad = this.pointedAt(source);
        if (!quad) {
            if (!this.open) return false;
            this.setOpen(false);
            return true;
        }
        // a second select while one is held is taken, and does nothing
        if (!this.press) this.startPress(source, quad);
        return true;
    }

    destroy() {
        this.cancelPress();
        for (const handle of this.handles) handle.off();
        for (const quad of [this.icon, ...this.rows]) {
            quad.entity.destroy();
            quad.material.destroy();
            quad.texture.destroy();
        }
        void this.audio?.close().catch(() => {
            /* already closed */
        });
        this.audio = null;
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

    // the icon, or a row of the open menu, the input source's ray points at
    private pointedAt(source: XrInputSource) {
        rayOrigin.copy(source.getOrigin());
        rayDirection.copy(source.getDirection());
        if (this.hits(this.icon, ICON_HIT)) return this.icon;
        if (!this.open) return null;
        return this.rows.find((row) => row.entity.enabled && this.hits(row, 1)) ?? null;
    }

    private show(visible: boolean) {
        this.icon.entity.enabled = visible;
        this.setOpen(false);
        // a session starts with the menu closed, not closing
        this.openness = 0;
        this.morph = 0;
        this.drawIcon();
        for (const row of this.rows) row.entity.enabled = false;
    }

    private setOpen(open: boolean) {
        this.cancelPress();
        this.open = open;
        this.hovered = null;
        this.drawIcon();
        if (open) this.items.forEach((item, i) => this.drawRow(i));
    }

    private startPress(source: XrInputSource, quad: Quad) {
        const release = () => this.endPress();
        source.once('selectend', release);
        this.press = { source, quad, over: true, release };
        this.feedback(source);
        this.drawQuad(quad);
    }

    // a select ending: runs what it pressed if it ended there. The ray flicks as a pinch lets go,
    // so where it was on the last frame decides
    private endPress() {
        const { press } = this;
        if (!press) return;
        this.press = null;
        press.source.off('selectend', press.release);
        this.drawQuad(press.quad);
        if (!press.over) return;
        if (press.quad === this.icon) {
            this.setOpen(!this.open);
            return;
        }
        const index = this.rows.indexOf(press.quad);
        const item = this.items[index];
        item.action();
        // a switch stays open, its knob sliding to its new state
        if (!item.checked) this.setOpen(false);
    }

    private cancelPress() {
        if (this.press) this.press.over = false;
        this.endPress();
    }

    // a click, and a pulse of a controller's haptics
    private feedback(source: XrInputSource) {
        const actuator = (source.gamepad as HapticGamepad | null)?.hapticActuators?.[0];
        actuator?.pulse(PULSE_STRENGTH, PULSE_MS).catch(() => {
            /* no haptics */
        });

        try {
            this.audio ??= new AudioContext();
        } catch {
            return;
        }
        const { audio } = this;
        if (audio.state === 'suspended') {
            audio.resume().catch(() => {
                /* not allowed yet */
            });
        }
        const t = audio.currentTime;
        const tone = audio.createOscillator();
        tone.frequency.setValueAtTime(CLICK_PITCH, t);
        tone.frequency.exponentialRampToValueAtTime(CLICK_DROP, t + CLICK_TIME);
        const gain = audio.createGain();
        gain.gain.setValueAtTime(CLICK_GAIN, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + CLICK_TIME);
        tone.connect(gain).connect(audio.destination);
        tone.start(t);
        tone.stop(t + CLICK_TIME);
    }

    private update(dt: number) {
        if (!this.icon.entity.enabled) return;
        this.updateHover();
        this.updatePress();
        this.animate(dt);
    }

    // Controllers' rays highlight what they point at; hands' rays do not, as a hand's ray points
    // along the hand rather than where it selects (Apple Vision Pro's look and pinch)
    private updateHover() {
        let hovered: Quad | null = null;
        for (const source of this.app.xr.input.inputSources) {
            if (source.targetRayMode !== 'tracked-pointer' || source.hand) continue;
            hovered = this.pointedAt(source) ?? hovered;
        }
        if (hovered !== this.hovered) {
            const previous = this.hovered;
            this.hovered = hovered;
            if (previous) this.drawQuad(previous);
            if (hovered) this.drawQuad(hovered);
        }
    }

    // whether the press is still on its quad; a source gone without ending its select cancels it
    private updatePress() {
        const { press } = this;
        if (!press) return;
        if (!this.app.xr.input.inputSources.includes(press.source)) {
            this.cancelPress();
            return;
        }
        const over = this.pointedAt(press.source) === press.quad;
        if (over !== press.over) {
            press.over = over;
            this.drawQuad(press.quad);
        }
    }

    private animate(dt: number) {
        // the icon's bars and cross, and its press
        const morph = approach(this.morph, this.open ? 1 : 0, dt / MORPH_TIME);
        if (morph !== this.morph) {
            this.morph = morph;
            this.drawIcon();
        }
        const iconSize = ICON_SIZE * this.pressScale(this.icon);
        this.icon.entity.setLocalScale(iconSize, 1, iconSize);

        // the column: each shown row ROW_TIME after the one above it starts, closing from the bottom
        const shown = this.items.filter((item) => item.visible?.() ?? true).length;
        const total = ROW_TIME + STAGGER * Math.max(shown - 1, 0);
        this.openness = approach(this.openness, this.open ? 1 : 0, dt / total);
        let k = 0;
        let y = MENU_TOP;
        this.items.forEach((item, i) => {
            const row = this.rows[i];
            const visible = item.visible?.() ?? true;
            const t = visible ? Math.min(Math.max((this.openness * total - k * STAGGER) / ROW_TIME, 0), 1) : 0;
            const e = ease(t);
            row.entity.enabled = t > 0;

            // a switch's knob, set at once while the row is hidden
            if (item.checked) {
                const goal = item.checked() ? 1 : 0;
                const knob = row.entity.enabled ? approach(this.knobs[i], goal, dt / KNOB_TIME) : goal;
                if (knob !== this.knobs[i]) {
                    this.knobs[i] = knob;
                    if (row.entity.enabled) this.drawRow(i);
                }
            }

            if (visible) {
                if (row.entity.enabled) {
                    row.entity.setLocalPosition(0, y - ROW_HEIGHT * 0.5 + (1 - e) * DROP, -MENU_DISTANCE);
                    const s = lerp(ROW_GROW, 1, e) * this.pressScale(row);
                    row.entity.setLocalScale(ROW_WIDTH * s, 1, ROW_HEIGHT * s);
                    if (e !== this.shown[i]) {
                        this.shown[i] = e;
                        row.material.opacity = e;
                        row.material.update();
                    }
                }
                y -= ROW_HEIGHT + ROW_GAP;
                k++;
            }
        });
    }

    private pressScale(quad: Quad) {
        return this.press?.quad === quad && this.press.over ? PRESS_SCALE : 1;
    }

    private fill(quad: Quad, normal: string) {
        if (this.press?.quad === quad && this.press.over) return GLASS_PRESS;
        return this.hovered === quad ? GLASS_HOVER : normal;
    }

    private drawQuad(quad: Quad) {
        if (quad === this.icon) {
            this.drawIcon();
        } else {
            this.drawRow(this.rows.indexOf(quad));
        }
    }

    // three bars, the top and bottom turning into a cross and the middle fading as the menu opens
    private drawIcon() {
        const { canvas } = this.icon;
        const ctx = canvas.getContext('2d');
        const s = canvas.width;
        const m = ease(this.morph);
        ctx.clearRect(0, 0, s, s);
        ctx.fillStyle = this.fill(this.icon, ICON_GLASS);
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = ICON_BARS;
        ctx.lineWidth = s * 0.07;
        ctx.lineCap = 'round';
        const d = 0.17;
        const line = (x0: number, y0: number, x1: number, y1: number) => {
            ctx.moveTo(s * x0, s * y0);
            ctx.lineTo(s * x1, s * y1);
        };
        ctx.beginPath();
        line(lerp(0.32, 0.5 - d, m), lerp(0.35, 0.5 - d, m), lerp(0.68, 0.5 + d, m), lerp(0.35, 0.5 + d, m));
        line(lerp(0.32, 0.5 - d, m), lerp(0.65, 0.5 + d, m), lerp(0.68, 0.5 + d, m), lerp(0.65, 0.5 - d, m));
        ctx.stroke();
        if (m < 1) {
            ctx.globalAlpha = 1 - m;
            ctx.beginPath();
            line(lerp(0.32, 0.5, m), 0.5, lerp(0.68, 0.5, m), 0.5);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        this.upload(this.icon);
    }

    private drawRow(index: number) {
        const row = this.rows[index];
        const item = this.items[index];
        const { canvas } = row;
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = this.fill(row, GLASS);
        roundRect(ctx, 1, 1, width - 2, height - 2, height * 0.3);

        // the label, made smaller where it would run into the switch or off the row
        const w = height * 0.8;
        const x = width - height * 0.3 - w;
        const left = height * 0.36;
        const room = item.checked ? x - height * 0.2 - left : width - 2 * left;
        const label = item.label();
        const font = (size: number) => `500 ${size}px -apple-system, system-ui, sans-serif`;
        const size = Math.round(height * 0.36);
        ctx.font = font(size);
        const measured = ctx.measureText(label).width;
        if (measured > room) ctx.font = font(Math.floor((size * room) / measured));
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, left, height / 2);
        if (item.checked) {
            // a switch at the end, its track blending to green as the knob slides across
            const k = ease(this.knobs[index]);
            const h = height * 0.44;
            const y = (height - h) / 2;
            ctx.fillStyle = OFF;
            roundRect(ctx, x, y, w, h, h / 2);
            ctx.globalAlpha = k;
            ctx.fillStyle = ON;
            roundRect(ctx, x, y, w, h, h / 2);
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(lerp(x + h / 2, x + w - h / 2, k), height / 2, h * 0.4, 0, Math.PI * 2);
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
