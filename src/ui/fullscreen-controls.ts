import type { ViewerHandle } from '../types';

const initFullscreenControls = (
    viewer: Pick<ViewerHandle, 'state' | 'events' | 'requestFullscreen' | 'exitFullscreen'>,
    root: HTMLElement
) => {
    const enter = root.querySelector<HTMLButtonElement>('.sse-enterFullscreen');
    const exit = root.querySelector<HTMLButtonElement>('.sse-exitFullscreen');
    const update = () => {
        enter.classList.toggle('sse-hidden', viewer.state.isFullscreen);
        exit.classList.toggle('sse-hidden', !viewer.state.isFullscreen);
    };
    // Permission and user-gesture failures leave the observed state unchanged.
    const request = () => {
        void viewer.requestFullscreen().catch(() => {
            /* browser rejected the request */
        });
    };
    const leave = () => {
        void viewer.exitFullscreen().catch(() => {
            /* browser rejected the exit */
        });
    };
    const orientationChanged = () => {
        if (screen.orientation.type.startsWith('landscape')) request();
        else leave();
    };
    enter.addEventListener('click', request);
    exit.addEventListener('click', leave);
    screen.orientation?.addEventListener('change', orientationChanged);
    const changed = viewer.events.on('isFullscreen:changed', update);
    update();

    return () => {
        changed.off();
        enter.removeEventListener('click', request);
        exit.removeEventListener('click', leave);
        screen.orientation?.removeEventListener('change', orientationChanged);
    };
};

export { initFullscreenControls };
