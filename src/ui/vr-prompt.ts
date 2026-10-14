import type { Localize } from '../localization';
import type { ViewerHandle } from '../types';

// The vr flag's prompt (ViewerFlags.vr): it covers the viewer while VR is available and no session
// has started, reading "Loading…" until the viewer fires vrPrompt:ready (the scene is placed, so a
// session starts where the camera is), and then a tap on its pill starts a session through
// vrPrompt:start, which the viewer handles within the tap. A tap elsewhere dismisses it, and after
// the first session the toolbar's VR button takes over.
const initVrPrompt = (viewer: Pick<ViewerHandle, 'state' | 'events'>, root: HTMLElement, localize: Localize) => {
    const { state, events } = viewer;
    const prompt = root.querySelector<HTMLElement>('.sse-vrPrompt');
    const pill = root.querySelector<HTMLElement>('.sse-vrPromptPill');
    const text = root.querySelector<HTMLElement>('.sse-vrPromptText');
    const modal = root.querySelector<HTMLElement>('.sse-xrModal');
    let ready = false;
    let done = false;

    const update = () => {
        prompt.classList.toggle('sse-hidden', done || !state.hasVR || state.xrMode !== null);
        prompt.classList.toggle('sse-vrPromptLoading', !ready);
        text.textContent = localize(ready ? 'vr-prompt.enter' : 'vr-prompt.loading');
    };
    const tap = (event: MouseEvent) => {
        if (!pill.contains(event.target as Node)) {
            done = true;
            update();
            return;
        }
        if (!ready) return;
        if (state.canStartVR) {
            events.fire('vrPrompt:start');
        } else {
            // VR only after reloading into WebGL, which the VR button offers too. The prompt goes
            // first: it is above the dialog and would take its buttons' taps
            done = true;
            update();
            modal.classList.remove('sse-hidden');
        }
    };

    prompt.addEventListener('click', tap);
    const subscriptions = [
        events.on('vrPrompt:ready', () => {
            ready = true;
            update();
        }),
        events.on('hasVR:changed', update),
        events.on('xrMode:changed', (mode) => {
            if (mode) done = true;
            update();
        })
    ];
    update();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        prompt.removeEventListener('click', tap);
    };
};

export { initVrPrompt };
