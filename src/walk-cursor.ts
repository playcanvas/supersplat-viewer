import {
    type AppBase,
    type Entity,
    type EventHandler,
    Mat4,
    PROJECTION_ORTHOGRAPHIC,
    Vec3,
    Vec4
} from 'playcanvas';

import type { Collision } from './collision';
import { captureCameraSnapshot, getWorldPoint, type PickCameraSnapshot, type Picker } from './picker';
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

const tmpV = new Vec3();
const tmpScreen = new Vec3();
const tangent = new Vec3();
const bitangent = new Vec3();
const worldPt = new Vec3();
const up = new Vec3(0, 1, 0);
const right = new Vec3(1, 0, 0);

const tmpViewPos = new Vec3();
const tmpClipVec = new Vec4();
const tmpViewProj = new Mat4();

const worldPointToDepth = (camera: PickCameraSnapshot, worldPos: Vec3) => {
    if (camera.projection === PROJECTION_ORTHOGRAPHIC) {
        tmpViewProj.mul2(camera.projectionMatrix, camera.viewMatrix);
        tmpClipVec.set(worldPos.x, worldPos.y, worldPos.z, 1);
        tmpViewProj.transformVec4(tmpClipVec, tmpClipVec);
        if (Math.abs(tmpClipVec.w) < 1e-8) {
            return -1;
        }
        return (tmpClipVec.z / tmpClipVec.w + 1) * 0.5;
    }
    camera.viewMatrix.transformPoint(worldPos, tmpViewPos);
    const linearDepth = -tmpViewPos.z;
    const range = camera.farClip - camera.nearClip;
    if (range <= 0) {
        return -1;
    }
    return (linearDepth - camera.nearClip) / range;
};

type CursorTarget = {
    position: Vec3;
    normal: Vec3;
};

type SurfaceSample = {
    normalizedDepth: number;
    normal: Vec3;
    camera: PickCameraSnapshot;
    width: number;
    height: number;
};

const createSurfaceSample = (): SurfaceSample => ({
    normalizedDepth: 0,
    normal: new Vec3(),
    camera: {
        position: new Vec3(),
        viewMatrix: new Mat4(),
        projectionMatrix: new Mat4(),
        nearClip: 0,
        farClip: 0,
        projection: 0
    },
    width: 0,
    height: 0
});

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

        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, CIRCLE_OUTER_RADIUS, this.outerX, this.outerY);
        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, CIRCLE_INNER_RADIUS, this.innerX, this.innerY);

        this.path.setAttribute('d', `${buildBezierRing(this.outerX, this.outerY)} ${buildBezierRing(this.innerX, this.innerY)}`);
        this.path.style.display = '';
        this.svg.style.display = '';
    }

    hide() {
        this.path.style.display = 'none';
        this.hasSmoothedNormal = false;
    }
}

class WalkCursor {
    private svg: SVGSVGElement;

    private hoverRing: CursorRing;

    private targetRing: CursorRing;

    private camera: Entity;

    private collision: Collision | null;

    private canvas: HTMLCanvasElement;

    private state: State;

    private picker: Picker;

    private app: AppBase;

    private onPrerender: () => void;

    private active = false;

    private walking = false;

    private targetPos: Vec3 | null = null;

    private targetNormal: Vec3 | null = null;

    private targetMode: TargetMode | null = null;

    private surfaceCursorX = 0;

    private surfaceCursorY = 0;

    private hasSurfaceCursorPosition = false;

    private surfaceCursorVersion = 0;

    private surfaceCursorPickPending = false;

    private surfaceSample: SurfaceSample = createSurfaceSample();

    private hasSurfaceSample = false;

