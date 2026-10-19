import type { ViewerHandle } from '../types';

// TEMPORARY workaround for Safari on Apple Vision Pro (https://bugs.webkit.org/show_bug.cgi?id=327687):
// after a session with hand tracking, it leaves the next session request pending without showing
// its permission dialogs, until the page is hidden and shown again, which lets the request through
// without hand tracking (2026-10-13: switching tabs and back let a stalled request through, with
// WebGL and WebGPU alike). A dialog that does show hides the page, so once a request has waited
// HINT_DELAY with the page showing, a hint says what to do. Once Safari is fixed, delete this file
// and its init in ui.ts, the .sse-xrHint element in ui.html and its style in index.scss, the
// xr-hint.stalled string in every locale, and the xrRequest:pending events xr.ts fires for it.
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
