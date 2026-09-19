import type { ViewerHandle } from '../types';

const initJoystick = (viewer: Pick<ViewerHandle, 'state' | 'events' | 'setMoveInput'>, root: HTMLElement) => {
    const { state, events } = viewer;
    const dom = {
        joystickBase: root.querySelector<HTMLElement>('.sse-joystickBase'),
        joystick: root.querySelector<HTMLElement>('.sse-joystick')
    };
    let disposed = false;
    // Joystick dimensions (matches SCSS: base height=100, stick size=40)
    const joystickHeight = 100;
    const stickSize = 40;
    const stickCenterY = (joystickHeight - stickSize) / 2; // 30px - top position when centered
    const stickCenterX = (joystickHeight - stickSize) / 2; // 30px - left position when centered (for 2D mode)
    const maxStickTravel = stickCenterY; // can travel 30px up or down from center

    // Joystick touch state
    let joystickPointerId: number | null = null;
    let joystickValueX = 0; // -1 to 1, negative = left, positive = right
    let joystickValueY = 0; // -1 to 1, negative = forward, positive = backward

    // Joystick mode: '1d' for vertical only, '2d' for full directional
    let joystickMode: '1d' | '2d' = '2d';

    // Double-tap detection for mode toggle
    let lastTapTime = 0;

    const stop = () => {
        const pointerId = joystickPointerId;
        joystickPointerId = null;
        joystickValueX = joystickValueY = 0;
        dom.joystick.style.top = `${stickCenterY}px`;
        dom.joystick.style.left = joystickMode === '2d' ? `${stickCenterX}px` : '8px';
        if (pointerId !== null) {
            if (!disposed) viewer.setMoveInput(0, 0);
            if (dom.joystickBase.hasPointerCapture(pointerId)) dom.joystickBase.releasePointerCapture(pointerId);
        }
    };

    // Update joystick visibility based on camera mode and input mode
    const updateJoystickVisibility = () => {
        stop();
        if (
            (state.cameraMode === 'fly' || state.cameraMode === 'walk') &&
            state.inputMode === 'touch' &&
            state.gamingControls &&
            state.loaded &&
            state.xrMode === null
        ) {
            dom.joystickBase.classList.remove('sse-hidden');
            dom.joystickBase.classList.toggle('sse-mode-2d', joystickMode === '2d');
            // Center the stick
            dom.joystick.style.top = `${stickCenterY}px`;
            if (joystickMode === '2d') {
                dom.joystick.style.left = `${stickCenterX}px`;
            } else {
                dom.joystick.style.left = '8px'; // Reset to 1D centered position
            }
        } else {
            dom.joystickBase.classList.add('sse-hidden');
        }
    };

    const subscriptions = ['cameraMode', 'inputMode', 'gamingControls', 'loaded', 'xrMode'].map((key) =>
        events.on(`${key}:changed`, updateJoystickVisibility)
    );

    // Handle joystick touch input directly on the joystick element
    const updateJoystickStick = (clientX: number, clientY: number) => {
        // the stylesheet places the base within the instance, so measure its centre rather
        // than assuming where the viewport put it
        const base = dom.joystickBase.getBoundingClientRect();
        const baseY = base.top + base.height / 2;
        // Calculate Y offset from joystick center (positive = down/backward)
        const offsetY = clientY - baseY;
        // Clamp to max travel and normalize to -1 to 1
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickValueY = clampedOffsetY / maxStickTravel;

        // Update stick visual Y position
        dom.joystick.style.top = `${stickCenterY + clampedOffsetY}px`;

        // Handle X axis in 2D mode
        if (joystickMode === '2d') {
            const baseX = base.left + base.width / 2;
            const offsetX = clientX - baseX;
            const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
            joystickValueX = clampedOffsetX / maxStickTravel;

            // Update stick visual X position
            dom.joystick.style.left = `${stickCenterX + clampedOffsetX}px`;
        } else {
            joystickValueX = 0;
        }

        viewer.setMoveInput(joystickValueX, -joystickValueY);
    };

    const start = (event: PointerEvent) => {
        if (joystickPointerId !== null) return;
        // Double-tap detection for mode toggle
        const now = Date.now();
        if (now - lastTapTime < 300) {
            joystickMode = joystickMode === '1d' ? '2d' : '1d';
            updateJoystickVisibility();
            lastTapTime = 0;
        } else {
            lastTapTime = now;
        }

        joystickPointerId = event.pointerId;
        dom.joystickBase.setPointerCapture(event.pointerId);

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
    };

    const move = (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
    };

    const endJoystickTouch = (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        stop();
    };

    dom.joystickBase.addEventListener('pointerdown', start);
    dom.joystickBase.addEventListener('pointermove', move);
    dom.joystickBase.addEventListener('pointerup', endJoystickTouch);
    dom.joystickBase.addEventListener('pointercancel', endJoystickTouch);
    dom.joystickBase.addEventListener('lostpointercapture', endJoystickTouch);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', stop);
    updateJoystickVisibility();

    return () => {
        disposed = true;
        stop(); // The input controller has already cleared movement during viewer destruction.
        for (const subscription of subscriptions) subscription.off();
        dom.joystickBase.removeEventListener('pointerdown', start);
        dom.joystickBase.removeEventListener('pointermove', move);
        dom.joystickBase.removeEventListener('pointerup', endJoystickTouch);
        dom.joystickBase.removeEventListener('pointercancel', endJoystickTouch);
        dom.joystickBase.removeEventListener('lostpointercapture', endJoystickTouch);
        window.removeEventListener('blur', stop);
        document.removeEventListener('visibilitychange', stop);
    };
};

export { initJoystick };
