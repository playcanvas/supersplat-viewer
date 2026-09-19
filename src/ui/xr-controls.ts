import type { ViewerHandle, XrMode } from '../types';

const initXrControls = (viewer: Pick<ViewerHandle, 'state' | 'events' | 'startXR'>, root: HTMLElement) => {
    const { state, events } = viewer;
    const ar = root.querySelector<HTMLButtonElement>('.sse-arMode');
    const vr = root.querySelector<HTMLButtonElement>('.sse-vrMode');
    const modal = root.querySelector<HTMLElement>('.sse-xrModal');
    const ok = root.querySelector<HTMLButtonElement>('.sse-xrModalOk');
    const cancel = root.querySelector<HTMLButtonElement>('.sse-xrModalCancel');
    const update = () => {
        ar.classList.toggle('sse-hidden', !state.hasAR);
        vr.classList.toggle('sse-hidden', !state.hasVR);
        ar.disabled = vr.disabled = !state.loaded || state.xrMode !== null;
    };
    const start = (mode: XrMode) => {
        if (mode === 'ar' ? state.canStartAR : state.canStartVR) {
            void viewer.startXR(mode).catch(() => {
                // Browser permission failures leave the controls in their observed state.
            });
        } else if (mode === 'ar' ? state.hasAR : state.hasVR) {
            modal.classList.remove('sse-hidden');
        }
    };
    const startAR = () => start('ar');
    const startVR = () => start('vr');
    const hideModal = () => modal.classList.add('sse-hidden');
    const reloadWithWebgl = () => {
        const url = new URL(location.href);
        url.searchParams.set('webgl', '');
        location.replace(url.toString());
    };
    ar.addEventListener('click', startAR);
    vr.addEventListener('click', startVR);
    ok.addEventListener('click', reloadWithWebgl);
    cancel.addEventListener('click', hideModal);
    modal.addEventListener('pointerdown', hideModal);
    const subscriptions = [
        events.on('loaded:changed', update),
        events.on('hasAR:changed', update),
        events.on('hasVR:changed', update),
        events.on('xrMode:changed', update)
    ];
    update();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        ar.removeEventListener('click', startAR);
        vr.removeEventListener('click', startVR);
        ok.removeEventListener('click', reloadWithWebgl);
        cancel.removeEventListener('click', hideModal);
        modal.removeEventListener('pointerdown', hideModal);
    };
};

export { initXrControls };
