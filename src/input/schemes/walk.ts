import { Vec3 } from 'playcanvas';

import { panActive } from './control-scheme';
import type { ControlScheme, Devices } from './control-scheme';
import { TUNING } from './tuning';
import { DISPLACEMENT_SCALE, flipZForOrbit, screenToWorld } from '../shared';
import type { CameraInputFrame, UpdateContext } from '../shared';

const v = new Vec3();
const t = new Vec3();
const km = new Vec3();

/**
 * Walk control scheme: ground-constrained first-person. WASD (horizontal only)
 * + jump, mouse / trackpad / touch look, wheel + pinch dolly; joystick and
 * tap-to-jump in gaming controls, tap-to-walk otherwise.
 */
class WalkScheme implements ControlScheme {
    map(devices: Devices, ctx: UpdateContext, frame: CameraInputFrame): void {
        const { keyboardMouse: kb, touch, trackpad, gamepad } = devices;
        const { dt, distance, cameraComponent, mode, gamingControls, events } = ctx;
        const orbitFactor = cameraComponent.fov / 120;
        const double = touch.touchCount > 1 ? 1 : 0;
        const pan = panActive(kb, ctx.touchCount);
        const directFirstPerson = gamingControls ? 0 : 1;
        const dragInvert = gamingControls ? 1 : -1;

        // intents: cancel auto-nav on manual movement; tap walks (non-gaming)
        if (kb.axis.x !== 0 || kb.axis.z !== 0 || (!gamingControls && touch.dragExceeded)) {
            events.fire('navigateCancel');
        }
        if (touch.tapped && !gamingControls) {
            events.fire('mobileTap');
        }

        // keyboard + mouse: horizontal WASD + jump + pan + wheel; mouse-drag look
        v.set(0, 0, 0);
        km.copy(kb.axis);
        km.y = 0;
        km.normalize();
        km.mulScalar(TUNING.moveSpeed * (kb.shift ? 2 : kb.ctrl ? 0.5 : 1));
        v.add(t.copy(km).mulScalar(dt));
        v.y = kb.jump > 0 ? 1 : 0;
        screenToWorld(cameraComponent, kb.mouse[0], kb.mouse[1], distance, t);
        v.add(t.mulScalar(pan));
        v.z += -kb.wheel * TUNING.wheelSpeed * DISPLACEMENT_SCALE;
        frame.accumulate('move', [v.x, v.y, flipZForOrbit(mode, v.z)]);

        t.set(kb.mouse[0], kb.mouse[1], 0)
        .mulScalar((1 - pan) * TUNING.rotateSpeed * orbitFactor * TUNING.mouseRotateSensitivity * DISPLACEMENT_SCALE);
        frame.accumulate('rotate', [t.x, t.y, 0]);

        // touch: two-finger ground strafe (non-gaming), joystick (gaming),
        // tap-to-jump (gaming); single-finger look
        v.set(0, 0, 0);
        screenToWorld(cameraComponent, touch.touch[0], touch.touch[1], distance, t);
        t.y = 0;
        v.add(t.mulScalar(directFirstPerson * double));
        if (gamingControls) {
            v.add(t.set(touch.joystick[0], 0, -touch.joystick[1]).mulScalar(TUNING.moveSpeed * dt));
        }
        v.z += -directFirstPerson * touch.pinch * double * TUNING.pinchSpeed * DISPLACEMENT_SCALE;
        if (touch.tapped && gamingControls) {
            v.y = 1;
        }
        frame.accumulate('move', [v.x, v.y, v.z]);

        t.set(touch.touch[0] * dragInvert, touch.touch[1] * dragInvert, 0)
        .mulScalar((1 - double) * TUNING.rotateSpeed * orbitFactor * TUNING.touchRotateSensitivity * DISPLACEMENT_SCALE);
        frame.accumulate('rotate', [t.x, t.y, 0]);

        // trackpad: ctrl-rotate look, shift-pan strafe, synthetic-Ctrl pinch dolly
        t.set(trackpad.orbit[0], trackpad.orbit[1], 0)
        .mulScalar(TUNING.rotateSpeed * orbitFactor * TUNING.trackpadOrbitSensitivity * DISPLACEMENT_SCALE);
        frame.accumulate('rotate', [t.x, t.y, 0]);

        screenToWorld(cameraComponent, trackpad.pan[0], trackpad.pan[1], distance, t);
        t.mulScalar(TUNING.trackpadPanSensitivity);
        frame.accumulate('move', [t.x, t.y, 0]);
        frame.accumulate('move', [0, 0, -trackpad.zoom * TUNING.wheelSpeed * TUNING.trackpadZoomSensitivity * DISPLACEMENT_SCALE]);

        // gamepad: left stick move, right stick look
        v.set(gamepad.leftStick[0], 0, -gamepad.leftStick[1]).mulScalar(TUNING.moveSpeed * dt);
        frame.accumulate('move', [v.x, v.y, v.z]);
        t.set(gamepad.rightStick[0], gamepad.rightStick[1], 0)
        .mulScalar(TUNING.rotateSpeed * orbitFactor * TUNING.gamepadRotateSensitivity * dt);
        frame.accumulate('rotate', [t.x, t.y, t.z]);
    }
}

export { WalkScheme };
