import type { Global } from './types';

// Browser integration shared by the built-in controls and embedding hosts. Native fullscreen
// takes the host's container rather than the viewer's root, so whatever the host shows over the
// viewer in that container (its own info panel, a badge) stays visible.
const initFullscreen = ({ container, state, events }: Global) => {
    const native = !!(container.requestFullscreen && document.exitFullscreen);
    let destroyed = false;

    const update = () => {
        if (!destroyed) state.isFullscreen = document.fullscreenElement === container;
    };
    if (native) {
        document.addEventListener('fullscreenchange', update);
        update();
    }

    const exit = async () => {
        if (native) {
            // Never close another viewer's (or the host page's) fullscreen element.
            if (document.fullscreenElement === container) await document.exitFullscreen();
            update();
        } else if (state.isFullscreen) {
            window.parent.postMessage('exitFullscreen', '*');
            state.isFullscreen = false;
        }
    };

    const request = async () => {
        if (native) {
            await container.requestFullscreen();
            // A request may finish after destruction. Release only our own element.
            if (destroyed) await exit();
            else update();
        } else if (window.parent !== window) {
            // Preserve the standalone iframe bridge. There is no acknowledgement protocol:
            // this is the requested state, not an observation of the parent's browser state.
            window.parent.postMessage('requestFullscreen', '*');
            state.isFullscreen = true;
        } else {
            throw new Error('requestFullscreen: fullscreen is not supported');
        }
    };

    const cancel = events.on('inputEvent', (event: string) => {
        if (event === 'cancel')
            void exit().catch(() => {
                /* browser rejected the exit */
            });
    });

    return {
        request,
        exit,
        destroy: () => {
            destroyed = true;
            document.removeEventListener('fullscreenchange', update);
            cancel.off();
            // the container outlives the viewer, so leave fullscreen explicitly
            void exit().catch(() => {
                /* browser rejected the exit */
            });
            state.isFullscreen = false;
        }
    };
};

export { initFullscreen };
