import { Vec3 } from 'playcanvas';
import type { GSplatComponent } from 'playcanvas';

import type { CameraManager } from '../camera-manager';
import type { ScenePicker } from '../picker';
import { DEBUG_MODES } from '../quality';
import type { DebugMode } from '../quality';
import { loadedSplats, readEngineVisibleSplats } from '../render/resident-set';
import type { StochasticSplatRenderer } from '../render/stochastic-splat-renderer';
import type { Global } from '../types';

import { captureCameraState, restoreCameraState } from './camera-state';
import type { CameraStateSnapshot } from './camera-state';
import { PickDepthOverlay } from './pick-depth-overlay';

// Developer / debug panel. Hidden by default; surfaced via `?debug` URL
// param or Ctrl+Shift+D keyboard shortcut. DOM and styles are injected
// lazily on first show so there's no footprint on production URLs.

const STYLE_ID = 'sse-debug-panel-style';
const PANEL_CLASS = 'sse-debug-panel';

// every row and button the same height, a row's gap between rows and a group's before a group
const ROW_HEIGHT = 20;
const ROW_GAP = 2;
const GROUP_GAP = 8;
// every option of every choice the same width, so the choices line up at the right
const SEGMENT_WIDTH = '10ch';

const STYLES = `
.${PANEL_CLASS} {
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    left: max(8px, env(safe-area-inset-left));
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.7);
    color: #eee;
    font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    pointer-events: auto;
    user-select: none;
    /* a fixed width, wide enough for the longest labels, so the panel keeps its layout as
       values change and options are toggled */
    box-sizing: border-box;
    width: 56ch;
    max-width: calc(100% - 16px);
}
.${PANEL_CLASS} .sse-debug-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    white-space: nowrap;
    min-height: ${ROW_HEIGHT}px;
    margin-top: ${ROW_GAP}px;
}
.${PANEL_CLASS} .sse-debug-label {
    color: #888;
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value {
    color: #eee;
    font-variant-numeric: tabular-nums;
    cursor: text;
    padding: 0 4px;
    margin: 0 -4px;
    border-radius: 2px;
    transition: background-color 0.15s ease;
    outline: none;
    white-space: pre;
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value:hover {
    background: rgba(255, 255, 255, 0.08);
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value:focus {
    background: rgba(255, 255, 255, 0.12);
    box-shadow: inset 0 0 0 1px rgba(120, 180, 255, 0.45);
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value.sse-flash-ok {
    background: rgba(120, 220, 140, 0.35);
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-value.sse-flash-bad {
    background: rgba(220, 100, 100, 0.45);
}
.${PANEL_CLASS} button {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: rgba(255, 255, 255, 0.08);
    color: #eee;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    box-sizing: border-box;
    height: ${ROW_HEIGHT}px;
    padding: 0 8px;
    font: inherit;
    cursor: pointer;
    transition: background-color 0.15s ease;
}
.${PANEL_CLASS} button:hover {
    background: rgba(255, 255, 255, 0.16);
}
.${PANEL_CLASS} button.sse-flash {
    background: rgba(120, 220, 140, 0.35);
}
.${PANEL_CLASS} button.sse-flash-bad {
    background: rgba(220, 100, 100, 0.45);
}
.${PANEL_CLASS} input.sse-debug-paste {
    width: 100%;
    box-sizing: border-box;
    height: ${ROW_HEIGHT}px;
    margin-top: ${ROW_GAP}px;
    background: rgba(255, 255, 255, 0.08);
    color: #eee;
    border: 1px solid rgba(120, 180, 255, 0.6);
    border-radius: 3px;
    padding: 0 8px;
    font: inherit;
}
.${PANEL_CLASS} button.sse-debug-on {
    background: rgba(120, 180, 255, 0.35);
}
/* the camera's rows beside the view buttons, stacked a row each */
.${PANEL_CLASS} .sse-debug-top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 13ch;
    column-gap: 12px;
}
.${PANEL_CLASS} .sse-debug-stack {
    display: grid;
    row-gap: ${ROW_GAP}px;
    align-content: start;
}
/* a row whose label has small actions at the right */
.${PANEL_CLASS} .sse-debug-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    min-height: ${ROW_HEIGHT}px;
}
.${PANEL_CLASS} .sse-debug-head .sse-debug-actions {
    display: flex;
    gap: 4px;
}
/* a group's label on the line of its controls, which line up at the right */
.${PANEL_CLASS} .sse-debug-line {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    min-height: ${ROW_HEIGHT}px;
    margin-top: ${GROUP_GAP}px;
}
/* a control that does not apply to the renderer in use */
.${PANEL_CLASS} button:disabled {
    opacity: 0.35;
    cursor: default;
}
.${PANEL_CLASS} button:disabled:hover {
    background: rgba(255, 255, 255, 0.08);
}
.${PANEL_CLASS} .sse-debug-off .sse-debug-label {
    color: #555;
}
/* the splat counts: a label row over a value row */
.${PANEL_CLASS} .sse-debug-table {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    column-gap: 8px;
    row-gap: ${ROW_GAP}px;
    margin-top: ${GROUP_GAP}px;
}
.${PANEL_CLASS} .sse-debug-table > span {
    display: flex;
    align-items: center;
    min-height: ${ROW_HEIGHT}px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}
/* a choice of one: the options joined, the chosen one lit */
.${PANEL_CLASS} .sse-debug-segments {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: ${SEGMENT_WIDTH};
}
.${PANEL_CLASS} .sse-debug-segments button {
    border-radius: 0;
    margin-left: -1px;
}
.${PANEL_CLASS} .sse-debug-segments button:first-child {
    border-radius: 3px 0 0 3px;
    margin-left: 0;
}
.${PANEL_CLASS} .sse-debug-segments button:last-child {
    border-radius: 0 3px 3px 0;
}
`;

