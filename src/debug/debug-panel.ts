import { Vec3 } from 'playcanvas';

import type { CameraManager } from '../camera-manager';
import type { Picker } from '../picker';
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
    min-width: 220px;
}
.${PANEL_CLASS} .sse-debug-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    white-space: nowrap;
}
.${PANEL_CLASS} .sse-debug-row .sse-debug-label {
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
.${PANEL_CLASS} .sse-debug-buttons {
    display: flex;
    gap: 6px;
    margin-top: 6px;
}
.${PANEL_CLASS} button {
    flex: 1;
    background: rgba(255, 255, 255, 0.08);
    color: #eee;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    padding: 4px 8px;
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
.${PANEL_CLASS} button.sse-debug-on {
    background: rgba(120, 180, 255, 0.35);
}
`;

const fmt = (v: Vec3) => `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;

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

    private readonly _picker: Picker;

    // the stochastic renderer when this viewer opted in, for its depth cull toggle and counts
    private readonly _splatRenderer: StochasticSplatRenderer | null;

    private _cullButton: HTMLButtonElement | null = null;

    private _taaButton: HTMLButtonElement | null = null;

    private _culledValue: HTMLSpanElement | null = null;

    private _cullStatsFrames = 0;

    private _cullStatsPending = false;

    private _pickDepthOverlay: PickDepthOverlay | null = null;

    private readonly _focusTmp = new Vec3();

    private _root: HTMLDivElement | null = null;

    private _style: HTMLStyleElement | null = null;

    private _positionValue: HTMLSpanElement | null = null;

    private _focusValue: HTMLSpanElement | null = null;

    private _copyButton: HTMLButtonElement | null = null;

    private _pasteButton: HTMLButtonElement | null = null;

    private _screenshotButton: HTMLButtonElement | null = null;

    private _pickDepthButton: HTMLButtonElement | null = null;

    private _editing: HTMLSpanElement | null = null;

    private _editCanceled = false;

    private _visible = false;

    private _onPrerender = () => this._render();

    // the cull state is decided inside the frame, so its row refreshes after it
    private _onFrameEnd = () => this._renderCull();

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
        picker: Picker,
        splatRenderer: StochasticSplatRenderer | null = null
    ) {
        this._global = global;
        this._cameraManager = cameraManager;
        this._picker = picker;
        this._splatRenderer = splatRenderer;
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
            <div class="sse-debug-row"><span class="sse-debug-label">camera</span><span class="sse-debug-value" data-id="position" contenteditable="plaintext-only" spellcheck="false" title="Edit to set camera position">—</span></div>
            <div class="sse-debug-row"><span class="sse-debug-label">focus</span><span class="sse-debug-value" data-id="focus" contenteditable="plaintext-only" spellcheck="false" title="Edit to look at this point">—</span></div>
            <div class="sse-debug-buttons">
                <button data-id="copy">Copy</button>
                <button data-id="paste">Paste</button>
            </div>
            <div class="sse-debug-buttons">
                <button data-id="screenshot">Screenshot</button>
                <button data-id="pick-depth" title="Show the depth a navigation pick finds at every pixel">Pick depth</button>
            </div>
            ${
                this._splatRenderer
                    ? `
            <div class="sse-debug-buttons">
                <button data-id="depth-cull" title="Stochastic renderer: cull splats hidden in the previous frame's depth (auto suspends the test when it removes too little)">Depth cull</button>
                <button data-id="taa" title="Stochastic renderer: accumulate the samples over frames (reprojected while the camera moves)">TAA</button>
            </div>
            <div class="sse-debug-row"><span class="sse-debug-label">culled</span><span class="sse-debug-value" data-id="culled">—</span></div>`
                    : ''
            }
        `;
        host.appendChild(root);

        this._root = root;
        this._positionValue = root.querySelector('[data-id="position"]')!;
        this._focusValue = root.querySelector('[data-id="focus"]')!;
        this._copyButton = root.querySelector('[data-id="copy"]')!;
        this._pasteButton = root.querySelector('[data-id="paste"]')!;
        this._screenshotButton = root.querySelector('[data-id="screenshot"]')!;
        this._pickDepthButton = root.querySelector('[data-id="pick-depth"]')!;

        this._copyButton.addEventListener('click', () => this._copy());
        this._pasteButton.addEventListener('click', () => this._paste());
        this._screenshotButton.addEventListener('click', () => this._screenshot());
        this._pickDepthButton.addEventListener('click', () => {
            this._setPickDepth(!this._pickDepthOverlay?.enabled);
        });
        if (this._splatRenderer) {
            this._cullButton = root.querySelector('[data-id="depth-cull"]')!;
            this._taaButton = root.querySelector('[data-id="taa"]')!;
            this._culledValue = root.querySelector('[data-id="culled"]')!;
            this._taaButton.addEventListener('click', () => {
                const renderer = this._splatRenderer!;
                renderer.variant.taa = renderer.variant.taa === 'on' ? 'off' : 'on';
                renderer.applyVariant();
                this._renderCull();
            });
            // cycles the cull mode: auto (the default) -> on (both grid levels) -> off
            this._cullButton.addEventListener('click', () => {
                const renderer = this._splatRenderer!;
                const next = { auto: 'l2', l2: 'off', l1: 'off', off: 'auto' } as const;
                renderer.variant.cull = next[renderer.variant.cull];
                renderer.applyVariant();
                this._renderCull();
            });
            this._renderCull();
        }
        this._wireEditable(this._positionValue, 'position');
        this._wireEditable(this._focusValue, 'focus');
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

    // the cull button shows the mode; the counts come back from the gpu every few frames
    private _renderCull() {
        const renderer = this._splatRenderer;
        if (!renderer || !this._cullButton || !this._culledValue) return;
        const mode = renderer.variant.cull;
        this._cullButton.textContent = `Depth cull: ${mode === 'off' ? 'off' : mode === 'auto' ? 'auto' : 'on'}`;
        this._cullButton.classList.toggle('sse-debug-on', mode !== 'off');
        if (this._taaButton) {
            this._taaButton.textContent = `TAA: ${renderer.variant.taa}`;
            this._taaButton.classList.toggle('sse-debug-on', renderer.variant.taa === 'on');
        }
        if (mode === 'off') {
            this._culledValue.textContent = 'off';
            return;
        }
        if (!renderer.culling) {
            this._culledValue.textContent = renderer.cullSuspended ? 'suspended' : 'no previous frame';
            return;
        }
        if (this._cullStatsPending || this._cullStatsFrames++ % 15 !== 0) return;
        this._cullStatsPending = true;
        renderer
            .readStats()
            .then(({ survivors, occluded }) => {
                const total = survivors + occluded;
                const pct = total > 0 ? ((100 * occluded) / total).toFixed(0) : '0';
                if (this._culledValue && renderer.culling) {
                    this._culledValue.textContent = `${pct}% (${occluded.toLocaleString()} of ${total.toLocaleString()})`;
                }
            })
            .catch(() => {
                // a destroyed buffer or lost device; the next refresh tries again
            })
            .finally(() => {
                this._cullStatsPending = false;
            });
    }

    private async _copy() {
        const snapshot = captureCameraState(this._cameraManager, this._global.state);
        try {
            await navigator.clipboard.writeText(JSON.stringify(snapshot));
            this._flash(this._copyButton);
        } catch (err) {
            console.warn('[debug-panel] copy failed', err);
        }
    }

    private async _paste() {
        try {
            const text = await navigator.clipboard.readText();
            const snapshot = JSON.parse(text) as CameraStateSnapshot;
            restoreCameraState(this._cameraManager, this._global.state, snapshot);
            this._flash(this._pasteButton);
        } catch (err) {
            console.warn('[debug-panel] paste failed', err);
        }
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
