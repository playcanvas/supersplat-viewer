import type { Localize } from '../localization';
import type { ViewerHandle } from '../types';

// how long the panel stays up after a change, and after the pointer leaves it
const SHOW_MS = 4000;
const LINGER_MS = 1500;

// 'auto' pops the panel up on every change, 'pinned' keeps it up, 'off' never shows it
type Preference = 'auto' | 'pinned' | 'off';

const STORAGE_KEY = 'controlsHint';

const readPreference = (): Preference => {
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        return value === 'pinned' || value === 'off' ? value : 'auto';
    } catch {
        // Embedded documents can be denied storage.
        return 'auto';
    }
};

const writePreference = (value: Preference) => {
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be blocked or full; the choice still holds for this viewer.
    }
};

type MouseButton = 'left' | 'right' | 'wheel' | 'none';

// one input shown in a row: a keycap, a mouse with its active button
// (optionally dragged or double-clicked), a touch gesture in words, or a "/" between two inputs
type Token =
    | { kind: 'key'; label: string }
    | { kind: 'mouse'; button: MouseButton; suffix?: 'drag' | 'double' }
    | { kind: 'gesture'; label: string }
    | { kind: 'or' };

// an action name (a help.action.* key) and the inputs that perform it; null draws a divider
type Row = [action: string, ...tokens: Token[]] | null;

type Hint = { title: string; subtitle: string; icon: string; rows: Row[] };

const key = (label: string): Token => ({ kind: 'key', label });
const mouse = (button: MouseButton, suffix?: 'drag' | 'double'): Token => ({ kind: 'mouse', button, suffix });
// one line of keycaps rather than the studio's two-row cluster, so every row is the same height
const wasd = ['W', 'A', 'S', 'D'].map(key);
const or: Token = { kind: 'or' };

// mouse outline with the pressed button filled, after the studio's navigation guide
const mouseButtonPaths: Record<MouseButton, string> = {
    left: '<path class="sse-mouseActive" d="M1 9a8 8 0 0 1 8-8v8Z"/>',
    right: '<path class="sse-mouseActive" d="M17 9a8 8 0 0 0-8-8v8Z"/>',
    wheel: '<rect class="sse-mouseActive" x="7.5" y="3.5" width="3" height="6" rx="1.5"/>',
    none: ''
};

const mouseSvg = (button: MouseButton) =>
    '<svg class="sse-mouseIcon" viewBox="0 0 18 26" aria-hidden="true">' +
    `${mouseButtonPaths[button]}` +
    '<rect class="sse-mouseBody" x="1" y="1" width="16" height="24" rx="8"/>' +
    '<path class="sse-mouseSplit" d="M9 1v8M1 9h16"/>' +
    '</svg>';

const dragSvg =
    '<svg class="sse-dragIcon" viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M6 1v10M1 6h10M4 3l2-2 2 2M4 9l2 2 2-2M3 4 1 6l2 2M9 4l2 2-2 2"/>' +
    '</svg>';

const titles = {
    orbit: 'help.section.orbit',
    fly: 'help.section.fly',
    walk: 'help.section.walk',
    anim: 'help.section.anim'
};

const icons = {
    orbit: '#orbitIcon',
    fly: '#flyIcon',
    walk: '#walkIcon',
    anim: '#playIcon'
};