// the renderer and mode choices' tooltips
const MODE_TITLES: Record<DebugMode, string> = {
    sorted: "The engine's renderer: splats sorted by depth and blended",
    pixel: 'Stochastic, a coverage threshold per pixel (desktops)',
    mobile: 'Stochastic, interleaved pixel sets with jittered strata (phones, tablets)',
    sol: 'Stochastic, a solid ellipse per splat: the speed-of-light bound'
};

// a choice of one: a button per option
type Segments<T> = Map<T, HTMLButtonElement>;

// fills `host` with a button per option, each choosing its value
const segments = <T>(
    host: HTMLElement,
    options: readonly { value: T; label: string; title?: string }[],
    choose: (value: T) => void
) => {
    const buttons: Segments<T> = new Map();
    for (const { value, label, title } of options) {
        const button = document.createElement('button');
        button.textContent = label;
        if (title) button.title = title;
        button.addEventListener('click', () => choose(value));
        host.appendChild(button);
        buttons.set(value, button);
    }
    return buttons;
};

// the counts read back from the gpu: in view, drawn, and the depth cull's removals (null without it)
type SplatCounts = { onScreen: number; rendered: number; culled: number | null };

// a count compactly: thousands and millions
const count = (value: number | null) => {
    if (value === null) return '—';
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
    return `${value}`;
};

// lights the chosen option, or none
const light = <T>(buttons: Segments<T> | null, chosen: T | null) => {
    buttons?.forEach((button, value) => button.classList.toggle('sse-debug-on', value === chosen));
};

/** Show and query the viewer's MiniStats panel. */
type MiniStatsSwitch = {
    shown(): boolean;
    show(value: boolean): void;
};

// each component padded to a fixed width, so the values hold their place as the camera moves
const fmt = (v: Vec3) => [v.x, v.y, v.z].map((c) => c.toFixed(3).padStart(8)).join(',');

// Accepts "1,2,3", "1, 2, 3", "1 2 3", with or without trailing whitespace.
const parseVector = (text: string): [number, number, number] | null => {
    const parts = text
        .trim()
        .split(/[\s,]+/)
        .filter((p) => p.length > 0);
    if (parts.length !== 3) return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return [nums[0], nums[1], nums[2]];
};

class DebugPanel {
    private readonly _global: Global;

    private readonly _cameraManager: CameraManager;

    private readonly _picker: ScenePicker;

    // the stochastic renderer while it draws, for its depth cull toggle and counts: Performance
    // Mode switches it in and out, and its controls show only while it is in
    private _splatRenderer: StochasticSplatRenderer | null;

