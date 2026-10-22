import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NORMAL,
    Entity,
    Mat4,
    PIXELFORMAT_SRGBA8,
    Quat,
    StandardMaterial,
    Texture,
    Vec3
} from 'playcanvas';
import type { AppBase, XrInputSource } from 'playcanvas';

import { XR_OVERLAY_DRAW_BUCKET } from './xr-teleport-arc';

// The menu's rows, a column centred on its anchor (meters, at real size), each ROW_HEIGHT tall and
// drawn at PIXELS per meter: a hand's length across, read from about 40 cm
const ROW_WIDTH = 0.12;
const ROW_HEIGHT = 0.024;
const ROW_GAP = 0.004;
const PIXELS = 4000;

// Where the menu shows, as the engine's XrMenu script does it: an open hand, at least FINGERS_OPEN
// of its four fingers' tips more than FINGER_REACH from their knuckles, its palm facing the eyes
// within PALM_FACING (the cosine), puts the menu PALM_OFFSET out from the middle of the palm,
// facing the eyes; a controller's TOGGLE_BUTTON opens and closes it on that controller,
// CONTROLLER_OFFSET towards the user. It follows its anchor at FOLLOW_SPEED (a lerp a second)
const FINGER_REACH = 0.06;
const FINGERS_OPEN = 3;
const PALM_FACING = 0.6;
const PALM_OFFSET = 0.06;
const CONTROLLER_OFFSET = 0.06;
const TOGGLE_BUTTON = 4;
const FOLLOW_SPEED = 25;

// The other hand's index fingertip pokes a row: within POKE_HOVER in front of it, it highlights
// it, and closer than POKE_PRESS (or through it, up to POKE_BEHIND) it presses it, once: the next
// press waits for the fingertip to be back more than POKE_RELEASE in front of the menu's plane,
// and POKE_COOLDOWN seconds. A poked row shows pressed for POKE_FLASH seconds
const POKE_HOVER = 0.03;
const POKE_PRESS = 0.006;
const POKE_BEHIND = 0.03;
const POKE_RELEASE = 0.015;
const POKE_COOLDOWN = 0.3;
const POKE_FLASH = 0.15;

// The rows fade and drop in over ROW_TIME seconds each, STAGGER apart down the column, from DROP
// above and at ROW_GROW of their size; closing plays it back from the bottom row. A switch's knob
// slides over KNOB_TIME. A pressed quad shrinks to PRESS_SCALE while the select stays on it
const ROW_TIME = 0.12;
const STAGGER = 0.04;
const DROP = 0.004;
const ROW_GROW = 0.96;
const KNOB_TIME = 0.15;
const PRESS_SCALE = 0.95;
// the pointing cursor: a dot where a controller's ray meets the menu's plane, shown within
// CURSOR_REACH of the column's middle while the menu is open
const CURSOR_SIZE = 0.004;
const CURSOR_REACH = 0.15;

// A press clicks, a short falling tone, and pulses a controller's haptic actuator
const CLICK_PITCH = 1500;
const CLICK_DROP = 700;
const CLICK_TIME = 0.05;
const CLICK_GAIN = 0.08;
const PULSE_STRENGTH = 0.4;
const PULSE_MS = 25;

const GLASS = 'rgba(20, 22, 28, 0.86)';
const GLASS_HOVER = 'rgba(58, 62, 72, 0.92)';
const GLASS_PRESS = 'rgba(88, 94, 108, 0.96)';
const ON = '#4cc38a';
const OFF = 'rgba(255, 255, 255, 0.28)';

const FINGERS = ['index', 'middle', 'ring', 'pinky'];

// a submenu's first row, back to the main page
const BACK = '‹  Back';

/** A stepper's moves, down (-1) or up (1), and whether each can be made from where it is. */
type XrPalmMenuStepper = {
    step: (direction: -1 | 1) => void;
    can: (direction: -1 | 1) => boolean;
};

/**
 * A row of the menu: a button, a switch when it has `checked`, or a stepper when it has `stepper`:
 * an arrow either side of its label, the row's left half stepping down and its right half up. A
 * row with a `submenu` opens it in the menu's place, its first row going back.
 */
