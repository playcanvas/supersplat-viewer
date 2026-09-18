import type { Global } from './types';

// Browser integration shared by the built-in controls and embedding hosts.
const initFullscreen = ({ root, state, events }: Global) => {
    const native = !!(root.requestFullscreen && document.exitFullscreen);
    let destroyed = false;

    const update = () => {
        if (!destroyed) state.isFullscreen = document.fullscreenElement === root;
    };
    if (native) {
        document.addEventListener('fullscreenchange', update);
        update();
    }

    const exit = async () => {
        if (native) {
            // Never close another viewer's (or the host page's) fullscreen element.
            if (document.fullscreenElement === root) await document.exitFullscreen();
            update();
        } else if (state.isFullscreen) {
            window.parent.postMessage('exitFullscreen', '*');
            state.isFullscreen = false;
        }
    };

    const request = async () => {
        if (native) {
            await root.requestFullscreen();
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
            void exit().catch(() => {
                /* removing the root also leaves native fullscreen */
            });
            state.isFullscreen = false;
        }
    };
};

export { initFullscreen };
