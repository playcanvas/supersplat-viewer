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

    // Depth, and on a camera rig the convergence, in the settings panel while the mode is on. The
    // convergence is a multiple of the focus distance, a quarter to four times, with 1 mid-track
    const depthRow = root.querySelector<HTMLElement>('.sse-display3dDepthRow');
    const convergenceRow = root.querySelector<HTMLElement>('.sse-display3dConvergenceRow');
    const depth = root.querySelector<HTMLInputElement>('.sse-display3dDepth');
    const convergence = root.querySelector<HTMLInputElement>('.sse-display3dConvergence');
    const updateSliders = () => {
        depthRow.classList.toggle('sse-hidden', !state.display3d);
        convergenceRow.classList.toggle('sse-hidden', !state.display3d || !state.display3dCameraRig);
        depth.value = String(state.display3dDepth);
        convergence.value = String((Math.log(state.display3dConvergence) / Math.log(4) + 1) / 2);
    };
    const onDepth = () => {
        state.display3dDepth = Number(depth.value);
    };
    const onConvergence = () => {
        state.display3dConvergence = 4 ** (2 * Number(convergence.value) - 1);
    };
    depth.addEventListener('input', onDepth);
    convergence.addEventListener('input', onConvergence);
    const subscriptions = [
        events.on('hasDisplay3d:changed', update),
        events.on('display3d:changed', update),
        events.on('xrMode:changed', update),
        events.on('display3d:changed', updateSliders),
        events.on('display3dDepth:changed', updateSliders),
        events.on('display3dConvergence:changed', updateSliders),
        events.on('display3dCameraRig:changed', updateSliders)
    ];
    update();
    updateSliders();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        button.removeEventListener('click', toggle);
        depth.removeEventListener('input', onDepth);
        convergence.removeEventListener('input', onConvergence);
    };
};

export { initDisplay3dControls };