type XrPalmMenuItem = {
    label: () => string;
    action?: () => void;
    checked?: () => boolean;
    stepper?: XrPalmMenuStepper;
    submenu?: XrPalmMenuItem[];
    visible?: () => boolean;
};

type Quad = {
    entity: Entity;
    canvas: HTMLCanvasElement;
    texture: Texture;
    material: StandardMaterial;
};

// a select held on a row, on a stepper's half (0 elsewhere): whether its ray is still there, as
// of the last frame
type Press = {
    source: XrInputSource;
    quad: Quad;
    side: Side;
    over: boolean;
    release: () => void;
};

// the half of a stepper's row, left (-1) or right (1), and 0 for the other rows
type Side = -1 | 0 | 1;

// a controller's gamepad, with the WebXR haptic actuators the dom typings leave out
type HapticGamepad = Gamepad & {
    hapticActuators?: readonly { pulse(value: number, duration: number): Promise<boolean> }[];
};

const rayOrigin = new Vec3();
const rayDirection = new Vec3();
const localOrigin = new Vec3();
const localDirection = new Vec3();
const inverse = new Mat4();
const along = new Vec3();
const across = new Vec3();
const normal = new Vec3();
const target = new Vec3();
const toEyes = new Vec3();
const position = new Vec3();
const rotation = new Quat();

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

