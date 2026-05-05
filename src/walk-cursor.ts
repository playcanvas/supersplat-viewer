import {
    type AppBase,
    type Entity,
    type EventHandler,
    Vec3
} from 'playcanvas';

import type { Collision } from './collision';
import type { Picker } from './picker';
import type { State } from './types';

const SVGNS = 'http://www.w3.org/2000/svg';
const NUM_SAMPLES = 12;
const CIRCLE_OUTER_RADIUS = 0.2;
const CIRCLE_INNER_RADIUS = 0.17;
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
            result.push(new Vec3(
                Math.cos(yaw) * cp,
                sy,
                Math.sin(yaw) * cp
            ));
        }
    }

    return result;
};

const NORMAL_SNAP_DIRECTIONS = createNormalSnapDirections();

const tmpV = new Vec3();
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

class WalkCursor {
    private svg: SVGSVGElement;

    private cursorPath: SVGPathElement;

    private targetPath: SVGPathElement;

    private camera: Entity;

    private collision: Collision | null;

    private canvas: HTMLCanvasElement;

    private state: State;

    private picker: Picker;

    private active = false;

    private walking = false;

    private targetPos: Vec3 | null = null;

    private targetNormal: Vec3 | null = null;

    private targetMode: TargetMode | null = null;

    private smoothNx = 0;

    private smoothNy = 1;

    private smoothNz = 0;

    private hasSmoothedNormal = false;

    private surfaceCursorX = 0;

    private surfaceCursorY = 0;

    private surfaceCursorVersion = 0;

    private surfaceCursorPickPending = false;

    private onPointerMove: (e: PointerEvent) => void;

    private onPointerLeave: () => void;

    private readonly outerX = new Float64Array(NUM_SAMPLES);

    private readonly outerY = new Float64Array(NUM_SAMPLES);

    private readonly innerX = new Float64Array(NUM_SAMPLES);

