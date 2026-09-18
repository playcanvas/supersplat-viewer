import type { ViewerHandle } from '../types';

const initCameraControls = (
    viewer: Pick<ViewerHandle, 'state' | 'events' | 'frameScene' | 'resetCamera' | 'toggleWalk'>,
    root: HTMLElement
) => {
    const { state, events } = viewer;
    const orbit = root.querySelector<HTMLButtonElement>('.sse-orbitCamera');
    const fly = root.querySelector<HTMLButtonElement>('.sse-flyCamera');
    const walk = root.querySelector<HTMLButtonElement>('.sse-fpsCamera');
    const reset = root.querySelector<HTMLButtonElement>('.sse-reset');
    const frame = root.querySelector<HTMLButtonElement>('.sse-frame');

    const update = () => {
        orbit.classList.toggle('sse-active', state.cameraMode === 'orbit');
        fly.classList.toggle('sse-active', state.cameraMode === 'fly');
        walk.classList.toggle('sse-active', state.cameraMode === 'walk');
        walk.classList.toggle('sse-hidden', !state.walkAllowed);
        fly.classList.toggle('sse-middle', state.walkAllowed);
        fly.classList.toggle('sse-right', !state.walkAllowed);
        for (const button of [orbit, fly, walk, reset, frame]) {
            button.disabled = !state.loaded;
        }
    };

    const onOrbit = () => {
        state.cameraMode = 'orbit';
    };
    const onFly = () => {
        state.cameraMode = 'fly';
    };
    const onWalk = () => viewer.toggleWalk();
    const onReset = () => viewer.resetCamera();
    const onFrame = () => viewer.frameScene();

    orbit.addEventListener('click', onOrbit);
    fly.addEventListener('click', onFly);
    walk.addEventListener('click', onWalk);
    reset.addEventListener('click', onReset);
    frame.addEventListener('click', onFrame);
    const subscriptions = [
        events.on('cameraMode:changed', update),
        events.on('walkAllowed:changed', update),
        events.on('loaded:changed', update)
    ];
    update();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        orbit.removeEventListener('click', onOrbit);
        fly.removeEventListener('click', onFly);
        walk.removeEventListener('click', onWalk);
        reset.removeEventListener('click', onReset);
        frame.removeEventListener('click', onFrame);
    };
};

export { initCameraControls };
