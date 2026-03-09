import {
    type AppBase,
    type Entity,
    type EventHandler,
    Vec3
} from 'playcanvas';

import type { State } from './types';
import type { VoxelCollider } from './voxel-collider';

const SVGNS = 'http://www.w3.org/2000/svg';
const NUM_SAMPLES = 12;
const CIRCLE_OUTER_RADIUS = 0.2;
const CIRCLE_INNER_RADIUS = 0.17;
const BEZIER_K = 1 / 6;
const NORMAL_SMOOTH_FACTOR = 0.25;

const tmpV = new Vec3();
const tmpScreen = new Vec3();
const tangent = new Vec3();
const bitangent = new Vec3();
const worldPt = new Vec3();
const up = new Vec3(0, 1, 0);
const right = new Vec3(1, 0, 0);

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

class WalkCursor {
    private svg: SVGSVGElement;

    private cursorPath: SVGPathElement;

    private targetPath: SVGPathElement;

    private app: AppBase;

    private camera: Entity;

    private collider: VoxelCollider;

    private canvas: HTMLCanvasElement;

    private active = false;

    private walking = false;

    private targetPos: Vec3 | null = null;

    private targetNormal: Vec3 | null = null;

    private smoothNx = 0;

    private smoothNy = 1;

    private smoothNz = 0;

    private hasSmoothedNormal = false;

    private onPointerMove: (e: PointerEvent) => void;

    private onPointerLeave: () => void;

    private readonly scratchX = new Float64Array(NUM_SAMPLES);

    private readonly scratchY = new Float64Array(NUM_SAMPLES);

    private readonly outerX = new Float64Array(NUM_SAMPLES);

    private readonly outerY = new Float64Array(NUM_SAMPLES);

    private readonly innerX = new Float64Array(NUM_SAMPLES);

    private readonly innerY = new Float64Array(NUM_SAMPLES);

    constructor(
        app: AppBase,
        camera: Entity,
        collider: VoxelCollider,
        events: EventHandler,
        state: State
    ) {
        this.app = app;
        this.camera = camera;
        this.collider = collider;
        this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        this.svg = document.createElementNS(SVGNS, 'svg');
        this.svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:1';
        this.canvas.parentElement!.appendChild(this.svg);

        // Hover cursor: thick ring
        this.cursorPath = document.createElementNS(SVGNS, 'path');
        this.cursorPath.setAttribute('fill', 'white');
        this.cursorPath.setAttribute('fill-opacity', '0.6');
        this.cursorPath.setAttribute('fill-rule', 'evenodd');
        this.cursorPath.setAttribute('stroke', 'none');
        this.svg.appendChild(this.cursorPath);

        // Walk target: filled circle
        this.targetPath = document.createElementNS(SVGNS, 'path');
        this.targetPath.setAttribute('fill', 'white');
        this.targetPath.setAttribute('fill-opacity', '0.5');
        this.targetPath.setAttribute('stroke', 'none');
        this.targetPath.style.display = 'none';
        this.svg.appendChild(this.targetPath);

        this.svg.style.display = 'none';

        this.onPointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return;
            if (e.buttons) {
                this.cursorPath.style.display = 'none';
                this.hasSmoothedNormal = false;
                return;
            }
            this.updateCursor(e.offsetX, e.offsetY);
        };

        this.onPointerLeave = () => {
            this.cursorPath.style.display = 'none';
            this.hasSmoothedNormal = false;
        };

        this.canvas.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerleave', this.onPointerLeave);

        const updateActive = () => {
            this.active = state.cameraMode === 'walk' &&
                          !state.gamingControls;
            if (!this.active) {
                this.svg.style.display = 'none';
            }
        };

        events.on('cameraMode:changed', updateActive);
        events.on('gamingControls:changed', updateActive);

        events.on('walkTo', () => {
            this.walking = true;
            this.cursorPath.style.display = 'none';
            this.hasSmoothedNormal = false;
        });

        events.on('walkCancel', () => {
            this.walking = false;
            this.clearTarget();
        });

        events.on('walkComplete', () => {
            this.walking = false;
            this.clearTarget();
        });

        events.on('walkTarget:set', (pos: Vec3, normal: Vec3) => {
            this.setTarget(pos, normal);
        });

        events.on('walkTarget:clear', () => {
            this.clearTarget();
        });

        app.on('prerender', () => {
            this.updateTarget();
        });

        updateActive();
    }

    private setTarget(pos: Vec3, normal: Vec3) {
        this.targetPos = pos.clone();
        this.targetNormal = normal.clone();
    }

    private clearTarget() {
        this.targetPos = null;
        this.targetNormal = null;
        this.targetPath.style.display = 'none';
    }

    private projectCircle(
        px: number, py: number, pz: number,
        nx: number, ny: number, nz: number,
        radius: number,
        outX: Float64Array, outY: Float64Array
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

    private updateCursor(offsetX: number, offsetY: number) {
        if (!this.active || this.walking) {
            this.cursorPath.style.display = 'none';
            this.hasSmoothedNormal = false;
            return;
        }

        const { camera, collider } = this;
        const cameraPos = camera.getPosition();

        camera.camera.screenToWorld(offsetX, offsetY, 1.0, tmpV);
        tmpV.sub(cameraPos).normalize();

        const hit = collider.queryRay(
            -cameraPos.x, -cameraPos.y, cameraPos.z,
            -tmpV.x, -tmpV.y, tmpV.z,
            camera.camera.farClip
        );

        if (!hit) {
            this.cursorPath.style.display = 'none';
            this.hasSmoothedNormal = false;
            return;
        }

        const px = -hit.x;
        const py = -hit.y;
        const pz = hit.z;

        const rdx = -tmpV.x;
        const rdy = -tmpV.y;
        const rdz = tmpV.z;
        const sn = collider.querySurfaceNormal(hit.x, hit.y, hit.z, rdx, rdy, rdz);
        let nx = -sn.nx;
        let ny = -sn.ny;
        let nz = sn.nz;

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

        this.projectCircle(px, py, pz, nx, ny, nz, CIRCLE_OUTER_RADIUS, this.outerX, this.outerY);
        this.projectCircle(px, py, pz, nx, ny, nz, CIRCLE_INNER_RADIUS, this.innerX, this.innerY);

        this.cursorPath.setAttribute('d', `${buildBezierRing(this.outerX, this.outerY)} ${buildBezierRing(this.innerX, this.innerY)}`);
        this.cursorPath.style.display = '';
        this.svg.style.display = '';
    }

    private updateTarget() {
        if (!this.active || !this.targetPos || !this.targetNormal) {
            return;
        }

        const camPos = this.camera.getPosition();
        const dist = camPos.distance(this.targetPos);
        if (dist < 2.0) {
            this.targetPath.style.display = 'none';
            return;
        }

        this.projectCircle(
            this.targetPos.x, this.targetPos.y, this.targetPos.z,
            this.targetNormal.x, this.targetNormal.y, this.targetNormal.z,
            CIRCLE_OUTER_RADIUS, this.scratchX, this.scratchY
        );

        this.targetPath.setAttribute('d', buildBezierRing(this.scratchX, this.scratchY));
        this.targetPath.style.display = '';
        this.svg.style.display = '';
    }

    destroy() {
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
        this.svg.remove();
    }
}

export { WalkCursor };
