// The quality module: the one place that decides the splat budget, the renderer and the
// resolution for every device and session (docs/quality-plan.md, step 1). The user has two
// controls, the Quality slider (state.quality: performance, default, high, max) and the
// Stochastic toggle (state.stochastic); this module turns them into a budget from the device
// class's ladder, a resolution scale, the XR session's start parameters and the renderer, and
// disables the slider positions the device cannot hold (state.qualityAvailable).

import { platform } from 'playcanvas';
import type { AppBase, EventHandler, GraphicsDevice } from 'playcanvas';

import { StochasticSplatRenderer } from './render/stochastic-splat-renderer';
import type { Config, QualityLevel, State } from './types';

/** The slider's positions, left to right. */
const QUALITY_LEVELS: readonly QualityLevel[] = ['performance', 'default', 'high', 'max'];

// Standalone headsets run XR on a mobile gpu, which draws every splat once per eye, but their
// browsers report a desktop platform. Their sessions render with fixed foveation and a 72 Hz
// target, at 0.8x resolution at the Performance position, and from a ladder of their own
const standaloneHeadset = /OculusBrowser|PicoBrowser/.test(globalThis.navigator?.userAgent ?? '');

// Apple Vision Pro's Safari reports a Mac, but one with touch points. Its pinches aim by the eyes,
// which its teleports follow (iPad's Safari in desktop mode reports the
// same, but offers no VR; both are mobile-class devices for the budget)
const visionPro =
    /Macintosh/.test(globalThis.navigator?.userAgent ?? '') && (globalThis.navigator?.maxTouchPoints ?? 0) > 0;

// The budget ladders, millions of splats per slider position. A budget is a ceiling: a scene
// with fewer splats draws them all, and null is a position the ladder does not offer. Standalone
// headsets' two eyes at 1680x1760 cost more than any phone screen, so their sessions use the
// mobile ladder shifted down one position, without Max: a Quest 3 holds 3.8M at most (its 128 MiB
// storage binding), which it draws at 11-17 fps
const LADDERS: Record<'desktop' | 'mobile' | 'standaloneXr', readonly (number | null)[]> = {
    desktop: [2, 4, 8, 16],
    mobile: [1, 2, 4, 8],
    standaloneXr: [0.5, 1, 2, null]
};

// The resolution at the Performance position: half on screens (as the Performance Mode switch
// did), 0.8x of the recommended framebuffer in a standalone headset's session. The stochastic
// renderer keeps full resolution there: its image is already softer than sorted's
const PERFORMANCE_SCALE = 0.5;
const PERFORMANCE_XR_SCALE = 0.8;

// The memory model, from the device runs (docs/device-benchmarks-2026-10-14.md, Memory): the
// same on every gpu within 5-15 %. Per million of budget, with the scene's own data: the sorted
// renderer's work buffer, projector cache and sort; the stochastic renderer's cache and ordered
// list (no work buffer), plus its per-pixel targets (the accumulation history and the raster and
// set targets). The per-splat caches each sit in one storage binding, sorted's at 32 bytes a
// resident splat; the resident set runs a few percent over the budget (4.2M at 4M on the church)
const SORTED_MB_PER_MILLION = 110;
const STOCHASTIC_MB_PER_MILLION = 75;
const STOCHASTIC_BYTES_PER_PIXEL = 40;
const SORTED_CACHE_BYTES_PER_SPLAT = 32;
const RESIDENT_OVER_BUDGET = 1.1;

// The share of a device's gpu memory a viewer may plan on, in MB per class. Measured ceilings:
// an iPhone's tab is killed at 2.0-2.5 GB of gpu buffers with no error first; a Quest 3 loses its
// gpu process at about 3.8 GB; desktops held 2 GB without trouble and are unprobed. Conservative
// until the device matrix measures more, and scaled down where Chrome reports little memory
const CEILING_MB = { mobile: 1100, standaloneHeadset: 1900, desktop: 2600 };
const DEVICE_MEMORY_SHARE = 0.35;

// Level-of-detail selection: how much further away parts of the scene behind the camera count
// when choosing their detail, which saves a lot of splats while orbiting, and the turn after which
// detail is chosen again. XR sessions choose detail by distance alone, with no penalty and no
// turn-triggered choices: a head turning less than 90 degrees brought the coarse detail chosen
// for behind it into view
const LOD_BEHIND_PENALTY = 5;
const LOD_UPDATE_ANGLE = 90;

// How far the camera turns before splat colours are refreshed, degrees: coarser at Performance
const COLOR_UPDATE_ANGLE = 0.2;
const COLOR_UPDATE_ANGLE_PERFORMANCE = 1;

/** The resolution scale a slider position gives on a screen (the canvas backbuffer), for the sorted or the stochastic renderer. */
const resolutionScaleFor = (level: QualityLevel, stochastic: boolean) =>
    level === 'performance' && !stochastic ? PERFORMANCE_SCALE : 1;