// the controls for the viewer's current camera mode, input mode and gaming controls, or null
// where there is nothing to show. Each list keeps the mouse rows together ahead of the keys
const describe = (state: ViewerHandle['state'], localize: Localize): Hint | null => {
    const { cameraMode, gamingControls } = state;
    const gaming = gamingControls && (cameraMode === 'fly' || cameraMode === 'walk');
    const space = key(localize('help.key.space'));
    const esc = key(localize('help.key.esc'));
    const runSlow: Row = ['run-slow', key('Shift'), or, key('Ctrl')];
    const gesture = (name: string): Token => ({ kind: 'gesture', label: localize(`help.key.${name}`) });

    let rows: Row[];

    if (state.inputMode === 'desktop') {
        switch (cameraMode) {
            case 'orbit':
                rows = [
                    ['orbit', mouse('left', 'drag')],
                    ['pan', mouse('right', 'drag')],
                    ['zoom', mouse('wheel')],
                    ['set-focus', mouse('left')],
                    ['fly-to-point', mouse('left', 'double')],
                    ['frame-scene', key('F')],
                    ['reset-camera', key('R')]
                ];
                break;
            case 'fly':
                rows = gaming
                    ? [
                          ['look-around', mouse('none', 'drag')],
                          ['move', ...wasd],
                          ['vertical', key('Q'), key('E')],
                          runSlow,
                          ['release-mouse', esc]
                      ]
                    : [
                          ['fly-to', mouse('left')],
                          ['look-around', mouse('left', 'drag')],
                          ['pan', mouse('right', 'drag')],
                          ['focus-point', mouse('left', 'double')],
                          ['move', ...wasd],
                          runSlow
                      ];
                break;
            case 'walk':
                rows = gaming
                    ? [
                          ['look-around', mouse('none', 'drag')],
                          ['move', ...wasd],
                          ['jump', space],
                          runSlow,
                          ['release-mouse', esc]
                      ]
                    : [
                          ['walk-to', mouse('left')],
                          ['look-around', mouse('left', 'drag')],
                          ['fly-to-point', mouse('left', 'double')],
                          ['move', ...wasd],
                          runSlow,
                          ['exit-walk', esc]
                      ];
                break;
            case 'anim':
                rows = [
                    ['play-pause', space],
                    ['exit-cancel', esc]
                ];
                break;
        }
        rows.push(null, ['toggle-help', key('H')]);
    } else {
        switch (cameraMode) {
            case 'orbit':
                rows = [
                    ['orbit', gesture('one-finger-drag')],
                    ['pan', gesture('two-finger-drag')],
                    ['zoom', gesture('pinch')],
                    ['set-focus', gesture('tap')],
                    ['fly-to-point', gesture('double-tap')]
                ];
                break;
            case 'fly':
                rows = gaming
                    ? [
                          ['look-around', gesture('touch-drag')],
                          ['move', gesture('joystick')]
                      ]
                    : [
                          ['fly-to', gesture('tap')],
                          ['look-around', gesture('touch-drag')],
                          ['move', gesture('pinch-two-finger')],
                          ['focus-point', gesture('double-tap')]
                      ];
                break;
            case 'walk':
                rows = gaming
                    ? [
                          ['look-around', gesture('touch-drag')],
                          ['move', gesture('joystick')],
                          ['jump', gesture('tap')]
                      ]
                    : [
                          ['walk-to', gesture('tap')],
                          ['look-around', gesture('touch-drag')],
                          ['fly-to-point', gesture('double-tap')]
                      ];
                break;
            case 'anim':
                // the animation has no touch controls of its own: any touch takes over
                return null;
        }
    }

    return {
        title: localize(titles[cameraMode]),
        subtitle: gaming ? localize('settings.gaming-controls') : '',
        icon: icons[cameraMode],
        rows
    };
};

const renderToken = (token: Token): HTMLElement => {
    const span = (className: string, text?: string) => {
        const element = document.createElement('span');
        element.className = className;
        if (text) element.textContent = text;
        return element;
    };
    const kbd = (label: string) => {
        const element = document.createElement('kbd');
        element.className = 'sse-key';
        element.textContent = label;
        return element;
    };

    switch (token.kind) {
        case 'key':
            return kbd(token.label);
        case 'mouse': {
            const element = span('sse-mouse');
            // constant markup only: nothing localized or external reaches innerHTML
            element.innerHTML = mouseSvg(token.button) + (token.suffix === 'drag' ? dragSvg : '');
            if (token.suffix === 'double') element.append(span('sse-mouseCount', '×2'));
            return element;
        }
        case 'gesture':
            return span('sse-gesture', token.label);
        case 'or':
            return span('sse-or', '/');
    }
};

/**
 * The panel at the top right that names the camera mode and shows its controls. It pops up
 * briefly whenever the camera mode, the input mode or the gaming controls (mouse capture on
 * desktop) change. The user can pin it open or switch it off, and the settings panel switches
 * it back on; the choice persists in local storage.
 */