    private _stochasticSection: HTMLDivElement | null = null;

    private readonly _splatRendererChanged: { off(): void };

    // the choices, a button per option
    private _modeButtons: Segments<DebugMode> | null = null;

    private _taaButtons: Segments<'on' | 'off'> | null = null;

    private _cullButtons: Segments<'auto' | 'on' | 'off'> | null = null;

    // the splat counts
    private _loadedValue: HTMLSpanElement | null = null;

    private _selectedValue: HTMLSpanElement | null = null;

    private _onScreenValue: HTMLSpanElement | null = null;

    private _renderedValue: HTMLSpanElement | null = null;

    private _countsFrames = 0;

    private _countsPending = false;

    private _pickDepthOverlay: PickDepthOverlay | null = null;

    private readonly _focusTmp = new Vec3();

    private _root: HTMLDivElement | null = null;

    private _style: HTMLStyleElement | null = null;

    private _positionValue: HTMLSpanElement | null = null;

    private _focusValue: HTMLSpanElement | null = null;

    private _copyButton: HTMLButtonElement | null = null;

    private _pasteButton: HTMLButtonElement | null = null;

    // shown when the clipboard cannot be read (a cross-origin iframe without clipboard-read):
    // the paste event of a focused field carries the text without that permission
    private _pasteField: HTMLInputElement | null = null;

    private _miniStatsButton: HTMLButtonElement | null = null;

    // the viewer's MiniStats switch
    private readonly _miniStats: MiniStatsSwitch | null;

    private _screenshotButton: HTMLButtonElement | null = null;

    private _pickDepthButton: HTMLButtonElement | null = null;

    private _editing: HTMLSpanElement | null = null;

    private _editCanceled = false;

    private _visible = false;

    private _onPrerender = () => this._render();

    // the counts are the frame's, so they refresh after it
    private _onFrameEnd = () => this._renderCounts();

    private _onKeyDown = (event: KeyboardEvent) => {
        // Ctrl+Shift+D — also accept Meta+Shift+D on macOS for parity
        if (!this._global.state.inputEnabled) return;
        if (event.code === 'KeyD' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            this.toggle();
        }
    };

    constructor(
        global: Global,
        cameraManager: CameraManager,
        picker: ScenePicker,
        splatRenderer: StochasticSplatRenderer | null = null,
        miniStats: MiniStatsSwitch | null = null
    ) {
        this._global = global;
        this._cameraManager = cameraManager;
        this._picker = picker;
        this._splatRenderer = splatRenderer;
        this._miniStats = miniStats;
        this._splatRendererChanged = global.events.on(
            'splatRenderer:changed',
            (renderer: StochasticSplatRenderer | null) => {
                this._splatRenderer = renderer;
                this._renderStochastic();
            }
        );
        window.addEventListener('keydown', this._onKeyDown);
        if (global.config.debug) {
            this.show();
        }
    }

    show() {
        if (this._visible) return;
        this._visible = true;
        if (!this._root) {
            this._build();
        }
        this._root!.style.display = '';
        this._global.app.on('prerender', this._onPrerender);
        this._global.app.on('frameend', this._onFrameEnd);
        if (this._global.config.exposeGlobals) {
            window.getCameraState = () => captureCameraState(this._cameraManager, this._global.state);
            window.setCameraState = (snapshot) => restoreCameraState(this._cameraManager, this._global.state, snapshot);
        }
        this._render();
    }

    hide() {
        if (!this._visible) return;
        this._visible = false;
        if (this._root) {
            this._root.style.display = 'none';
        }
        // the view is only reachable from the panel, so it goes with it
        this._setPickDepth(false);
        this._global.app.off('prerender', this._onPrerender);
        this._global.app.off('frameend', this._onFrameEnd);
        if (this._global.config.exposeGlobals) {
            delete window.getCameraState;
            delete window.setCameraState;
        }
    }

    toggle() {
        if (this._visible) this.hide();
        else this.show();
    }

    destroy() {
        this.hide();
        this._pickDepthOverlay?.destroy();
        this._pickDepthOverlay = null;
        this._splatRendererChanged.off();
        window.removeEventListener('keydown', this._onKeyDown);
        if (this._root) {
            this._root.remove();
            this._root = null;
        }
        this._style?.remove();
        this._style = null;
    }

