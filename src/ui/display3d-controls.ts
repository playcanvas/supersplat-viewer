import type { ViewerHandle } from '../types';

// The 3D-display toggle. Shown only where the browser can weave for a glasses-free 3D display
// (state.hasDisplay3d), so it is absent everywhere else. The mode needs WebGL: on the WebGPU
// renderer the button reloads the viewer with the `3d` url param, which picks WebGL and starts in 3D.
const initDisplay3dControls = (
    viewer: Pick<ViewerHandle, 'state' | 'events'>,
    root: HTMLElement,
    renderer: 'webgl' | 'webgpu'
) => {
    const { state, events } = viewer;
    const button = root.querySelector<HTMLButtonElement>('.sse-display3dMode');
    const update = () => {
        button.classList.toggle('sse-hidden', !state.hasDisplay3d || state.xrMode !== null);
        button.classList.toggle('sse-active', state.display3d);
    };
    const toggle = () => {
        if (renderer === 'webgl') {
            state.display3d = !state.display3d;
        } else {
            const url = new URL(location.href);
            url.searchParams.set('3d', '');
            location.replace(url.toString());
        }
    };
    button.addEventListener('click', toggle);
    const subscriptions = [
        events.on('hasDisplay3d:changed', update),
        events.on('display3d:changed', update),
        events.on('xrMode:changed', update)
    ];
    update();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        button.removeEventListener('click', toggle);
    };
};

export { initDisplay3dControls };
