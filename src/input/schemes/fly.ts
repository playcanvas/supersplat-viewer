import { Vec3 } from 'playcanvas';

import type { ControlScheme, Devices } from './control-scheme';
import { DISPLACEMENT_SCALE, flipZForOrbit, screenToWorld } from '../shared';
import type { CameraInputFrame, UpdateContext } from '../shared';

const v = new Vec3();
const t = new Vec3();

/**
 * Fly control scheme: free first-person flight. WASD (smoothed velocity) +
 * mouse / trackpad / touch look, wheel + pinch dolly, virtual joystick and
 * gamepad in gaming controls.
 */
class FlyScheme implements ControlScheme {
    map(devices: Devices, ctx: UpdateContext, frame: CameraInputFrame): void {
        const { keyboardMouse: kb, touch, trackpad, gamepad } = devices;
        const { dt, distance, cameraComponent, mode, gamingControls } = ctx;
        const { deltas } = frame;
        const orbitFactor = cameraComponent.fov / 120;
        const double = touch.touchCount > 1 ? 1 : 0;
        const directFirstPerson = gamingControls ? 0 : 1;
        const dragInvert = gamingControls ? 1 : -1;

        // keyboard + mouse: WASD velocity + pan + wheel dolly; mouse-drag look
        v.set(0, 0, 0);
        v.add(t.copy(kb.flyVelocity).mulScalar(dt));
        screenToWorld(cameraComponent, kb.mouse[0], kb.mouse[1], distance, t);
        v.add(t.mulScalar(kb.pan));
        v.z += -kb.wheel * kb.wheelSpeed * DISPLACEMENT_SCALE;
        deltas.move.append([v.x, v.y, flipZForOrbit(mode, v.z)]);

        t.set(kb.mouse[0], kb.mouse[1], 0)
        .mulScalar((1 - kb.pan) * kb.orbitSpeed * orbitFactor * kb.mouseRotateSensitivity * DISPLACEMENT_SCALE);
        deltas.rotate.append([t.x, t.y, 0]);

        // touch: two-finger strafe/dolly (non-gaming), joystick (gaming); single-finger look
        v.set(0, 0, 0);
        screenToWorld(cameraComponent, touch.touch[0], touch.touch[1], distance, t);
        v.add(t.mulScalar(directFirstPerson * double));
        if (gamingControls) {
            v.add(t.set(touch.joystick[0], 0, -touch.joystick[1]).mulScalar(touch.moveSpeed * dt));
        }
        v.z += -directFirstPerson * touch.pinch * double * touch.pinchSpeed * DISPLACEMENT_SCALE;
        deltas.move.append([v.x, v.y, v.z]);

        t.set(touch.touch[0] * dragInvert, touch.touch[1] * dragInvert, 0)
        .mulScalar((1 - double) * touch.orbitSpeed * orbitFactor * touch.touchRotateSensitivity * DISPLACEMENT_SCALE);
        deltas.rotate.append([t.x, t.y, 0]);

        // trackpad: ctrl-rotate look, shift-pan strafe, synthetic-Ctrl pinch dolly
        t.set(trackpad.orbit[0], trackpad.orbit[1], 0)
        .mulScalar(trackpad.orbitSpeed * orbitFactor * trackpad.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
        deltas.rotate.append([t.x, t.y, 0]);

        screenToWorld(cameraComponent, trackpad.pan[0], trackpad.pan[1], distance, t);
        t.mulScalar(trackpad.trackpadPanSensitivity);
        deltas.move.append([t.x, t.y, 0]);
        deltas.move.append([0, 0, -trackpad.zoom * trackpad.wheelSpeed * trackpad.trackpadZoomSensitivity * DISPLACEMENT_SCALE]);

        // gamepad: left stick move, right stick look
        v.set(gamepad.leftStick[0], 0, -gamepad.leftStick[1]).mulScalar(gamepad.moveSpeed * dt);
        deltas.move.append([v.x, v.y, v.z]);
        t.set(gamepad.rightStick[0], gamepad.rightStick[1], 0)
        .mulScalar(gamepad.orbitSpeed * orbitFactor * gamepad.gamepadRotateSensitivity * dt);
        deltas.rotate.append([t.x, t.y, t.z]);
    }
}

export { FlyScheme };