type DeviceClass = {
    /** Which budget ladder the device uses on a screen. */
    ladder: 'desktop' | 'mobile';
    /** A Quest or Pico browser, which also reports a desktop platform. */
    standaloneHeadset: boolean;
    /** Apple Vision Pro (or an iPad in desktop mode). */
    visionPro: boolean;
    /** The WebGPU adapter's vendor and architecture, or WebGL's renderer string; for the record. */
    gpu: string;
};

type EngineDevice = GraphicsDevice & {
    gpuAdapter?: { info?: { vendor?: string; architecture?: string; description?: string } } | null;
    unmaskedRenderer?: string;
    wgpu?: { limits?: { maxStorageBufferBindingSize?: number } };
};

class Quality {
    readonly deviceClass: DeviceClass;

    /** Whether the Stochastic toggle is offered: WebGPU, and not a standalone headset. */
    readonly stochasticAllowed: boolean;

    private app: AppBase;

    private config: Config;

    private state: State;

    private renderer: Config['renderer'];

    private ceilingMB: number;

    private handles: { off(): void }[];

    constructor(app: AppBase, config: Config, state: State, events: EventHandler, renderer: Config['renderer']) {
        this.app = app;
        this.config = config;
        this.state = state;
        this.renderer = renderer;

        const device = app.graphicsDevice as EngineDevice;
        const info = device.gpuAdapter?.info;
        // the Vision Pro test (a Mac user agent with touch points) also matches a Mac with a touch
        // screen; a Mac's Apple gpu reports a metal architecture, the Vision Pro's and an iPad's do not
        const mac = info?.vendor === 'apple' && /^metal/.test(info.architecture ?? '');
        this.deviceClass = {
            ladder: platform.mobile || (visionPro && !mac) || standaloneHeadset ? 'mobile' : 'desktop',
            standaloneHeadset,
            visionPro,
            gpu: info
                ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ')
                : (device.unmaskedRenderer ?? '')
        };
        // the stochastic renderer runs on WebGPU; in a standalone headset it ties with the sorted
        // renderer at twice the memory (docs/device-benchmarks-2026-10-14.md, VR), so it is off there
        this.stochasticAllowed = renderer === 'webgpu' && !standaloneHeadset && config.stochastic !== 'off';

        const deviceMemoryGB = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
        const classCeiling = standaloneHeadset ? CEILING_MB.standaloneHeadset : CEILING_MB[this.deviceClass.ladder];
        this.ceilingMB = deviceMemoryGB
            ? Math.min(classCeiling, deviceMemoryGB * 1024 * DEVICE_MEMORY_SHARE)
            : classCeiling;

        // the available positions follow the renderer choice and the session
        this.handles = [
            events.on('stochastic:changed', () => this.updateAvailable()),
            events.on('xrMode:changed', () => this.updateAvailable()),
            events.on('quality:changed', () => this.updateAvailable())
        ];
        this.updateAvailable();
    }

    destroy() {
        for (const handle of this.handles) handle.off();
    }

    /** Whether the stochastic renderer should draw: forced by the flag, or chosen by the toggle where allowed. */
    get stochastic() {
        const { stochastic } = this.config;
        if (stochastic === true || stochastic === 'mobile') return this.renderer === 'webgpu';
        return this.stochasticAllowed && this.state.stochastic;
    }

    /** Which stochastic mode the device gets: per-pixel coverage on a desktop, interleaved pixel sets on a mobile-class device. */
    get stochasticMode(): 'pixel' | 'mobile' {
        if (this.config.stochastic === 'mobile') return 'mobile';
        if (this.config.stochastic === true) return 'pixel';
        return this.deviceClass.ladder === 'mobile' ? 'mobile' : 'pixel';
    }

    /** The budget for the current position, millions of splats. */
    get budget() {
        return this.budgetFor(this.state.quality) ?? this.fallbackBudget();
    }

    /** The canvas backbuffer scale for the current position. */
    get resolutionScale() {
        return resolutionScaleFor(this.state.quality, this.stochastic);
    }

    /** The XR session's framebuffer scale, fixed when the session starts. */
    get xrFramebufferScale() {
        return standaloneHeadset && this.state.quality === 'performance' ? PERFORMANCE_XR_SCALE : 1;
    }

    /** Whether an XR session renders with fixed foveation (standalone headsets; it only reaches the sorted renderer). */
    get xrFixedFoveation() {
        return standaloneHeadset;
    }

    /** The XR session's target frame rate where the viewer sets one, or null for the browser's. */
    get xrTargetFrameRate() {
        return standaloneHeadset ? 72 : null;
    }

    get colorUpdateAngle() {
        return this.state.quality === 'performance' ? COLOR_UPDATE_ANGLE_PERFORMANCE : COLOR_UPDATE_ANGLE;
    }

