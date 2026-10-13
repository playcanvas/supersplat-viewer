import type { ViewerHandle } from '../types';

// Safari on Apple Vision Pro now and then leaves a session request pending without showing its
// permission dialogs, until the page is hidden and shown again (2026-10-13: switching tabs and
// back let a stalled request through, with WebGL and WebGPU alike). A dialog that does show hides
// the page, so once a request has waited HINT_DELAY with the page showing, a hint says what to do.
const HINT_DELAY = 4000;

const initXrHint = (viewer: Pick<ViewerHandle, 'events'>, root: HTMLElement) => {
    const hint = root.querySelector<HTMLElement>('.sse-xrHint');
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // hide the hint, and wait again while a request is pending with the page showing
    const arm = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        hint.classList.add('sse-hidden');
        if (pending && document.visibilityState === 'visible') {
            timer = setTimeout(() => {
                timer = null;
                hint.classList.remove('sse-hidden');
            }, HINT_DELAY);
        }
    };

    const subscription = viewer.events.on('xrRequest:pending', (value: boolean) => {
        pending = value;
        arm();
    });
    document.addEventListener('visibilitychange', arm);

    return () => {
        subscription.off();
        document.removeEventListener('visibilitychange', arm);
        if (timer !== null) clearTimeout(timer);
    };
};

export { initXrHint };