    private _build() {
        // both live in the viewer's root, so each instance carries and removes its own
        const host = this._global.root;

        if (!this._style) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = STYLES;
            host.appendChild(style);
            this._style = style;
        }

        const root = document.createElement('div');
        root.className = PANEL_CLASS;
        root.innerHTML = `
            <div class="sse-debug-top">
                <div>
                    <div class="sse-debug-head">
                        <span class="sse-debug-label">Camera</span>
                        <span class="sse-debug-actions">
                            <button data-id="copy" title="Copy the camera's state">Copy</button>
                            <button data-id="paste" title="Paste a copied camera state">Paste</button>
                        </span>
                    </div>
                    <div class="sse-debug-row"><span class="sse-debug-label">Position</span><span class="sse-debug-value" data-id="position" contenteditable="plaintext-only" spellcheck="false" title="Edit to set camera position">—</span></div>
                    <div class="sse-debug-row"><span class="sse-debug-label">Focus</span><span class="sse-debug-value" data-id="focus" contenteditable="plaintext-only" spellcheck="false" title="Edit to look at this point">—</span></div>
                </div>
                <div class="sse-debug-stack">
                    <button data-id="screenshot">Screenshot</button>
                    <button data-id="pick-depth" title="Show the depth a navigation pick finds at every pixel">Show depth</button>
                    <button data-id="ministats" title="Show the engine's MiniStats graphs (the viewer then renders every frame)">MiniStats</button>
                </div>
            </div>
            <input class="sse-debug-paste" data-id="paste-field" placeholder="Clipboard blocked here: paste with Ctrl/Cmd+V" spellcheck="false" style="display: none">
            <div data-id="renderer">
                <div class="sse-debug-line">
                    <span class="sse-debug-label">Renderer</span>
                    <div class="sse-debug-segments" data-id="mode"></div>
                </div>
                <div data-id="stochastic">
                    <div class="sse-debug-row"><span class="sse-debug-label">TAA</span><span class="sse-debug-segments" data-id="taa" title="Stochastic modes: accumulate the samples over frames (reprojected while the camera moves)"></span></div>
                    <div class="sse-debug-row"><span class="sse-debug-label">Depth cull</span><span class="sse-debug-segments" data-id="depth-cull" title="Stochastic modes: cull splats hidden in the previous frame's depth (auto suspends the test when it removes too little)"></span></div>
                </div>
            </div>
            <div class="sse-debug-table" title="Splats in the files loaded (in use or cooling down), selected by the level of detail and budget, in view after the frustum cull (and a stochastic mode's random coverage), and drawn after the depth cull, with the share it removed">
                <span class="sse-debug-label">Loaded</span>
                <span class="sse-debug-label">Splats</span>
                <span class="sse-debug-label">On screen</span>
                <span class="sse-debug-label">Rendered</span>
                <span data-id="loaded">—</span>
                <span data-id="selected">—</span>
                <span data-id="on-screen">—</span>
                <span data-id="rendered">—</span>
            </div>
        `;
        host.appendChild(root);

        this._root = root;
        this._positionValue = root.querySelector('[data-id="position"]')!;
        this._focusValue = root.querySelector('[data-id="focus"]')!;
        this._copyButton = root.querySelector('[data-id="copy"]')!;
        this._pasteButton = root.querySelector('[data-id="paste"]')!;
        this._screenshotButton = root.querySelector('[data-id="screenshot"]')!;
        this._pickDepthButton = root.querySelector('[data-id="pick-depth"]')!;
        this._miniStatsButton = root.querySelector('[data-id="ministats"]')!;
        this._pasteField = root.querySelector('[data-id="paste-field"]')!;
        this._wirePasteField(this._pasteField);
        if (this._miniStats) {
            this._miniStatsButton.addEventListener('click', () => {
                this._miniStats!.show(!this._miniStats!.shown());
                this._renderMiniStats();
            });
            this._renderMiniStats();
        } else {
            this._miniStatsButton.remove();
        }