    private scratchHoverPos = new Vec3();

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
        picker: Picker
    ) {
        this.camera = camera;
        this.collision = collision;
        this.canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        this.state = state;
        this.picker = picker;
        this.app = app;

        this.svg = document.createElementNS(SVGNS, 'svg');
        this.svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:1';
        this.canvas.parentElement!.appendChild(this.svg);

        this.hoverRing = new CursorRing(this.svg, camera, true);
        this.targetRing = new CursorRing(this.svg, camera, false);

        this.svg.style.display = 'none';

        this.onPointerMove = (e: PointerEvent) => {
            if (e.pointerType === 'touch') {
                this.hasSurfaceCursorPosition = false;
                this.surfaceCursorVersion++;
                this.hoverRing.hide();
                return;
            }
            if (e.buttons) {
                this.hasSurfaceCursorPosition = false;
                this.surfaceCursorVersion++;
                this.hoverRing.hide();
                return;
            }
            this.updateCursor(e.offsetX, e.offsetY);
        };

        this.onPointerLeave = () => {
            this.hasSurfaceCursorPosition = false;
            this.surfaceCursorVersion++;
            this.hoverRing.hide();
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
            this.hoverRing.hide();
            if (state.inputMode !== 'desktop') {
                this.hasSurfaceCursorPosition = false;
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

        events.on('navigateTo', () => {
            this.walking = true;
            this.hoverRing.hide();
        });

        events.on('navigateCancel', () => {
            this.walking = false;
            this.clearTarget();
        });

        events.on('navigateComplete', () => {
            this.walking = false;
            this.clearTarget();
        });

        events.on('navTarget:set', (pos: Vec3, normal: Vec3) => {
            const mode = state.cameraMode === 'walk' || state.cameraMode === 'fly' ?
                state.cameraMode : 'walk';
            this.setTarget(pos, normal, mode);
        });

        events.on('navTarget:clear', () => {
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

        this.onPrerender = () => {
            this.updateTarget();
        };
        app.on('prerender', this.onPrerender);

        updateActive();
    }

    private setTarget(pos: Vec3, normal: Vec3, mode: TargetMode) {
        this.surfaceCursorVersion++;
        this.targetPos = pos.clone();
        this.targetNormal = normal.clone();
        this.targetMode = mode;
        this.hoverRing.hide();
        this.targetRing.hide();
    }

    private clearTarget() {
        const mode = this.targetMode;
        this.targetPos = null;
        this.targetNormal = null;
        this.targetMode = null;
        if (mode === 'orbit') {
            this.hoverRing.hide();
        }
        this.targetRing.hide();
        this.refreshSurfaceCursor();
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
        return result ?? null;
    }

    private shouldShowSurfaceCursor() {
        const flyMouseCaptured = this.state.cameraMode === 'fly' &&
            this.state.inputMode === 'desktop' &&
            this.state.gamingControls;
        return this.active &&
            this.state.inputMode === 'desktop' &&
            this.hasSurfaceCursorPosition &&
            !this.walking && (
            (this.state.cameraMode === 'fly' && !flyMouseCaptured) ||
            (this.state.cameraMode === 'orbit' && this.targetMode !== 'orbit')
        );
    }

    private updateSurfaceCursor(offsetX: number, offsetY: number) {
        this.surfaceCursorX = offsetX;
        this.surfaceCursorY = offsetY;
        this.hasSurfaceCursorPosition = true;
        this.surfaceCursorVersion++;

        // Render immediately using the most recent depth sample, re-projecting
        // at the new pointer position. The async pick below will refresh the
        // sample.
        this.renderSurfaceCursor();

        if (!this.surfaceCursorPickPending) {
            this.processSurfaceCursor();
        }
    }

    private renderSurfaceCursor() {
        if (!this.hasSurfaceSample || !this.shouldShowSurfaceCursor()) {
            this.hoverRing.hide();
            return;
        }
        const sample = this.surfaceSample;
        const position = getWorldPoint(
            sample.camera,
            this.surfaceCursorX,
            this.surfaceCursorY,
            sample.width,
            sample.height,
            sample.normalizedDepth,
            this.scratchHoverPos
        );
        if (!position) {
            this.hoverRing.hide();
            return;
        }
        this.hoverRing.render(position, sample.normal);
    }

    private refreshSurfaceCursor() {
        if (this.hasSurfaceCursorPosition && this.shouldShowSurfaceCursor() && !this.surfaceCursorPickPending) {
            this.surfaceCursorVersion++;
            this.processSurfaceCursor();
        }
    }

    private processSurfaceCursor() {
        this.surfaceCursorPickPending = true;

        const version = this.surfaceCursorVersion;
        // Capture the camera at pick fire time so the depth we extract from
        // the result is interpretable through the same view/projection. The
        // surface cursor only animates while the camera is static, so this
        // snapshot matches the camera the picker actually rendered with.
        captureCameraSnapshot(this.camera, this.surfaceSample.camera);
        const snapshotWidth = this.canvas.clientWidth;
        const snapshotHeight = this.canvas.clientHeight;
        this.pickSceneTarget(this.surfaceCursorX, this.surfaceCursorY).then((target) => {
            if (target) {
                this.surfaceSample.normalizedDepth = worldPointToDepth(this.surfaceSample.camera, target.position);
                this.surfaceSample.normal.copy(target.normal);
                this.surfaceSample.width = snapshotWidth;
                this.surfaceSample.height = snapshotHeight;
                this.hasSurfaceSample = this.surfaceSample.normalizedDepth >= 0;
            } else {
                this.hasSurfaceSample = false;
            }
            this.renderSurfaceCursor();
        }).catch(() => {
            if (version === this.surfaceCursorVersion) {
                this.hasSurfaceSample = false;
                this.hoverRing.hide();
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
            this.hoverRing.hide();
            return;
        }

        if (this.state.cameraMode === 'orbit' && this.targetMode === 'orbit') {
            this.hoverRing.hide();
            return;
        }

        if (this.state.cameraMode === 'fly' || this.state.cameraMode === 'orbit') {
            this.updateSurfaceCursor(offsetX, offsetY);
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
        if (!this.active || !this.targetPos || !this.targetNormal) {
            return;
        }

        const camPos = this.camera.getPosition();
        const dist = camPos.distance(this.targetPos);
        if (this.targetMode !== 'orbit' && dist < 2.0) {
            this.targetRing.hide();
            return;
        }

        this.targetRing.render(this.targetPos, this.targetNormal);
    }

    destroy() {
        this.app.off('prerender', this.onPrerender);
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
        this.svg.remove();
    }
}

export { WalkCursor };
