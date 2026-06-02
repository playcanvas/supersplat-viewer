import { math, PROJECTION_PERSPECTIVE, Vec3 } from 'playcanvas';
import type { CameraComponent, EventHandler } from 'playcanvas';

import type { CameraMode } from '../types';
import type { InputFrame } from './input-frame';

type CameraMove = [number, number, number];
type CameraRotate = [number, number, number];

/** The shape of every device's input frame: world-space move + euler rotate deltas. */
type CameraInputFrame = InputFrame<{ move: CameraMove; rotate: CameraRotate }>;

/**
 * Displacement-based inputs (mouse, touch, wheel, pinch) return accumulated
 * pixel offsets that already scale with frame time. This factor converts
 * rate-based speed constants (tuned for degrees-per-second) to work with
 * per-frame displacements, making them frame-rate-independent.
 */
const DISPLACEMENT_SCALE = 1 / 60;

/** Maximum accumulated touch movement (px) to still count as a tap. */
const TAP_EPSILON = 15;

const tmpHalfSize = new Vec3();

/**
 * Converts screen-space pixel deltas to a world-space pan vector at the
 * given depth.
 *
 * @param camera - The camera component.
 * @param dx - Horizontal pixel delta.
 * @param dy - Vertical pixel delta.
 * @param dz - Depth (world-space) at which to project the delta.
 * @param out - Optional output vector.
 * @returns The pan vector in world space.
 */
const screenToWorld = (
    camera: CameraComponent,
    dx: number,
    dy: number,
    dz: number,
    out: Vec3 = new Vec3()
) => {
    const { system, fov, aspectRatio, horizontalFov, projection, orthoHeight } = camera;
    const { width, height } = system.app.graphicsDevice.clientRect;

    out.set(-(dx / width) * 2, (dy / height) * 2, 0);

    const halfSize = tmpHalfSize.set(0, 0, 0);
    if (projection === PROJECTION_PERSPECTIVE) {
        const halfSlice = dz * Math.tan(0.5 * fov * math.DEG_TO_RAD);
        if (horizontalFov) {
            halfSize.set(halfSlice, halfSlice / aspectRatio, 0);
        } else {
            halfSize.set(halfSlice * aspectRatio, halfSlice, 0);
        }
    } else {
        halfSize.set(orthoHeight * aspectRatio, orthoHeight, 0);
    }

    out.mul(halfSize);
    return out;
};

/**
 * The orbit camera and the fly camera disagree on the sign of the z-axis
 * for forward motion. Apply this when emitting a forward/back z-component
 * so the same wheel-style delta drives both cameras correctly.
 *
 * @param mode - The current camera mode.
 * @param z - The raw forward/back z-component.
 * @returns The z-component flipped for orbit mode, unchanged otherwise.
 */
const flipZForOrbit = (mode: CameraMode, z: number) => (mode === 'orbit' ? -z : z);

/**
 * The per-frame view of the world that every device's `update()` reads
 * from. Built once by InputController and passed to each device in turn.
 */
type UpdateContext = {
    dt: number;
    distance: number;
    cameraComponent: CameraComponent;
    mode: CameraMode;
    isOrbit: boolean;
    isFly: boolean;
    isWalk: boolean;
    isFirstPerson: boolean;
    gamingControls: boolean;
    /** Number of touches currently active (read by the schemes' pan flag). */
    touchCount: number;
    /** Module-owned intent bus the schemes fire discrete intents on. */
    events: EventHandler;
};

/**
 * What the host application provides to `InputController` — the only coupling
 * the input core has to the surrounding app. The viewer supplies a `global`-backed
 * adapter; another app implements these four members to drop the input core in.
 */
interface InputHost {
    /** The canvas the DOM event source binds its listeners to. */
    readonly canvas: HTMLCanvasElement;
    /** Active camera mode — selects the control scheme + the requestFirstPerson decision. */
    readonly cameraMode: CameraMode;
    /** Whether desktop gaming controls are enabled (a mapping flag). */
    readonly gamingControls: boolean;
    /** The active camera component — schemes use it for screenToWorld pan + fov. */
    readonly cameraComponent: CameraComponent;
}

/**
 * Common shape every input reader (layer 1) implements: pure, mode-agnostic
 * device reading. Readers don't register DOM listeners — the `DomEventSource`
 * does and calls their handlers (keyboard/touch/trackpad expose a `register`
 * method; gamepad polls). `update()` integrates this-frame deltas + held-state
 * and refreshes the exposed signals. Readers hold no camera-mode logic and fire
 * no intents (the control schemes do that, in layer 2).
 */
interface InputDevice {
    update(): void;
}

export {
    DISPLACEMENT_SCALE,
    TAP_EPSILON,
    screenToWorld,
    flipZForOrbit,
    CameraInputFrame,
    UpdateContext,
    InputHost,
    InputDevice
};