// A quad of a canvas, drawn as painted over the scene, a child of `parent` facing its +z, hidden;
// width and height in meters, drawn at `pixels` per meter
const createQuad = (app: AppBase, parent: Entity, width: number, height: number, pixels: number): Quad => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * pixels);
    canvas.height = Math.round(height * pixels);
    // the canvas holds srgb colours, which a linear texture would brighten on the way out
    const texture = new Texture(app.graphicsDevice, {
        name: 'sse-xr-quad',
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

    const entity = new Entity('XrQuad', app);
    entity.addComponent('render', { type: 'plane', castShadows: false, receiveShadows: false });
    entity.render.material = material;
    for (const meshInstance of entity.render.meshInstances) meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
    // the plane lies flat facing up; stood up, it faces the parent's +z
    entity.setLocalEulerAngles(90, 0, 0);
    entity.setLocalScale(width, 1, height);
    entity.enabled = false;
    parent.addChild(entity);
    return { entity, canvas, texture, material };
};

const uploadQuad = (quad: Quad) => {
    quad.texture.setSource(quad.canvas);
    quad.texture.upload();
};

/**
 * A menu for XR sessions held in the hand, shown and placed as the engine's XrMenu script does:
 * an open palm facing the eyes shows it just out from the palm, facing the eyes, the left hand's
 * when it is tracked and the other's otherwise; with controllers, the menu button of the left one
 * (or the other) opens and closes it on that controller. The other hand's index fingertip pokes a
 * row to press it. A controller's ray points at a row, highlighting it and showing a dot where it
 * meets the menu, and its select presses the row it starts on, which runs when the select ends
 * still on it, as a button does: sliding off before letting go cancels it; Apple Vision Pro's
 * look-and-pinch presses the same way. The viewer hands the menu every select before the
 * navigation aims with it ({@link XrPalmMenu#select}), so the selects it takes do not teleport.
 * A press clicks, pulses a controller, and shows on the row; the rows fade in and out and the
 * switches slide. A stepper's halves are buttons of their own, and one that cannot step is greyed
 * out and takes no press. A submenu's row shows its page in the menu's place, a Back row at its
 * top. The menu scales with a scaled rig, staying the size of the hand.
 */
class XrPalmMenu {
    private app: AppBase;

    private camera: Entity;

    // the rows of every page, the main page's first, the page each is on, and the page a submenu's
    // row opens; the page shown, 0 the main one
    private items: XrPalmMenuItem[] = [];

    private pageOf: number[] = [];

    private submenuPage = new Map<XrPalmMenuItem, number>();

    private page = 0;

    // the column's parent, placed at the anchor and facing the eyes
    private container: Entity;

    // a dot per pointing ray, where it meets the menu's plane
    private cursors: Quad[];

    private rows: Quad[];

    // the hand or controller the menu shows on, and whether its toggle button was down last frame
    private anchor: XrInputSource | null = null;

    private toggleWasDown = false;

    private open = false;

    // how far the column is through opening (0 closed, 1 open), each switch's knob (0 off, 1 on),
    // and each row's opacity as last set
    private openness = 0;

    private knobs: number[];

    private shown: number[];

    // the hovered row, highlighted, and its half where it is a stepper's
    private hovered: Quad | null = null;

    private hoveredSide: Side = 0;

    // across the row, -0.5 to 0.5 left to right, where the last ray or fingertip to hit one met it
    private hitX = 0;

    // a select held on a row
    private press: Press | null = null;

    // the poked row, shown pressed until flashUntil; whether the fingertip has drawn back since the
    // last poke, and when that poke was
    private flash: Quad | null = null;

    private flashUntil = 0;

    private pokeReady = true;

    private pokeTime = -Infinity;

    private time = 0;

    // made on the first press
    private audio: AudioContext | null = null;

    private handles: { off(): void }[];

    /**
     * @param app - The application.
     * @param camera - The XR camera's entity, which the menu faces; its parent is the rig, whose
     * scale the menu takes.
     * @param items - The menu's rows, top to bottom.
     */
    constructor(app: AppBase, camera: Entity, items: XrPalmMenuItem[]) {
        this.app = app;
        this.camera = camera;
        const add = (item: XrPalmMenuItem, page: number) => {
            this.items.push(item);
            this.pageOf.push(page);
        };
        for (const item of items) add(item, 0);
        for (const item of items) {
            if (!item.submenu) continue;
            const page = this.submenuPage.size + 1;
            this.submenuPage.set(item, page);
            add({ label: () => BACK, action: () => this.setPage(0) }, page);
            for (const row of item.submenu) add(row, page);
        }

        this.container = new Entity('XrPalmMenu', app);
        app.root.addChild(this.container);
        this.rows = this.items.map(() => this.createQuad(ROW_WIDTH, ROW_HEIGHT));
        this.knobs = this.items.map((item) => (item.checked?.() ? 1 : 0));
        this.shown = this.items.map(() => 0);
        this.cursors = [0, 1].map(() => this.createQuad(CURSOR_SIZE, CURSOR_SIZE));
        for (const cursor of this.cursors) this.drawCursor(cursor);

        const { xr } = app;
        this.handles = [
            xr.on('start', () => this.hide()),
            xr.on('end', () => this.hide()),
            app.on('update', (dt: number) => this.update(dt))
        ];
        this.hide();
    }

    /**
     * Takes a select that starts on a row of the open menu, pressing it. A hand's select is left
     * alone: its fingertip pokes instead.
     *
     * @param source - The input source whose select starts.
     * @returns True when the menu took the select.
     */
    select(source: XrInputSource) {
        if (!this.open || source.hand) return false;
        const quad = this.pointedAt(source);
        if (!quad) return false;
        // a second select while one is held is taken, and does nothing, as is one on a stepper's
        // greyed half
        const side = this.sideOf(quad);
        const stepper = this.itemOf(quad)?.stepper;
        if (!this.press && !(stepper && !stepper.can(side as -1 | 1))) this.startPress(source, quad, side);
        return true;
    }

    destroy() {
        this.cancelPress();
        for (const handle of this.handles) handle.off();
        for (const quad of [...this.rows, ...this.cursors]) {
            quad.material.destroy();
            quad.texture.destroy();
        }
        this.container.destroy();
        void this.audio?.close().catch(() => {
            /* already closed */
        });
        this.audio = null;
    }

    private createQuad(width: number, height: number): Quad {
        return createQuad(this.app, this.container, width, height, PIXELS);
    }

    // the point in the quad's space, its plane at y = 0, its front at y > 0 and its size 1 across
    // in x and z; y is in meters at real size
    private toQuad(quad: Quad, point: Vec3, out: Vec3) {
        inverse.copy(quad.entity.getWorldTransform()).invert();
        return inverse.transformPoint(point, out);
    }

    // whether the ray meets a row, from its front
    private hits(quad: Quad) {
        inverse.copy(quad.entity.getWorldTransform()).invert();
        const origin = inverse.transformPoint(rayOrigin, localOrigin);
        const direction = inverse.transformVector(rayDirection, localDirection);
        if (origin.y <= 0 || direction.y >= 0) return false;
        const t = -origin.y / direction.y;
        const x = origin.x + direction.x * t;
        if (Math.abs(x) > 0.5 || Math.abs(origin.z + direction.z * t) > 0.5) return false;
        this.hitX = x;
        return true;
    }

    private itemOf(quad: Quad) {
        const index = this.rows.indexOf(quad);
        return index >= 0 ? this.items[index] : null;
    }

    // the half of a stepper's row the last hit was on, just after it was found
    private sideOf(quad: Quad): Side {
        if (!this.itemOf(quad)?.stepper) return 0;
        return this.hitX < 0 ? -1 : 1;
    }

    // the row of the open menu the input source's ray points at
    private pointedAt(source: XrInputSource) {
        if (!this.open) return null;
        rayOrigin.copy(source.getOrigin());
        rayDirection.copy(source.getDirection());
        return this.rows.find((row) => row.entity.enabled && this.hits(row)) ?? null;
    }

    // closed at once, on the main page, as a session starts and ends. Closing the hand keeps the
    // page, so a submenu is where it was when the hand opens again
    private hide() {
        this.setOpen(false);
        this.openness = 0;
        this.page = 0;
        this.anchor = null;
        this.toggleWasDown = false;
        for (const row of this.rows) row.entity.enabled = false;
        for (const cursor of this.cursors) cursor.entity.enabled = false;
    }

    private setOpen(open: boolean) {
        if (open === this.open) return;
        this.cancelPress();
        this.open = open;
        this.hovered = null;
        this.hoveredSide = 0;
        this.flash = null;
        if (open) {
            this.items.forEach((item, i) => this.drawRow(i));
            // shown where its anchor is, rather than flying there from where it was last
            if (this.anchor && this.anchorPose(this.anchor)) {
                this.container.setPosition(position);
                this.container.setRotation(rotation);
            }
        }
    }

    // shows another page in the menu's place, its rows dropping in as on opening
    private setPage(page: number) {
        this.page = page;
        this.openness = 0;
        this.hovered = null;
        this.hoveredSide = 0;
        this.flash = null;
        this.items.forEach((item, i) => {
            if (this.pageOf[i] === page) this.drawRow(i);
        });
    }

    // whether a row is shown: on the page shown, and visible
    private showing(index: number) {
        return this.pageOf[index] === this.page && (this.items[index].visible?.() ?? true);
    }

    private startPress(source: XrInputSource, quad: Quad, side: Side) {
        const release = () => this.endPress();
        source.once('selectend', release);
        this.press = { source, quad, side, over: true, release };
        this.feedback(source);
        this.drawRow(this.rows.indexOf(quad));
    }

    // a select ending: runs what it pressed if it ended there. The ray flicks as a pinch lets go,
    // so where it was on the last frame decides
    private endPress() {
        const { press } = this;
        if (!press) return;
        this.press = null;
        press.source.off('selectend', press.release);
        this.drawRow(this.rows.indexOf(press.quad));
        if (press.over) this.run(this.rows.indexOf(press.quad), press.side);
    }

    private cancelPress() {
        if (this.press) this.press.over = false;
        this.endPress();
    }

    // runs a row. The label is redrawn at once, as the action can change it without moving a
    // switch's knob (the sharpen cycle)
    private run(index: number, side: Side) {
        const item = this.items[index];
        const page = this.submenuPage.get(item);
        if (page !== undefined) {
            this.setPage(page);
            return;
        }
        if (item.stepper) {
            item.stepper.step(side as -1 | 1);
        } else {
            item.action?.();
        }
        if (this.open) this.drawRow(index);
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
        if (!this.app.xr.active) return;
        this.time += dt;
        this.updateAnchor();
        this.follow(dt);
        this.updateHover();
        this.updateCursors();
        this.updatePress();
        this.animate(dt);
    }

    // the rig's scale, which the menu takes
    private get scale() {
        return (this.camera.parent as Entity | null)?.getScale().x ?? 1;
    }

    // the left hand or controller when it is in use, else the other: a hand that has lost tracking
    // stays an input source, and would keep the menu closed on the other
    private preferred() {
        const usable = this.app.xr.input.inputSources.filter(
            (source) => source.handedness !== 'none' && (!source.hand || source.hand.tracking)
        );
        return usable.find((source) => source.handedness === 'left') ?? usable[0] ?? null;
    }

    // opens the menu on an open palm facing the eyes, or on a controller's toggle button
    private updateAnchor() {
        const source = this.preferred();
        if (source !== this.anchor) {
            this.anchor = source;
            this.toggleWasDown = false;
            this.setOpen(false);
        }
        if (!source) return;
        if (source.hand) {
            this.setOpen(this.palmFacing(source));
            return;
        }
        const down = !!source.gamepad?.buttons[TOGGLE_BUTTON]?.pressed;
        if (down && !this.toggleWasDown) this.setOpen(!this.open);
        this.toggleWasDown = down;
    }

    // the palm's normal into `normal`, out of the palm, or false when the hand is not tracked
    private palmNormal(source: XrInputSource) {
        const hand = source.hand;
        if (!hand?.tracking) return false;
        const middle = hand.getJointById('middle-finger-metacarpal');
        const index = hand.getJointById('index-finger-metacarpal');
        const pinky = hand.getJointById('pinky-finger-metacarpal');
        if (!middle || !index || !pinky) return false;
        along.sub2(middle.getPosition(), hand.wrist.getPosition());
        across.sub2(pinky.getPosition(), index.getPosition());
        normal.cross(along, across).normalize();
        if (source.handedness === 'left') normal.mulScalar(-1);
        return true;
    }

    private palmFacing(source: XrInputSource) {
        const hand = source.hand;
        if (!hand?.tracking) return false;
        const reach = FINGER_REACH * this.scale;
        let open = 0;
        for (const finger of FINGERS) {
            const tip = hand.getJointById(`${finger}-finger-tip`);
            const knuckle = hand.getJointById(`${finger}-finger-metacarpal`);
            if (tip && knuckle && tip.getPosition().distance(knuckle.getPosition()) > reach) open++;
        }
        if (open < FINGERS_OPEN || !this.palmNormal(source)) return false;
        return normal.dot(this.camera.forward) < -PALM_FACING;
    }

    // where the menu goes for its anchor, into `position` and `rotation`: out from the middle of
    // a palm facing the eyes, or towards the user from a controller, turned as it is
    private anchorPose(source: XrInputSource) {
        const scale = this.scale;
        const hand = source.hand;
        if (hand) {
            const knuckle = hand.getJointById('middle-finger-metacarpal');
            const proximal = hand.getJointById('middle-finger-phalanx-proximal');
            if (!knuckle || !proximal || !this.palmNormal(source)) return false;
            position.lerp(knuckle.getPosition(), proximal.getPosition(), 0.5);
            position.add(target.copy(normal).mulScalar(PALM_OFFSET * scale));
            toEyes.sub2(this.camera.getPosition(), position);
            if (toEyes.lengthSq() > 1e-6) {
                toEyes.normalize();
                const yaw = Math.atan2(toEyes.x, toEyes.z) * (180 / Math.PI);
                const pitch = -Math.asin(toEyes.y) * (180 / Math.PI);
                rotation.setFromEulerAngles(pitch, yaw, 0);
            }
            return true;
        }
        if (!source.grip) return false;
        rotation.copy(source.getRotation());
        rotation.transformVector(target.set(0, 0, CONTROLLER_OFFSET * scale), target);
        position.add2(source.getPosition(), target);
        return true;
    }

    // the container eases towards its anchor while the menu shows, at the rig's scale
    private follow(dt: number) {
        if ((!this.open && this.openness <= 0) || !this.anchor || !this.anchorPose(this.anchor)) return;
        const { container } = this;
        const t = Math.min(1, FOLLOW_SPEED * dt);
        container.setPosition(target.lerp(container.getPosition(), position, t));
        container.setRotation(rotation.slerp(container.getRotation(), rotation, t));
        const s = this.scale;
        container.setLocalScale(s, s, s);
    }

    // whether a source's ray points at the menu: a controller's
    private pointing(source: XrInputSource) {
        return source.targetRayMode === 'tracked-pointer' && !source.hand;
    }

    // controllers' rays, and the other hand's fingertip, highlight the row they are on; the
    // fingertip presses it
    private updateHover() {
        let hovered: Quad | null = null;
        let side: Side = 0;
        if (this.open) {
            for (const source of this.app.xr.input.inputSources) {
                if (!this.pointing(source)) continue;
                const quad = this.pointedAt(source);
                if (quad) {
                    hovered = quad;
                    side = this.sideOf(quad);
                }
            }
            if (!hovered && this.anchor?.hand) {
                const poked = this.poke(this.anchor);
                if (poked) {
                    hovered = poked;
                    side = this.sideOf(poked);
                }
            }
        }
        if (this.flash && this.time >= this.flashUntil) {
            const flashed = this.flash;
            this.flash = null;
            this.drawRow(this.rows.indexOf(flashed));
        }
        if (hovered !== this.hovered || side !== this.hoveredSide) {
            const previous = this.hovered;
            this.hovered = hovered;
            this.hoveredSide = side;
            if (previous && previous !== hovered) this.drawRow(this.rows.indexOf(previous));
            if (hovered) this.drawRow(this.rows.indexOf(hovered));
        }
    }

    // the row the other hand's index fingertip is on, pressing it once it reaches it
    private poke(anchor: XrInputSource) {
        const poking = this.app.xr.input.inputSources.find((source) => source !== anchor && source.hand?.tracking);
        const tip = poking?.hand.getJointById('index-finger-tip');
        if (!poking || !tip) {
            this.pokeReady = true;
            return null;
        }
        // the next press waits for the fingertip to be back in front of the menu's plane: one pushed
        // through a row and drawn back out would otherwise press it again on the way
        inverse.copy(this.container.getWorldTransform()).invert();
        if (inverse.transformPoint(tip.getPosition(), localDirection).z > POKE_RELEASE) this.pokeReady = true;
        let quad: Quad | null = null;
        let depth = Infinity;
        for (const row of this.rows) {
            if (!row.entity.enabled) continue;
            const local = this.toQuad(row, tip.getPosition(), localOrigin);
            if (Math.abs(local.x) > 0.5 || Math.abs(local.z) > 0.5) continue;
            if (local.y > POKE_HOVER || local.y < -POKE_BEHIND || local.y >= depth) continue;
            quad = row;
            depth = local.y;
            this.hitX = local.x;
        }
        if (!quad) return null;
        if (depth < POKE_PRESS && this.pokeReady && this.time - this.pokeTime >= POKE_COOLDOWN) {
            this.pokeReady = false;
            this.pokeTime = this.time;
            const side = this.sideOf(quad);
            const stepper = this.itemOf(quad)?.stepper;
            if (!(stepper && !stepper.can(side as -1 | 1))) {
                this.feedback(poking);
                this.flash = quad;
                this.flashUntil = this.time + POKE_FLASH;
                this.run(this.rows.indexOf(quad), side);
            }
        }
        return quad;
    }

    // a dot where each controller's ray meets the menu's plane near the column, while it is open:
    // without it a ray gives no sign of where it points
    private updateCursors() {
        let used = 0;
        if (this.open) {
            inverse.copy(this.container.getWorldTransform()).invert();
            for (const source of this.app.xr.input.inputSources) {
                if (used >= this.cursors.length) break;
                if (!this.pointing(source)) continue;
                const origin = inverse.transformPoint(source.getOrigin(), localOrigin);
                const direction = inverse.transformVector(source.getDirection(), localDirection);
                if (direction.z >= 0 || origin.z <= 0) continue;
                const t = -origin.z / direction.z;
                const x = origin.x + direction.x * t;
                const y = origin.y + direction.y * t;
                if (Math.hypot(x, y) > CURSOR_REACH) continue;
                const cursor = this.cursors[used++];
                cursor.entity.enabled = true;
                // a touch in front of the rows
                cursor.entity.setLocalPosition(x, y, 0.001);
            }
        }
        for (let i = used; i < this.cursors.length; i++) this.cursors[i].entity.enabled = false;
    }

    // whether the press is still on its row; a source gone without ending its select cancels it
    private updatePress() {
        const { press } = this;
        if (!press) return;
        if (!this.app.xr.input.inputSources.includes(press.source)) {
            this.cancelPress();
            return;
        }
        const over = this.pointedAt(press.source) === press.quad && this.sideOf(press.quad) === press.side;
        if (over !== press.over) {
            press.over = over;
            this.drawRow(this.rows.indexOf(press.quad));
        }
    }

    private animate(dt: number) {
        // the column: each shown row ROW_TIME after the one above it starts, closing from the bottom
        const shown = this.items.filter((_, i) => this.showing(i)).length;
        const total = ROW_TIME + STAGGER * Math.max(shown - 1, 0);
        this.openness = approach(this.openness, this.open ? 1 : 0, dt / total);
        let k = 0;
        let y = 0.5 * (shown * ROW_HEIGHT + Math.max(shown - 1, 0) * ROW_GAP);
        this.items.forEach((item, i) => {
            const row = this.rows[i];
            const visible = this.showing(i);
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
                    row.entity.setLocalPosition(0, y - ROW_HEIGHT * 0.5 + (1 - e) * DROP, 0);
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

    private pressed(quad: Quad) {
        return (this.press?.quad === quad && this.press.over) || this.flash === quad;
    }

    private pressScale(quad: Quad) {
        return this.pressed(quad) ? PRESS_SCALE : 1;
    }

    private fill(quad: Quad, normalFill: string) {
        if (this.pressed(quad)) return GLASS_PRESS;
        return this.hovered === quad ? GLASS_HOVER : normalFill;
    }

    private drawRow(index: number) {
        const row = this.rows[index];
        const item = this.items[index];
        if (item.stepper) {
            this.drawStepper(row, item, item.stepper);
            return;
        }
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

    // the label centred between two arrows, the hovered or pressed half lit, an arrow that cannot
    // step greyed out
    private drawStepper(row: Quad, item: XrPalmMenuItem, stepper: XrPalmMenuStepper) {
        const { canvas } = row;
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = GLASS;
        roundRect(ctx, 1, 1, width - 2, height - 2, height * 0.3);
        const pressed =
            this.press?.quad === row && this.press.over ? this.press.side : this.flash === row ? this.hoveredSide : 0;
        const lit = pressed || (this.hovered === row ? this.hoveredSide : 0);
        if (lit && stepper.can(lit as -1 | 1)) {
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(1, 1, width - 2, height - 2, height * 0.3);
            ctx.clip();
            ctx.fillStyle = pressed ? GLASS_PRESS : GLASS_HOVER;
            ctx.fillRect(lit < 0 ? 0 : width / 2, 0, width / 2, height);
            ctx.restore();
        }

        // the arrows, chevrons pointing out from the label
        const inset = height * 0.45;
        const reach = height * 0.09;
        const rise = height * 0.15;
        ctx.lineWidth = height * 0.06;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const direction of [-1, 1] as const) {
            const tip = direction < 0 ? inset : width - inset;
            ctx.strokeStyle = stepper.can(direction) ? '#ffffff' : OFF;
            ctx.beginPath();
            ctx.moveTo(tip - direction * reach, height / 2 - rise);
            ctx.lineTo(tip, height / 2);
            ctx.lineTo(tip - direction * reach, height / 2 + rise);
            ctx.stroke();
        }

        // the label, made smaller where it would run into the arrows
        const room = width - 2 * (inset + height * 0.35);
        const label = item.label();
        const font = (size: number) => `500 ${size}px -apple-system, system-ui, sans-serif`;
        const size = Math.round(height * 0.36);
        ctx.font = font(size);
        const measured = ctx.measureText(label).width;
        if (measured > room) ctx.font = font(Math.floor((size * room) / measured));
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, width / 2, height / 2);
        ctx.textAlign = 'start';
        this.upload(row);
    }

    // a white dot with a dark rim
    private drawCursor(quad: Quad) {
        const { canvas } = quad;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const r = canvas.width * 0.5;
        ctx.beginPath();
        ctx.arc(r, r, r * 0.9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20, 22, 28, 0.9)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(r, r, r * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        this.upload(quad);
    }

    private upload(quad: Quad) {
        uploadQuad(quad);
    }
}

export { createQuad, uploadQuad, XrPalmMenu };
export type { Quad, XrPalmMenuItem };
