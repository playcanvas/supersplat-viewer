import { PROJECTION_ORTHOGRAPHIC, Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

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

// Compute the world-space radius such that a circle at `pos` projects to a
// ring of `pixelDiameter` on screen. Used by the no-collision sizing path
// to keep a constant on-screen diameter regardless of camera distance.
const worldRadiusForPixels = (camera: Entity, canvasHeight: number, pos: Vec3, pixelDiameter: number): number => {
    const cam = camera.camera;
    if (cam.projection === PROJECTION_ORTHOGRAPHIC) {
        return pixelDiameter * cam.orthoHeight / canvasHeight;
    }
    const camPos = camera.getPosition();
    const dx = pos.x - camPos.x;
    const dy = pos.y - camPos.y;
    const dz = pos.z - camPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const halfFovTan = Math.tan(cam.fov * Math.PI / 360);
    return pixelDiameter * distance * halfFovTan / canvasHeight;
};

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

/**
 * A double-ring (outer + inner, even-odd filled) cursor primitive rendered as a
 * single SVG path. Pure view: given a world position + surface normal (and a
 * sizing mode), it snaps + optionally smooths the normal, projects the rings to
 * screen via the camera, and paints. Knows nothing about navigation, modes, or
 * input — `NavCursor` owns one for hover and one for the active target.
 */
class CursorRing {
    private path: SVGPathElement;

    private svg: SVGSVGElement;

    private canvas: HTMLCanvasElement;

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

    constructor(svg: SVGSVGElement, canvas: HTMLCanvasElement, camera: Entity, smoothing: boolean) {
        this.svg = svg;
        this.canvas = canvas;
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

    // screenPixels: null → world-space ring (fixed world radius, shrinks
    // with distance); number → constant on-screen diameter in CSS pixels.
    render(pos: Vec3, normal: Vec3, screenPixels: number | null) {
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

        const outerRadius = screenPixels !== null ?
            worldRadiusForPixels(this.camera, this.canvas.clientHeight || 1, pos, screenPixels) :
            BASE_OUTER_RADIUS;
        const innerRadius = outerRadius * INNER_OUTER_RATIO;

        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, outerRadius, this.outerX, this.outerY);
        this.projectCircle(pos.x, pos.y, pos.z, nx, ny, nz, innerRadius, this.innerX, this.innerY);

        this.path.setAttribute('d', `${buildBezierRing(this.outerX, this.outerY)} ${buildBezierRing(this.innerX, this.innerY)}`);
        this.path.style.display = '';
        this.svg.style.display = '';
    }

    hide() {
        this.path.style.display = 'none';
        this.hasSmoothedNormal = false;
    }
}

export { CursorRing, SVGNS };
