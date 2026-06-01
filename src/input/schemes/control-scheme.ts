import type { GamepadDevice } from '../devices/gamepad';
import type { KeyboardMouseDevice } from '../devices/keyboard-mouse';
import type { TouchDevice } from '../devices/touch';
import type { TrackpadDevice } from '../devices/trackpad';
import type { CameraInputFrame, UpdateContext } from '../shared';

/** The set of layer-1 device readers a control scheme maps from. */
interface Devices {
    keyboardMouse: KeyboardMouseDevice;
    touch: TouchDevice;
    gamepad: GamepadDevice;
    trackpad: TrackpadDevice;
}

/**
 * A control scheme maps the current device signals into the camera-control
 * frame (move/rotate) for one camera mode. Selected per-frame by the active
 * camera mode (orbit / fly / walk); `anim` has no scheme.
 */
interface ControlScheme {
    /** Reset per-mode mapping state when this scheme becomes the active mode. */
    enter?(): void;
    map(devices: Devices, ctx: UpdateContext, frame: CameraInputFrame): void;
}

// Pan-active flag: RMB held / released this frame / 2+ touches.
const panActive = (kb: KeyboardMouseDevice, touchCount: number): number => kb.buttons[2] || +(kb.buttonEdge[2] === -1) || +(touchCount > 1);

export { panActive };
export type { Devices, ControlScheme };