    private readonly innerY = new Float64Array(NUM_SAMPLES);

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
        picker: Picker
    ) {
        this.camera = camera;
        this.collision = collision;
        this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        this.state = state;
        this.picker = picker;

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

        // Selected target cursor: same ring geometry as hover.
        this.targetPath = document.createElementNS(SVGNS, 'path');
        this.targetPath.setAttribute('fill', 'white');
        this.targetPath.setAttribute('fill-opacity', '0.6');
        this.targetPath.setAttribute('fill-rule', 'evenodd');
        this.targetPath.setAttribute('stroke', 'none');
        this.targetPath.style.display = 'none';
        this.svg.appendChild(this.targetPath);

        this.svg.style.display = 'none';

        this.onPointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch') return;
            if (e.buttons) {
                this.surfaceCursorVersion++;
                this.cursorPath.style.display = 'none';
                this.hasSmoothedNormal = false;
                return;
            }
            if (this.targetMode === 'orbit') {
                this.clearTarget();
            }
            this.updateCursor(e.offsetX, e.offsetY);
        };

        this.onPointerLeave = () => {
            this.surfaceCursorVersion++;
            this.cursorPath.style.display = 'none';
            this.hasSmoothedNormal = false;
        };

        this.canvas.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerleave', this.onPointerLeave);

        const updateActive = () => {
            const flyMouseCaptured = (
                state.cameraMode === 'fly' &&
                state.inputMode === 'desktop' &&
                state.gamingControls
            );
            this.active = (state.cameraMode === 'walk' && !state.gamingControls) ||
                          (state.cameraMode === 'fly' && !flyMouseCaptured) ||
                          state.cameraMode === 'orbit';
            this.surfaceCursorVersion++;
            if (!this.active) {
                this.cursorPath.style.display = 'none';
                this.hasSmoothedNormal = false;
            }
            if (this.targetMode && this.targetMode !== state.cameraMode) {
                this.walking = false;
                this.clearTarget();
            }
            if (!this.active) {
                this.svg.style.display = 'none';
            }
        };

        events.on('cameraMode:changed', updateActive);
        events.on('inputMode:changed', updateActive);
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
            this.setTarget(pos, normal, 'walk');
        });

        events.on('walkTarget:clear', () => {
            this.clearTarget();
        });

        events.on('flyTo', () => {
            this.walking = true;
            this.cursorPath.style.display = 'none';
            this.hasSmoothedNormal = false;
        });

        events.on('flyCancel', () => {
            this.walking = false;
            this.clearTarget();
        });

        events.on('flyComplete', () => {
            this.walking = false;
            this.clearTarget();
        });

        events.on('flyTarget:set', (pos: Vec3, normal: Vec3) => {
            this.setTarget(pos, normal, 'fly');
        });

        events.on('flyTarget:clear', () => {
            this.clearTarget();
        });

        events.on('orbitTarget:set', (pos: Vec3, normal: Vec3) => {
            this.walking = false;
            this.setTarget(pos, normal, 'orbit');
        });

        events.on('orbitTarget:clear', () => {
            if (this.targetMode === 'orbit') {
                this.clearTarget();
            }
        });

        app.on('prerender', () => {
            this.updateTarget();
        });

        updateActive();
    }

    private setTarget(pos: Vec3, normal: Vec3, mode: TargetMode) {
        this.surfaceCursorVersion++;
        this.targetPos = pos.clone();
        this.targetNormal = normal.clone();
        this.targetMode = mode;
        this.cursorPath.style.display = 'none';
        this.targetPath.style.display = 'none';
        this.hasSmoothedNormal = false;
    }

    private clearTarget() {
        const mode = this.targetMode;
        this.targetPos = null;
        this.targetNormal = null;
        this.targetMode = null;
        if (mode === 'orbit') {
            this.cursorPath.style.display = 'none';
        }
        this.targetPath.style.display = 'none';
    }

    private hideCursor() {
        this.cursorPath.style.display = 'none';
        this.hasSmoothedNormal = false;
    }

    private projectCircle(
        px: number, py: number, pz: number,
        nx: number, ny: number, nz: number,
        radius: number,
        outX: Float64Array, outY: Float64Array
    ) {
        const normal = snapNormal(nx, ny, nz, tmpV);
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

    private renderRing(path: SVGPathElement, pos: Vec3, normal: Vec3) {
        this.projectCircle(
            pos.x, pos.y, pos.z,
            normal.x, normal.y, normal.z,
            CIRCLE_OUTER_RADIUS, this.outerX, this.outerY
        );
        this.projectCircle(
            pos.x, pos.y, pos.z,
            normal.x, normal.y, normal.z,
            CIRCLE_INNER_RADIUS, this.innerX, this.innerY
        );

        path.setAttribute('d', `${buildBezierRing(this.outerX, this.outerY)} ${buildBezierRing(this.innerX, this.innerY)}`);
        path.style.display = '';
        this.svg.style.display = '';
    }

    private pickCollision(offsetX: number, offsetY: number): CursorTarget | null {
        if (!this.collision) {
            return null;
        }

        const { camera, collision } = this;
        const cameraPos = camera.getPosition();

        camera.camera.screenToWorld(offsetX, offsetY, 1.0, tmpV);
        tmpV.sub(cameraPos).normalize();

        const hit = collision.queryRay(
            cameraPos.x, cameraPos.y, cameraPos.z,
            tmpV.x, tmpV.y, tmpV.z,
            camera.camera.farClip
        );

        if (!hit) {
            return null;
        }

        const sn = collision.querySurfaceNormal(hit.x, hit.y, hit.z, tmpV.x, tmpV.y, tmpV.z);
        this.collisionTarget.position.set(hit.x, hit.y, hit.z);
        this.collisionTarget.normal.set(sn.nx, sn.ny, sn.nz);
        return this.collisionTarget;
    }

    private async pickSceneTarget(offsetX: number, offsetY: number): Promise<CursorTarget | null> {
        const collisionTarget = this.pickCollision(offsetX, offsetY);
        if (collisionTarget) {
            return collisionTarget;
        }

        const result = await this.picker.pickSurface(
            offsetX / this.canvas.clientWidth,
            offsetY / this.canvas.clientHeight
        );
        if (result) {
            return result;
        }

        return null;
    }

    private renderCursor(pos: Vec3, normal: Vec3) {
        let nx = normal.x;
        let ny = normal.y;
        let nz = normal.z;

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

        this.renderRing(this.cursorPath, pos, tmpV.set(nx, ny, nz));
    }

    private shouldShowSurfaceCursor() {
        const flyMouseCaptured = this.state.cameraMode === 'fly' &&
            this.state.inputMode === 'desktop' &&
            this.state.gamingControls;
        return this.active && !this.walking && (
            (this.state.cameraMode === 'fly' && !flyMouseCaptured) ||
            this.state.cameraMode === 'orbit'
        );
    }

    private updateSurfaceCursor(offsetX: number, offsetY: number) {
        this.surfaceCursorX = offsetX;
        this.surfaceCursorY = offsetY;
        this.surfaceCursorVersion++;

        if (!this.surfaceCursorPickPending) {
            this.processSurfaceCursor();
        }
    }

    private processSurfaceCursor() {
        this.surfaceCursorPickPending = true;

        const version = this.surfaceCursorVersion;
        this.pickSceneTarget(this.surfaceCursorX, this.surfaceCursorY).then((target) => {
            if (version !== this.surfaceCursorVersion || !this.shouldShowSurfaceCursor()) {
                return;
            }

            if (target) {
                this.renderCursor(target.position, target.normal);
            } else {
                this.hideCursor();
            }
        }).catch(() => {
            if (version === this.surfaceCursorVersion) {
                this.hideCursor();
            }
        }).finally(() => {
            this.surfaceCursorPickPending = false;
            if (version !== this.surfaceCursorVersion && this.shouldShowSurfaceCursor()) {
                this.processSurfaceCursor();
            }
        });
    }

    private updateCursor(offsetX: number, offsetY: number) {
        if (!this.active || this.walking) {
            this.hideCursor();
            return;
        }

        if (this.state.cameraMode === 'fly' || this.state.cameraMode === 'orbit') {
            this.updateSurfaceCursor(offsetX, offsetY);
            return;
        }

        const target = this.pickCollision(offsetX, offsetY);
        if (!target) {
            this.hideCursor();
            return;
        }

        this.renderCursor(target.position, target.normal);
    }

    private updateTarget() {
        if (!this.active || !this.targetPos || !this.targetNormal) {
            return;
        }

        const camPos = this.camera.getPosition();
        const dist = camPos.distance(this.targetPos);
        if (this.targetMode !== 'orbit' && dist < 2.0) {
            this.targetPath.style.display = 'none';
            return;
        }

        this.renderRing(this.targetPath, this.targetPos, this.targetNormal);
    }

    destroy() {
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
        this.svg.remove();
    }
}

export { WalkCursor };