    get lodBehindPenalty() {
        return this.state.xrMode === null ? LOD_BEHIND_PENALTY : 1;
    }

    get lodUpdateAngle() {
        return this.state.xrMode === null ? LOD_UPDATE_ANGLE : 0;
    }

    /** The slider's positions with the budget each gives here, or null where the device cannot hold it. */
    levels(): { level: QualityLevel; budget: number | null }[] {
        const forced = this.config.budget;
        if (forced !== undefined && Number.isFinite(forced) && forced > 0) {
            return QUALITY_LEVELS.map((level) => ({ level, budget: forced }));
        }
        const ladder =
            standaloneHeadset && this.state.xrMode !== null ? LADDERS.standaloneXr : LADDERS[this.deviceClass.ladder];
        let previous = 0;
        return QUALITY_LEVELS.map((level, i) => {
            const rung = ladder[i];
            const fitted = rung === null ? null : this.fitBudget(rung);
            // a position clamped down to a lower one's budget adds nothing, and is disabled
            const budget = fitted !== null && fitted > previous ? fitted : null;
            if (budget !== null) previous = budget;
            return { level, budget };
        });
    }

    private budgetFor(level: QualityLevel) {
        return this.levels().find((entry) => entry.level === level)?.budget ?? null;
    }

    // the nearest available position below the chosen one, or the lowest available
    private fallbackBudget() {
        const levels = this.levels();
        const index = QUALITY_LEVELS.indexOf(this.state.quality);
        for (let i = index; i >= 0; i--) {
            const budget = levels[i].budget;
            if (budget !== null) return budget;
        }
        return levels.find((entry) => entry.budget !== null)?.budget ?? levels[0].budget ?? 1;
    }

    // whether the toggle can switch renderers here: allowed, and not forced on by the flag
    private get switchable() {
        const { stochastic } = this.config;
        return this.stochasticAllowed && stochastic !== true && stochastic !== 'mobile';
    }

    // The largest budget up to `budget`, in steps of 0.1M, that every renderer which may draw it
    // can hold: its cache in one storage binding and its estimated total under the ceiling; null
    // when none does. Where the toggle can switch renderers, both are fitted, so a switch never
    // changes the budget: the splats resident for one renderer's budget could overflow the other's
    // binding (sorted fails every frame past it) until coarser detail streamed in and the finer
    // files cooled down. It costs the stochastic renderer its headroom where it holds more (a
    // 128 MiB binding at the 4M rung, 4.0M against sorted's 3.8M; Max on Chrome reporting 4 GB or
    // less of memory)
    private fitBudget(budget: number) {
        const renderers = this.switchable ? [false, true] : [this.stochastic];
        for (let b = budget; b >= 0.1; b = Math.round((b - 0.1) * 10) / 10) {
            const fits = (stochastic: boolean) =>
                this.cacheFits(b, stochastic) && this.estimateMB(b, stochastic) <= this.ceilingMB;
            if (renderers.every(fits)) return b;
        }
        return null;
    }

    private cacheFits(budget: number, stochastic: boolean) {
        const device = this.app.graphicsDevice as EngineDevice;
        const resident = budget * 1e6 * RESIDENT_OVER_BUDGET;
        if (stochastic) return StochasticSplatRenderer.cacheFits(device, resident);
        const limit = device.wgpu?.limits?.maxStorageBufferBindingSize;
        return limit === undefined || resident * SORTED_CACHE_BYTES_PER_SPLAT <= limit;
    }

    private estimateMB(budget: number, stochastic: boolean) {
        if (!stochastic) return budget * SORTED_MB_PER_MILLION;
        const { canvas } = this.app.graphicsDevice;
        // a session draws two eyes; their size is not known before it starts, so the canvas stands in
        const pixels = canvas.width * canvas.height * (this.state.xrMode !== null ? 2 : 1);
        return budget * STOCHASTIC_MB_PER_MILLION + (pixels * STOCHASTIC_BYTES_PER_PIXEL) / 1048576;
    }

    private updateAvailable() {
        const available = this.levels()
            .filter((entry) => entry.budget !== null)
            .map((entry) => entry.level);
        const current = this.state.qualityAvailable;
        if (current.length !== available.length || current.some((level, i) => level !== available[i])) {
            this.state.qualityAvailable = available;
        }
        // a position the device cannot hold (stored from another device, or set by a host) falls
        // back to the nearest available below it, so the slider shows what is drawn
        if (available.length && !available.includes(this.state.quality)) {
            const index = QUALITY_LEVELS.indexOf(this.state.quality);
            const below = [...available].reverse().find((level) => QUALITY_LEVELS.indexOf(level) < index);
            this.state.quality = below ?? available[0];
        }
    }
}

export { Quality, QUALITY_LEVELS, resolutionScaleFor, standaloneHeadset, visionPro };
export type { DeviceClass };