        this._copyButton.addEventListener('click', () => this._copy());
        this._pasteButton.addEventListener('click', () => this._paste());
        this._screenshotButton.addEventListener('click', () => this._screenshot());
        this._pickDepthButton.addEventListener('click', () => {
            this._setPickDepth(!this._pickDepthOverlay?.enabled);
        });
        this._stochasticSection = root.querySelector('[data-id="stochastic"]')!;
        this._loadedValue = root.querySelector('[data-id="loaded"]')!;
        this._selectedValue = root.querySelector('[data-id="selected"]')!;
        this._onScreenValue = root.querySelector('[data-id="on-screen"]')!;
        this._renderedValue = root.querySelector('[data-id="rendered"]')!;
        // the renderer and mode where WebGPU offers them: sorted, pixel, mobile or sol
        const { quality } = this._global;
        if (quality.debugModes) {
            this._buildRendererControls(root);
        } else {
            // no choice of renderer here (WebGL), so none of its rows
            root.querySelector('[data-id="renderer"]')!.remove();
            this._stochasticSection = null;
        }
        this._renderStochastic();
        this._wireEditable(this._positionValue, 'position');
        this._wireEditable(this._focusValue, 'focus');
    }

    // the renderer and mode, and the stochastic renderer's choices
    private _buildRendererControls(root: HTMLElement) {
        const { quality } = this._global;
        this._modeButtons = segments(
            root.querySelector('[data-id="mode"]')!,
            DEBUG_MODES.map((mode) => ({
                value: mode,
                label: mode[0].toUpperCase() + mode.slice(1),
                title: MODE_TITLES[mode]
            })),
            (mode) => quality.setDebugMode(mode)
        );
        // each acts on the renderer in use; the rows are disabled while there is none
        const onRenderer =
            <T>(change: (renderer: StochasticSplatRenderer, value: T) => void) =>
            (value: T) => {
                if (!this._splatRenderer) return;
                change(this._splatRenderer, value);
                this._splatRenderer.applyVariant();
                this._renderCull();
            };
        this._taaButtons = segments(
            root.querySelector('[data-id="taa"]')!,
            [
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' }
            ] as const,
            onRenderer((renderer, value: 'on' | 'off') => {
                renderer.variant.taa = value;
            })
        );
        // on is both grid levels
        this._cullButtons = segments(
            root.querySelector('[data-id="depth-cull"]')!,
            [
                { value: 'auto', label: 'Auto' },
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' }
            ] as const,
            onRenderer((renderer, value: 'auto' | 'on' | 'off') => {
                renderer.variant.cull = value === 'on' ? 'l2' : value;
            })
        );
    }

    private _wireEditable(span: HTMLSpanElement, kind: 'position' | 'focus') {
        span.addEventListener('focus', () => {
            this._editing = span;
            this._editCanceled = false;
            // select all text so the user can start typing to replace
            const range = document.createRange();
            range.selectNodeContents(span);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        });
        // Stop key events from bubbling to the canvas / window listeners
        // (PlayCanvas KeyboardMouseSource and the wheel/key interrupt
        // listeners) so arrow keys, WASD, etc. behave as text editing
        // instead of moving the camera.
        const stopKey = (e: KeyboardEvent) => e.stopPropagation();
        span.addEventListener('keydown', (e) => {
            stopKey(e);
            if (e.key === 'Enter') {
                e.preventDefault();
                span.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this._editCanceled = true;
                span.blur();
            }
        });
        span.addEventListener('keyup', stopKey);
        span.addEventListener('keypress', stopKey);
        span.addEventListener('blur', () => {
            const wasCanceled = this._editCanceled;
            this._editing = null;
            this._editCanceled = false;
            // clear any leftover selection
            window.getSelection()?.removeAllRanges();
            if (wasCanceled) {
                this._render();
                return;
            }
            const parsed = parseVector(span.textContent ?? '');
            if (!parsed) {
                this._flashBad(span);
                this._render();
                return;
            }
            if (kind === 'position') {
                this._applyPosition(parsed);
            } else {
                this._applyFocus(parsed);
            }
            this._flashOk(span);
        });
    }

    private _setPickDepth(value: boolean) {
        if (value && !this._pickDepthOverlay) {
            this._pickDepthOverlay = new PickDepthOverlay(this._global.app, this._global.camera, this._picker);
        }
        if (this._pickDepthOverlay) {
            this._pickDepthOverlay.enabled = value;
        }
        this._pickDepthButton?.classList.toggle('sse-debug-on', value);
    }

    private _applyPosition(pos: [number, number, number]) {
        this._cameraManager.camera.position.set(pos[0], pos[1], pos[2]);
        this._cameraManager.snap();
    }

    private _applyFocus(focus: [number, number, number]) {
        // Keep camera position fixed; recompute angles + distance so the
        // camera looks at the new focus point. Camera.look() does the math
        // in place; snap() then re-seeds the active controller.
        const cam = this._cameraManager.camera;
        const from = this._focusTmp.copy(cam.position);
        const to = new Vec3(focus[0], focus[1], focus[2]);
        cam.look(from, to);
        this._cameraManager.snap();
    }

    private _render() {
        if (!this._visible || !this._positionValue || !this._focusValue) return;
        const cam = this._cameraManager.camera;
        cam.calcFocusPoint(this._focusTmp);
        // Skip the span currently being edited so user input isn't
        // overwritten by the per-frame refresh.
        if (this._editing !== this._positionValue) {
            this._positionValue.textContent = fmt(cam.position);
        }
        if (this._editing !== this._focusValue) {
            this._focusValue.textContent = fmt(this._focusTmp);
        }
    }

    // the mode in use, and the stochastic renderer's rows, which apply only while it draws
    private _renderStochastic() {
        if (!this._stochasticSection) return;
        light(this._modeButtons, this._global.quality.debugMode);
        const drawing = !!this._splatRenderer;
        this._stochasticSection.classList.toggle('sse-debug-off', !drawing);
        for (const buttons of [this._taaButtons, this._cullButtons]) {
            buttons?.forEach((button) => {
                button.disabled = !drawing;
            });
        }
        if (!drawing) {
            light(this._taaButtons, null);
            light(this._cullButtons, null);
        }
        this._renderCull();
    }

    // the stochastic renderer's choices as they are
    private _renderCull() {
        const renderer = this._splatRenderer;
        if (!renderer) return;
        const mode = renderer.variant.cull;
        light(this._cullButtons, mode === 'l1' || mode === 'l2' ? 'on' : mode);
        light(this._taaButtons, renderer.variant.taa);
    }

    // The counts, every few frames: loaded and selected from the engine, on screen and rendered
    // back from the gpu, the stochastic renderer's projector or the engine's frustum cull
    private _renderCounts() {
        if (!this._loadedValue || !this._selectedValue || this._countsPending || this._countsFrames++ % 15 !== 0)
            return;
        const { app, camera } = this._global;
        const gsplat = app.root.findComponent('gsplat') as GSplatComponent | null;
        this._loadedValue.textContent = count(loadedSplats(gsplat?.resource));
        this._selectedValue.textContent = count(app.stats.frame.gsplats);

        const renderer = this._splatRenderer;
        const layer = app.scene.layers.getLayerByName('World');
        const read: Promise<SplatCounts | null> = renderer
            ? renderer.readStats().then(({ survivors, occluded }) => ({
                  onScreen: survivors + occluded,
                  rendered: survivors,
                  culled: renderer.culling ? occluded : null
              }))
            : camera.camera && layer
              ? readEngineVisibleSplats(app, camera.camera, layer).then((visible): SplatCounts | null =>
                    visible === null ? null : { onScreen: visible, rendered: visible, culled: null }
                )
              : Promise.resolve(null);
        this._countsPending = true;
        read.then((counts) => {
            if (!this._onScreenValue || !this._renderedValue) return;
            this._onScreenValue.textContent = count(counts?.onScreen ?? null);
            const share =
                counts && counts.culled !== null && counts.onScreen > 0
                    ? `  −${((100 * counts.culled) / counts.onScreen).toFixed(0)}%`
                    : '';
            this._renderedValue.textContent = `${count(counts?.rendered ?? null)}${share}`;
        })
            .catch(() => {
                // a destroyed buffer or lost device; the next refresh tries again
            })
            .finally(() => {
                this._countsPending = false;
            });
    }

    // The clipboard api, else a selection copied with execCommand: the api is refused in a
    // cross-origin iframe without clipboard-write (superspl.at's local-frontend frame), while
    // the command still works there inside the click
    private async _copy() {
        const text = JSON.stringify(captureCameraState(this._cameraManager, this._global.state));
        let copied = false;
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
        } catch {
            // destroyed while the clipboard was refusing
            if (!this._root) return;
            const area = document.createElement('textarea');
            area.value = text;
            area.style.cssText = 'position: fixed; opacity: 0; pointer-events: none';
            this._root!.appendChild(area);
            area.select();
            try {
                copied = document.execCommand('copy');
            } catch {
                copied = false;
            }
            area.remove();
        }
        if (copied) {
            this._flash(this._copyButton);
        } else {
            console.warn('[debug-panel] copy failed');
            this._flashBad(this._copyButton!);
        }
    }

    // The clipboard api, else the paste field: reading needs clipboard-read, which a
    // cross-origin iframe only has when its embedder grants it
    private async _paste() {
        let text: string;
        try {
            text = await navigator.clipboard.readText();
        } catch {
            this._showPasteField(true);
            return;
        }
        // destroyed while the clipboard was being read
        if (!this._root) return;
        this._applyPasted(text);
    }

    private _applyPasted(text: string) {
        try {
            const snapshot = JSON.parse(text) as CameraStateSnapshot;
            restoreCameraState(this._cameraManager, this._global.state, snapshot);
            this._flash(this._pasteButton);
        } catch (err) {
            console.warn('[debug-panel] paste failed', err);
            this._flashBad(this._pasteButton!);
        }
    }

    private _showPasteField(value: boolean) {
        const field = this._pasteField;
        if (!field) return;
        field.value = '';
        field.style.display = value ? '' : 'none';
        if (value) field.focus();
    }

    private _wirePasteField(field: HTMLInputElement) {
        // keys typed here are text, not camera controls (see _wireEditable)
        const stopKey = (e: KeyboardEvent) => e.stopPropagation();
        field.addEventListener('keydown', (e) => {
            stopKey(e);
            if (e.key === 'Enter') {
                e.preventDefault();
                const text = field.value;
                this._showPasteField(false);
                this._applyPasted(text);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this._showPasteField(false);
            }
        });
        field.addEventListener('keyup', stopKey);
        field.addEventListener('keypress', stopKey);
        field.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData?.getData('text/plain') ?? '';
            this._showPasteField(false);
            this._applyPasted(text);
        });
        field.addEventListener('blur', () => this._showPasteField(false));
    }

    private _renderMiniStats() {
        if (!this._miniStats || !this._miniStatsButton) return;
        this._miniStatsButton.classList.toggle('sse-debug-on', this._miniStats.shown());
    }

    private _screenshot() {
        const app = this._global.app;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        // PlayCanvas runs with preserveDrawingBuffer off, so the canvas
        // pixels are only readable in the same task as the render. Force
        // a render and capture in frameend.
        app.renderNextFrame = true;
        app.once('frameend', () => {
            // Quality 1.0 with image/webp produces lossless WebP in
            // Chromium / Firefox. Safari (which lacks WebP encode) falls
            // back to PNG automatically — blob.type tells us which.
            canvas.toBlob(
                (blob) => {
                    if (!blob) {
                        console.warn('[debug-panel] screenshot toBlob returned null');
                        return;
                    }
                    const ext = blob.type === 'image/webp' ? 'webp' : 'png';
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `supersplat-viewer.${ext}`;
                    a.click();
                    URL.revokeObjectURL(url);
                    this._flash(this._screenshotButton);
                },
                'image/webp',
                1.0
            );
        });
    }

    private _flash(el: HTMLElement | null) {
        if (!el) return;
        el.classList.add('sse-flash');
        setTimeout(() => el.classList.remove('sse-flash'), 250);
    }

    private _flashOk(el: HTMLElement) {
        el.classList.add('sse-flash-ok');
        setTimeout(() => el.classList.remove('sse-flash-ok'), 250);
    }

    private _flashBad(el: HTMLElement) {
        el.classList.add('sse-flash-bad');
        setTimeout(() => el.classList.remove('sse-flash-bad'), 400);
    }
}

export { DebugPanel };