const initControlsHint = (viewer: Pick<ViewerHandle, 'state' | 'events'>, root: HTMLElement, localize: Localize) => {
    const { state, events } = viewer;
    const panel = root.querySelector<HTMLElement>('.sse-controlsHint');
    const icon = root.querySelector<SVGUseElement>('.sse-controlsHintIcon > use');
    const title = root.querySelector<HTMLElement>('.sse-controlsHintTitle');
    const subtitle = root.querySelector<HTMLElement>('.sse-controlsHintSubtitle');
    const rowsElement = root.querySelector<HTMLElement>('.sse-controlsHintRows');
    const pin = root.querySelector<HTMLButtonElement>('.sse-controlsHintPin');
    const close = root.querySelector<HTMLButtonElement>('.sse-controlsHintClose');
    const settingsRow = root.querySelector<HTMLElement>('.sse-showHintsRow');
    const settingsCheck = root.querySelector<HTMLElement>('.sse-showHintsCheck');

    let preference = readPreference();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rendered = '';

    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const hide = () => {
        clearTimer();
        panel.classList.remove('sse-visible');
    };

    const hideAfter = (ms: number) => {
        clearTimer();
        if (preference === 'auto') {
            timer = setTimeout(hide, ms);
        }
    };

    const render = (hint: Hint) => {
        icon.setAttribute('href', hint.icon);
        title.textContent = hint.title;
        subtitle.textContent = hint.subtitle;
        rowsElement.replaceChildren(
            ...hint.rows.map((row) => {
                const element = document.createElement('div');
                if (!row) {
                    element.className = 'sse-divider';
                    return element;
                }
                const [action, ...tokens] = row;
                const name = document.createElement('span');
                name.className = 'sse-controlsHintAction';
                name.textContent = localize(`help.action.${action}`);
                const inputs = document.createElement('span');
                inputs.className = 'sse-controlsHintInputs';
                inputs.append(...tokens.map(renderToken));
                element.className = 'sse-controlsHintItem';
                element.append(name, inputs);
                return element;
            })
        );
    };

    // re-render for the current state, and pop up when `popup` is set
    const update = (popup: boolean) => {
        const hint = describe(state, localize);
        if (!state.loaded || state.xrMode || !hint || preference === 'off') {
            hide();
            return;
        }

        const signature = `${state.cameraMode}:${state.inputMode}:${state.gamingControls}`;
        if (signature !== rendered) {
            rendered = signature;
            render(hint);
        }

        if (preference === 'pinned' || popup) {
            panel.classList.add('sse-visible');
            hideAfter(SHOW_MS);
        }
    };

    const updateButtons = () => {
        pin.classList.toggle('sse-active', preference === 'pinned');
        settingsCheck.classList.toggle('sse-active', preference !== 'off');
    };

    // write changes only, so creating a viewer does not persist the default
    const setPreference = (value: Preference) => {
        preference = value;
        writePreference(value);
        updateButtons();
    };

    pin.addEventListener('click', () => {
        setPreference(preference === 'pinned' ? 'auto' : 'pinned');
        update(true);
    });

    close.addEventListener('click', () => {
        setPreference('off');
        hide();
    });

    settingsRow.addEventListener('click', () => {
        setPreference(preference === 'off' ? 'auto' : 'off');
        update(true);
    });

    // hold the panel up while the pointer is over it
    panel.addEventListener('pointerenter', clearTimer);
    panel.addEventListener('pointerleave', () => {
        if (panel.classList.contains('sse-visible')) hideAfter(LINGER_MS);
    });

    updateButtons();

    const popup = () => update(true);
    const subscriptions = [
        events.on('loaded:changed', popup),
        events.on('cameraMode:changed', popup),
        events.on('inputMode:changed', popup),
        events.on('gamingControls:changed', popup),
        events.on('xrMode:changed', popup)
    ];
    update(true);

    return () => {
        clearTimer();
        for (const subscription of subscriptions) subscription.off();
    };
};

export { initControlsHint };
