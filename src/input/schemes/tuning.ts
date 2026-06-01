/**
 * Input→camera mapping tuning, owned by the mapping layer (schemes). These were
 * previously parked on the device readers, but they're mapping config — how a
 * raw input delta becomes camera rotation / movement / zoom — not properties of
 * the input hardware. Single source of truth so the per-mode schemes don't drift.
 */
const TUNING = {
    /** Base rotate speed, scaled per source by the sensitivities below. */
    rotateSpeed: 18,

    /** Base move speed (WASD / joystick / gamepad stick). */
    moveSpeed: 4,

    /** Wheel / trackpad-zoom speed. */
    wheelSpeed: 0.06,

    /** Two-finger pinch zoom speed. */
    pinchSpeed: 0.4,

    // per-source rotate sensitivities
    mouseRotateSensitivity: 0.5,
    touchRotateSensitivity: 1.5,
    gamepadRotateSensitivity: 1.0,

    // trackpad gesture sensitivities
    trackpadOrbitSensitivity: 0.75,
    trackpadPanSensitivity: 1.0,
    trackpadZoomSensitivity: 2.0,

    // fly-mode WASD velocity accel/decel damping
    flyMoveAccelerationDamping: 0.992,
    flyMoveDecelerationDamping: 0.993
};

export { TUNING };
