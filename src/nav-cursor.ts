import { Vec3 } from 'playcanvas';
import type { AppBase, Entity, EventHandler } from 'playcanvas';

import type { Collision } from './collision';
import type { State } from './types';

const SVGNS = 'http://www.w3.org/2000/svg';
const NUM_SAMPLES = 12;
const BASE_OUTER_RADIUS = 0.2;
const INNER_OUTER_RATIO = 0.17 / 0.2;
const BEZIER_K = 1 / 6;
const NORMAL_SMOOTH_FACTOR = 0.25;
const NORMAL_SNAP_ANGLE = Math.PI / 4;
const NORMAL_EPSILON = 1e-6;

const createNormalSnapDirections = () => {
    const result: Vec3[] = [];

    for (let pitchStep = -2; pitchStep <= 2; pitchStep++) {
        const pitch = pitchStep * NORMAL_SNAP_ANGLE;
        const cp = Math.cos(pitch);
        const sy = Math.sin(pitch);

        if (Math.abs(cp) <= NORMAL_EPSILON) {
            result.push(new Vec3(0, sy > 0 ? 1 : -1, 0));
            continue;
        }

        for (let yawStep = 0; yawStep < 8; yawStep++) {
            const yaw = yawStep * NORMAL_SNAP_ANGLE;
            result.push(new Vec3(Math.cos(yaw) * cp, sy, Math.sin(yaw) * cp));
        }
    }

    return result;
};

const NORMAL_SNAP_DIRECTIONS = createNormalSnapDirections();

const snapNormal = (nx: number, ny: number, nz: number, out: Vec3) => {
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len <= NORMAL_EPSILON) {
        return out.set(0, 1, 0);
    }

    const invLen = 1 / len;
    const x = nx * invLen;
    const y = ny * invLen;
    const z = nz * invLen;
    let best = NORMAL_SNAP_DIRECTIONS[0];
    let bestDot = -Infinity;

    for (let i = 0; i < NORMAL_SNAP_DIRECTIONS.length; i++) {
        const candidate = NORMAL_SNAP_DIRECTIONS[i];
        const dot = candidate.x * x + candidate.y * y + candidate.z * z;
        if (dot > bestDot) {
            bestDot = dot;
            best = candidate;
        }
    }

    return out.copy(best);
};

const PINPOINT_RING_RADIUS = 14;
const PINPOINT_DOT_RADIUS = 3.4;
const PINPOINT_DOT_HALO_RADIUS = 4.9;
const PINPOINT_ENTER_MS = 300;
const PINPOINT_EXIT_MS = 200;
const PINPOINT_EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const PINPOINT_EASE_IN = 'cubic-bezier(0.55, 0.055, 0.675, 0.19)';

const prefersReducedMotion = () =>
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

const tmpV = new Vec3();
const tmpView = new Vec3();
const tmpScreen = new Vec3();
const tangent = new Vec3();
const bitangent = new Vec3();
const worldPt = new Vec3();
const up = new Vec3(0, 1, 0);
const right = new Vec3(1, 0, 0);

type CursorTarget = {
    position: Vec3;
    normal: Vec3;
};

type TargetMode = 'walk' | 'fly' | 'orbit';

