import type { ViewerHandle } from '../types';

// Playback presentation uses the same state and commands as an embedding host.
const initPlayback = (
    viewer: Pick<ViewerHandle, 'state' | 'events' | 'seek'>,
    root: HTMLElement,
    showUI: () => void
) => {
    const { state, events } = viewer;
    const play = root.querySelector<HTMLElement>('.sse-play');
    const pause = root.querySelector<HTMLElement>('.sse-pause');
    const timeline = root.querySelector<HTMLElement>('.sse-timelineContainer');
    const handle = root.querySelector<HTMLElement>('.sse-handle');
    const time = root.querySelector<HTMLElement>('.sse-time');

    const available = () => state.loaded && state.hasAnimation;
    const updateControls = () => {
        const playing = state.cameraMode === 'anim' && !state.animationPaused;
        play.classList.toggle('sse-hidden', !available() || playing);
        pause.classList.toggle('sse-hidden', !available() || !playing);
        timeline.classList.toggle('sse-hidden', !available() || state.cameraMode !== 'anim');
    };
    const updateSlider = () => {
        const position = state.animationDuration > 0 ? (state.animationTime / state.animationDuration) * 100 : 0;
        handle.style.left = `${position}%`;
        time.style.left = `${position}%`;
        time.innerText = `${state.animationTime.toFixed(1)}s`;
    };

    const onPlay = () => {
        if (!available()) return;
        state.cameraMode = 'anim';
        state.animationPaused = false;
    };
    const onPause = () => {
        if (!available()) return;
        state.cameraMode = 'anim';
        state.animationPaused = true;
    };
    const scrub = (event: PointerEvent) => {
        const rect = timeline.getBoundingClientRect();
        if (rect.width <= 0) return;
        const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        viewer.seek(state.animationDuration * fraction);
        showUI();
    };

    let pointerId: number | null = null;
    const onPointerDown = (event: PointerEvent) => {
        if (pointerId !== null || event.button !== 0 || !available()) return;
        state.animationPaused = true;
        scrub(event);
        pointerId = event.pointerId;
        timeline.setPointerCapture(pointerId);
        time.classList.remove('sse-hidden');
    };
    const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId === pointerId) scrub(event);
    };
    const endDrag = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        time.classList.add('sse-hidden');
        if (timeline.hasPointerCapture(event.pointerId)) {
            timeline.releasePointerCapture(event.pointerId);
        }
        // Do not restore an old pause flag over a host's command during the drag.
    };

    play.addEventListener('click', onPlay);
    pause.addEventListener('click', onPause);
    timeline.addEventListener('pointerdown', onPointerDown);
    timeline.addEventListener('pointermove', onPointerMove);
    timeline.addEventListener('pointerup', endDrag);
    timeline.addEventListener('pointercancel', endDrag);
    timeline.addEventListener('lostpointercapture', endDrag);
    const subscriptions = [
        events.on('loaded:changed', updateControls),
        events.on('hasAnimation:changed', updateControls),
        events.on('cameraMode:changed', updateControls),
        events.on('animationPaused:changed', updateControls),
        events.on('animationTime:changed', updateSlider),
        events.on('animationDuration:changed', updateSlider)
    ];
    updateControls();
    updateSlider();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        play.removeEventListener('click', onPlay);
        pause.removeEventListener('click', onPause);
        timeline.removeEventListener('pointerdown', onPointerDown);
        timeline.removeEventListener('pointermove', onPointerMove);
        timeline.removeEventListener('pointerup', endDrag);
        timeline.removeEventListener('pointercancel', endDrag);
        timeline.removeEventListener('lostpointercapture', endDrag);
        if (pointerId !== null && timeline.hasPointerCapture(pointerId)) {
            timeline.releasePointerCapture(pointerId);
        }
    };
};

export { initPlayback };
