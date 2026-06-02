import { Vec3 } from 'playcanvas';

import { panActive } from './control-scheme';
import type { ControlScheme, Devices } from './control-scheme';
import { TUNING } from './tuning';
import { damp } from '../../core/math';
import { DISPLACEMENT_SCALE, flipZForOrbit, screenToWorld } from '../shared';
import type { CameraInputFrame, UpdateContext } from '../shared';

const v = new Vec3();
const t = new Vec3();
const flyKeyTarget = new Vec3();

/**
 * Fly control scheme: free first-person flight. WASD (smoothed velocity) +
 * mouse / trackpad / touch look, wheel + pinch dolly, joystick + gamepad in
 * gaming controls. Cancels active auto-navigation on any manual input.
 */
class FlyScheme implements ControlScheme {
    /** Smoothed WASD velocity (fly-mode-local; reset on entering the mode). */
    private _flyVelocity = new Vec3();

    enter(): void {
        this._flyVelocity.set(0, 0, 0);
    }

    map(devices: Devices, ctx: UpdateContext, frame: CameraInputFrame): void {
        const { keyboardMouse: kb, touch, trackpad, gamepad } = devices;
        const { dt, distance, cameraComponent, mode, gamingControls, events } = ctx;
        const orbitFactor = cameraComponent.fov / 120;
        const double = touch.touchCount > 1 ? 1 : 0;
        const pan = panActive(kb, ctx.touchCount);
        const directFirstPerson = gamingControls ? 0 : 1;
        const dragInvert = gamingControls ? 1 : -1;

        // intents: cancel auto-nav on any manual input; tap focuses (non-gaming)
        if (
            kb.axis.x !== 0 || kb.axis.y !== 0 || kb.axis.z !== 0 ||
            kb.wheel !== 0 ||
            ((gamingControls || pan) && (kb.mouse[0] !== 0 || kb.mouse[1] !== 0)) ||
            (gamingControls && (touch.joystick[0] !== 0 || touch.joystick[1] !== 0)) ||
            touch.dragExceeded ||
            gamepad.leftStick[0] !== 0 || gamepad.leftStick[1] !== 0 ||
            gamepad.rightStick[0] !== 0 || gamepad.rightStick[1] !== 0 ||
            trackpad.claimed
        ) {
            events.fire('navigateCancel');
        }
        if (touch.tapped && !gamingControls) {
            events.fire('mobileTap');
        }

        // WASD velocity (smoothed, accel/decel damping)
        flyKeyTarget.copy(kb.axis);
        flyKeyTarget.normalize();
        flyKeyTarget.mulScalar(TUNING.moveSpeed * (kb.shift ? 4 : kb.ctrl ? 0.25 : 1));
        const damping = flyKeyTarget.lengthSq() > this._flyVelocity.lengthSq() ?
            TUNING.flyMoveAccelerationDamping :
            TUNING.flyMoveDecelerationDamping;
        this._flyVelocity.lerp(this._flyVelocity, flyKeyTarget, damp(damping, dt));
        if (flyKeyTarget.lengthSq() === 0 && this._flyVelocity.lengthSq() < 1e-4) {
            this._flyVelocity.set(0, 0, 0);
        }

        // keyboard + mouse: WASD velocity + pan + wheel dolly; mouse-drag look
        v.set(0, 0, 0);
        v.add(t.copy(this._flyVelocity).mulScalar(dt));
        screenToWorld(cameraComponent, kb.mouse[0], kb.mouse[1], distance, t);
        v.add(t.mulScalar(pan));
        v.z += -kb.wheel * TUNING.wheelSpeed * DISPLACEMENT_SCALE;
        frame.accumulate('move', [v.x, v.y, flipZForOrbit(mode, v.z)]);

        t.set(kb.mouse[0], kb.mouse[1], 0)
        .mulScalar((1 - pan) * TUNING.rotateSpeed * orbitFactor * TUNING.mouseRotateSensitivity * DISPLACEMENT_SCALE);
        frame.accumulate('rotate', [t.x, t.y, 0]);

        // touch: two-finger strafe/dolly (non-gaming), joystick (gaming); single-finger look
        v.set(0, 0, 0);
        screenToWorld(cameraComponent, touch.touch[0], touch.touch[1], distance, t);
        v.add(t.mulScalar(directFirstPerson * double));
        if (gamingControls) {
            v.add(t.set(touch.joystick[0], 0, -touch.joystick[1]).mulScalar(TUNING.moveSpeed * dt));
        }
        v.z += -directFirstPerson * touch.pinch * double * TUNING.pinchSpeed * DISPLACEMENT_SCALE;
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

export { FlyScheme };