const buildBezierRing = (sx: ArrayLike<number>, sy: ArrayLike<number>) => {
    const n = sx.length;
    let p = `M${sx[0].toFixed(1)},${sy[0].toFixed(1)}`;
    for (let i = 0; i < n; i++) {
        const i0 = (i - 1 + n) % n;
        const i1 = i;
        const i2 = (i + 1) % n;
        const i3 = (i + 2) % n;
        const cp1x = sx[i1] + (sx[i2] - sx[i0]) * BEZIER_K;
        const cp1y = sy[i1] + (sy[i2] - sy[i0]) * BEZIER_K;
        const cp2x = sx[i2] - (sx[i3] - sx[i1]) * BEZIER_K;
        const cp2y = sy[i2] - (sy[i3] - sy[i1]) * BEZIER_K;
        p += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${sx[i2].toFixed(1)},${sy[i2].toFixed(1)}`;
    }
    return `${p} Z`;
};

class CursorRing {
    private path: SVGPathElement;

    private svg: SVGSVGElement;

    private camera: Entity;

    private smoothing: boolean;

    private smoothNx = 0;

    private smoothNy = 1;

    private smoothNz = 0;

    private hasSmoothedNormal = false;

    private readonly outerX = new Float64Array(NUM_SAMPLES);

    private readonly outerY = new Float64Array(NUM_SAMPLES);

    private readonly innerX = new Float64Array(NUM_SAMPLES);

    private readonly innerY = new Float64Array(NUM_SAMPLES);

    constructor(svg: SVGSVGElement, camera: Entity, smoothing: boolean) {
        this.svg = svg;
        this.camera = camera;
        this.smoothing = smoothing;

        this.path = document.createElementNS(SVGNS, 'path');
        this.path.setAttribute('fill', 'white');
        this.path.setAttribute('fill-opacity', '0.6');
        this.path.setAttribute('fill-rule', 'evenodd');
        this.path.setAttribute('stroke', 'none');
        this.path.style.display = 'none';
        svg.appendChild(this.path);
    }

    private projectCircle(
        px: number,
        py: number,
        pz: number,
        nx: number,
        ny: number,
        nz: number,
        radius: number,
        outX: Float64Array,
        outY: Float64Array
    ) {
        const normal = tmpV.set(nx, ny, nz);
        if (Math.abs(normal.y) < 0.99) {
            tangent.cross(normal, up).normalize();
        } else {
            tangent.cross(normal, right).normalize();
        }
        bitangent.cross(normal, tangent);

        const cam = this.camera.camera;
        const angleStep = (2 * Math.PI) / NUM_SAMPLES;

        for (let i = 0; i < NUM_SAMPLES; i++) {
            const theta = i * angleStep;
            const ct = Math.cos(theta);
            const st = Math.sin(theta);

            const tx = ct * tangent.x + st * bitangent.x;
            const ty = ct * tangent.y + st * bitangent.y;
            const tz = ct * tangent.z + st * bitangent.z;

            worldPt.set(px + tx * radius, py + ty * radius, pz + tz * radius);
            cam.worldToScreen(worldPt, tmpScreen);
            outX[i] = tmpScreen.x;
            outY[i] = tmpScreen.y;
        }
    }

    render(pos: Vec3, normal: Vec3) {
        snapNormal(normal.x, normal.y, normal.z, tmpV);
        let nx = tmpV.x;
        let ny = tmpV.y;
        let nz = tmpV.z;

        if (this.smoothing) {
            if (this.hasSmoothedNormal) {
                const t = NORMAL_SMOOTH_FACTOR;
                nx = this.smoothNx + (nx - this.smoothNx) * t;
                ny = this.smoothNy + (ny - this.smoothNy) * t;
                nz = this.smoothNz + (nz - this.smoothNz) * t;
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (len > 1e-6) {
                    const invLen = 1.0 / len;
                    nx *= invLen;
                    ny *= invLen;
                    nz *= invLen;
                }
            }
            this.smoothNx = nx;
            this.smoothNy = ny;
            this.smoothNz = nz;
            this.hasSmoothedNormal = true;
        }

        const outerRadius = BASE_OUTER_RADIUS;
        const innerRadius = outerRadius * INNER_OUTER_RATIO;

        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, outerRadius, this.outerX, this.outerY);
        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, innerRadius, this.innerX, this.innerY);

        this.path.setAttribute(
            'd',
            `${buildBezierRing(this.outerX, this.outerY)} ${buildBezierRing(this.innerX, this.innerY)}`
        );
        this.path.style.display = '';
        this.svg.style.display = '';
    }

    hide() {
        this.path.style.display = 'none';
        this.hasSmoothedNormal = false;
    }
}

// Screen-space, radially symmetric focus/destination marker for orbit and fly modes.
// Unlike walk mode's surface-projected footprint ring, this stays a fixed pixel size
// so it neither dominates close-up geometry nor vanishes on distant fly targets.
class CursorPinpoint {
    private svg: SVGSVGElement;

    private camera: Entity;

    private root: SVGGElement;

    private wave: SVGGElement;

    private dot: SVGGElement;

    private position = new Vec3();

    private visible = false;

    private exiting = false;

    private dotAnim: Animation | null = null;

    private waveAnim: Animation | null = null;

    private exitTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(svg: SVGSVGElement, camera: Entity) {
        this.svg = svg;
        this.camera = camera;

        const root = document.createElementNS(SVGNS, 'g');
        root.classList.add('sse-pinpoint');
        root.style.display = 'none';

        const wave = document.createElementNS(SVGNS, 'g');
        wave.classList.add('sse-pinpointWave');

        const waveHalo = document.createElementNS(SVGNS, 'circle');
        waveHalo.classList.add('sse-pinpointHaloStroke');
        waveHalo.setAttribute('r', String(PINPOINT_RING_RADIUS));

        const waveStroke = document.createElementNS(SVGNS, 'circle');
        waveStroke.classList.add('sse-pinpointFgStroke');
        waveStroke.setAttribute('r', String(PINPOINT_RING_RADIUS));

        wave.append(waveHalo, waveStroke);

        const dot = document.createElementNS(SVGNS, 'g');
        dot.classList.add('sse-pinpointDot');

        const dotHalo = document.createElementNS(SVGNS, 'circle');
        dotHalo.classList.add('sse-pinpointHaloFill');
        dotHalo.setAttribute('r', String(PINPOINT_DOT_HALO_RADIUS));

        const dotCore = document.createElementNS(SVGNS, 'circle');
        dotCore.classList.add('sse-pinpointFgFill');
        dotCore.setAttribute('r', String(PINPOINT_DOT_RADIUS));

        dot.append(dotHalo, dotCore);
        root.append(wave, dot);
        svg.appendChild(root);

        this.root = root;
        this.wave = wave;
        this.dot = dot;
    }

    private clearAnimations() {
        this.dotAnim?.cancel();
        this.dotAnim = null;
        this.waveAnim?.cancel();
        this.waveAnim = null;
        if (this.exitTimer !== null) {
            clearTimeout(this.exitTimer);
            this.exitTimer = null;
        }
    }

    show(pos: Vec3, mode: 'orbit' | 'fly') {
        this.clearAnimations();
        this.position.copy(pos);
        this.visible = true;
        this.exiting = false;
        this.svg.style.display = '';
        this.root.style.display = '';
        // project before starting animations so the first painted frame sits at the target
        this.update();

        if (prefersReducedMotion() || typeof this.dot.animate !== 'function') {
            this.dot.style.opacity = '1';
            this.dot.style.transform = 'none';
            this.wave.style.opacity = '0';
            return;
        }

        this.dot.style.opacity = '';
        this.dot.style.transform = '';
        this.wave.style.opacity = '';

        this.dotAnim = this.dot.animate(
            [
                { opacity: 0, transform: 'scale(0.84)' },
                { opacity: 1, transform: 'scale(1)' }
            ],
            {
                duration: Math.round(PINPOINT_ENTER_MS * 0.65),
                easing: PINPOINT_EASE_OUT,
                fill: 'forwards'
            }
        );

        if (mode === 'fly') {
            this.waveAnim = this.wave.animate(
                [
                    { opacity: 0.9, transform: 'scale(0.62)', offset: 0 },
                    { opacity: 0, transform: 'scale(1.44)', offset: 0.48 },
                    { opacity: 0, transform: 'scale(1.44)', offset: 1 }
                ],
                {
                    duration: Math.round(PINPOINT_ENTER_MS * 3.4),
                    easing: PINPOINT_EASE_OUT,
                    iterations: Infinity
                }
            );
        } else {
            this.waveAnim = this.wave.animate(
                [
                    { opacity: 0.95, transform: 'scale(0.64)' },
                    { opacity: 0, transform: 'scale(1.42)' }
                ],
                {
                    duration: Math.round(PINPOINT_ENTER_MS * 1.25),
                    easing: PINPOINT_EASE_OUT,
                    fill: 'forwards'
                }
            );
        }
    }

    update() {
        if (!this.visible) {
            return;
        }

        const cam = this.camera.camera;
        cam.viewMatrix.transformPoint(this.position, tmpView);
        if (tmpView.z >= 0) {
            this.root.style.visibility = 'hidden';
            return;
        }

        cam.worldToScreen(this.position, tmpScreen);
        this.root.style.visibility = 'visible';
        this.root.style.transform = `translate3d(${tmpScreen.x.toFixed(2)}px, ${tmpScreen.y.toFixed(2)}px, 0)`;
    }

    release() {
        if (!this.visible || this.exiting) {
            return;
        }
        if (prefersReducedMotion() || typeof this.dot.animate !== 'function') {
            this.hide();
            return;
        }

        this.exiting = true;
        this.waveAnim?.cancel();
        this.waveAnim = null;
        this.wave.style.opacity = '0';

        this.dotAnim?.cancel();
        this.dotAnim = this.dot.animate(
            [
                { opacity: 1, transform: 'scale(1)' },
                { opacity: 0, transform: 'scale(0.84)' }
            ],
            {
                duration: PINPOINT_EXIT_MS,
                easing: PINPOINT_EASE_IN,
                fill: 'forwards'
            }
        );

        this.exitTimer = setTimeout(() => {
            this.hide();
        }, PINPOINT_EXIT_MS);
    }

    hide() {
        this.clearAnimations();
        this.visible = false;
        this.exiting = false;
        this.root.style.display = 'none';
    }

    destroy() {
        this.clearAnimations();
        this.root.remove();
    }
}

class NavCursor {
    private svg: SVGSVGElement;

    private captureMarker: SVGCircleElement;

    private hoverRing: CursorRing;

    private targetRing: CursorRing;

    private targetPinpoint: CursorPinpoint;

    private camera: Entity;

    // Settable after construction: the viewer reveals the scene before the collision data has
    // downloaded, so this arrives late.
    collision: Collision | null;

    private canvas: HTMLCanvasElement;

    private app: AppBase;

    private onPrerender: () => void;

    // True when the hover ring should track the pointer. Only walk mode
    // (with mouse navigation, not gaming controls) shows the hover ring;
    // fly/orbit only show the target pinpoint on click.
    private hoverActive = false;

    private navigating = false;

    private targetPos: Vec3 | null = null;

    private targetNormal: Vec3 | null = null;

    private targetMode: TargetMode | null = null;

    private onPointerMove: (e: PointerEvent) => void;

    private onPointerLeave: () => void;

    private readonly collisionTarget: CursorTarget = {
        position: new Vec3(),
        normal: new Vec3()
    };

    constructor(
        app: AppBase,
        camera: Entity,
        collision: Collision | null,
        events: EventHandler,
        state: State,
        reticle: boolean
    ) {
        this.camera = camera;
        this.collision = collision;
        this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        this.app = app;

        this.svg = document.createElementNS(SVGNS, 'svg');
        this.svg.classList.add('sse-navCursor');
        this.svg.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible';
        // in the scene layer, over the scene and beneath the ui, and first in it so the
        // annotations draw over the cursor
        const parent = this.canvas.parentElement!;
        (parent.querySelector(':scope > .sse-sceneLayer') ?? parent).prepend(this.svg);

        this.captureMarker = document.createElementNS(SVGNS, 'circle');
        this.captureMarker.setAttribute('cx', '50%');
        this.captureMarker.setAttribute('cy', '50%');
        this.captureMarker.setAttribute('r', '2');
        this.captureMarker.setAttribute('fill', 'white');
        this.captureMarker.setAttribute('stroke', 'black');
        this.captureMarker.setAttribute('stroke-opacity', '0.5');
        this.captureMarker.setAttribute('stroke-width', '2');
        this.captureMarker.style.display = 'none';
        this.svg.appendChild(this.captureMarker);

        this.hoverRing = new CursorRing(this.svg, camera, true);
        this.targetRing = new CursorRing(this.svg, camera, false);
        this.targetPinpoint = new CursorPinpoint(this.svg, camera);

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

        this.canvas.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerleave', this.onPointerLeave);

        const updateActive = () => {
            const captureActive =
                reticle &&
                state.inputMode === 'desktop' &&
                state.gamingControls &&
                (state.cameraMode === 'walk' || state.cameraMode === 'fly');
            this.captureMarker.style.display = captureActive ? '' : 'none';
            if (captureActive) {
                this.svg.style.display = '';
            }

            // Hover ring only in walk mode with mouse navigation. Gaming
            // controls use pointer-lock and don't need a hover preview.
            this.hoverActive = state.cameraMode === 'walk' && !state.gamingControls;
            this.hoverRing.hide();
            if (this.targetMode && this.targetMode !== state.cameraMode) {
                this.navigating = false;
                this.clearTarget(true);
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
            const mode = state.cameraMode === 'walk' || state.cameraMode === 'fly' ? state.cameraMode : 'walk';
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

    private setTarget(pos: Vec3, normal: Vec3, mode: TargetMode) {
        this.targetPos = pos.clone();
        this.targetNormal = normal.clone();
        this.targetMode = mode;
        this.hoverRing.hide();
        if (mode === 'walk') {
            this.targetPinpoint.hide();
            this.targetRing.hide();
        } else {
            this.targetRing.hide();
            this.targetPinpoint.show(pos, mode);
        }
    }

    private clearTarget(immediate = false) {
        this.targetPos = null;
        this.targetNormal = null;
        this.targetMode = null;
        this.targetRing.hide();
        if (immediate) {
            this.targetPinpoint.hide();
        } else {
            this.targetPinpoint.release();
        }
    }

    private pickCollision(offsetX: number, offsetY: number): CursorTarget | null {
        if (!this.collision) {
            return null;
        }

        const { camera, collision } = this;
        const cameraPos = camera.getPosition();

        camera.camera.screenToWorld(offsetX, offsetY, 1.0, tmpV);
        tmpV.sub(cameraPos).normalize();

        // a camera inside solid geometry picks where the ray leaves it, not its own position
        const hit = collision.queryRay(
            cameraPos.x,
            cameraPos.y,
            cameraPos.z,
            tmpV.x,
            tmpV.y,
            tmpV.z,
            camera.camera.farClip,
            true
        );

        if (!hit) {
            return null;
        }

        // an exit's surface faces along the ray, so its normal is found looking back along it
        if (hit.exit) tmpV.mulScalar(-1);
        const sn = collision.querySurfaceNormal(hit.x, hit.y, hit.z, tmpV.x, tmpV.y, tmpV.z);
        this.collisionTarget.position.set(hit.x, hit.y, hit.z);
        this.collisionTarget.normal.set(sn.nx, sn.ny, sn.nz);
        return this.collisionTarget;
    }

    private updateCursor(offsetX: number, offsetY: number) {
        if (!this.hoverActive || this.navigating) {
            this.hoverRing.hide();
            return;
        }

        const target = this.pickCollision(offsetX, offsetY);
        if (!target) {
            this.hoverRing.hide();
            return;
        }

        this.hoverRing.render(target.position, target.normal);
    }

    private updateTarget() {
        if (!this.targetPos || !this.targetNormal || !this.targetMode) {
            // keep projecting the pinpoint during its exit fade so it stays locked to 3D space
            this.targetPinpoint.update();
            return;
        }

        const camPos = this.camera.getPosition();
        const dist = camPos.distance(this.targetPos);
        if (this.targetMode === 'walk') {
            if (dist < 2.0) {
                this.targetRing.hide();
                return;
            }
            this.targetRing.render(this.targetPos, this.targetNormal);
            return;
        }

        if (this.targetMode === 'fly' && dist < 2.0) {
            this.targetPinpoint.release();
        }
        this.targetPinpoint.update();
    }

    destroy() {
        this.app.off('prerender', this.onPrerender);
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
        this.targetPinpoint.destroy();
        this.svg.remove();
    }
}

export { NavCursor };
