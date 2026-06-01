import { Vec3 } from 'playcanvas';

import { panActive } from './control-scheme';
import type { ControlScheme, Devices } from './control-scheme';
import { TUNING } from './tuning';
import { DISPLACEMENT_SCALE, flipZForOrbit, screenToWorld } from '../shared';
import type { CameraInputFrame, UpdateContext } from '../shared';

const v = new Vec3();
const t = new Vec3();

/**
 * Orbit control scheme: orbit-around-target. Mouse drag / single-finger rotate,
 * RMB or two-finger pan, wheel / pinch / trackpad zoom, gamepad sticks; a clean
 * tap focuses the picked point (`mobileTap`).
 */
class OrbitScheme implements ControlScheme {
    map(devices: Devices, ctx: UpdateContext, frame: CameraInputFrame): void {
        const { keyboardMouse: kb, touch, trackpad, gamepad } = devices;
        const { dt, distance, cameraComponent, mode, events } = ctx;
        const { deltas } = frame;
        const orbitFactor = 1;
        const double = touch.touchCount > 1 ? 1 : 0;
        const pan = panActive(kb, ctx.touchCount);

        // intents
        if (touch.tapped) {
            events.fire('mobileTap');
        }

        // keyboard + mouse: RMB/2-finger pan + wheel dolly; mouse-drag rotate
        v.set(0, 0, 0);
        screenToWorld(cameraComponent, kb.mouse[0], kb.mouse[1], distance, t);
        v.add(t.mulScalar(pan));
        v.z += -kb.wheel * TUNING.wheelSpeed * DISPLACEMENT_SCALE;
        deltas.move.append([v.x, v.y, flipZForOrbit(mode, v.z)]);

        t.set(kb.mouse[0], kb.mouse[1], 0)
        .mulScalar((1 - pan) * TUNING.rotateSpeed * orbitFactor * TUNING.mouseRotateSensitivity * DISPLACEMENT_SCALE);
        deltas.rotate.append([t.x, t.y, 0]);

        // touch: two-finger pan + pinch zoom; single-finger rotate
        v.set(0, 0, 0);
        screenToWorld(cameraComponent, touch.touch[0], touch.touch[1], distance, t);
        v.add(t.mulScalar(double));
        v.z += touch.pinch * double * TUNING.pinchSpeed * DISPLACEMENT_SCALE;
        deltas.move.append([v.x, v.y, v.z]);

        t.set(touch.touch[0], touch.touch[1], 0)
        .mulScalar((1 - double) * TUNING.rotateSpeed * TUNING.touchRotateSensitivity * DISPLACEMENT_SCALE);
        deltas.rotate.append([t.x, t.y, 0]);

        // trackpad: ctrl-rotate, shift-pan, synthetic-Ctrl pinch zoom
        t.set(trackpad.orbit[0], trackpad.orbit[1], 0)
        .mulScalar(TUNING.rotateSpeed * TUNING.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
        deltas.rotate.append([t.x, t.y, 0]);

        screenToWorld(cameraComponent, trackpad.pan[0], trackpad.pan[1], distance, t);
        t.mulScalar(TUNING.trackpadPanSensitivity);
        deltas.move.append([t.x, t.y, 0]);
        deltas.move.append([0, 0, trackpad.zoom * TUNING.wheelSpeed * TUNING.trackpadZoomSensitivity * DISPLACEMENT_SCALE]);

        // gamepad: left stick pan, right stick rotate
        v.set(gamepad.leftStick[0], 0, -gamepad.leftStick[1]).mulScalar(TUNING.moveSpeed * dt);
        deltas.move.append([v.x, v.y, v.z]);
        t.set(gamepad.rightStick[0], gamepad.rightStick[1], 0)
        .mulScalar(TUNING.rotateSpeed * orbitFactor * TUNING.gamepadRotateSensitivity * dt);
        deltas.rotate.append([t.x, t.y, t.z]);
    }
}

export { OrbitScheme };
