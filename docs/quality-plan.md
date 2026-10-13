# Adaptive quality: splat budget, renderer and resolution

Status (2026-10-13): plan, not started. It assumes two changes have landed first, both planned as the next pieces of work:

1. **Moving-object reprojection.** The stochastic renderer's temporal accumulation reprojects through the model's motion as well as the camera's, so an object grabbed in XR no longer leaves trails. Until then any measurement taken while an object moves is unrepresentative.
2. **The frames-in-flight limiter** ([frames-in-flight.md](frames-in-flight.md)). The viewer no longer queues frames while the gpu is behind, so the gpu lag stays bounded near two frames, and it already times gpu completion per frame. Auto builds on both: the timing is its signal, and the bounded lag keeps the experience usable while Auto is still settling.

## Where things stand

Today three things decide quality, in three places, from three different signals:

- **Device class**: the engine's `platform.mobile`, which is true only for Android and iPhone/iPad/iPod user agents. Apple Vision Pro and iPads in Safari's default desktop mode report a Mac, and Quest and Pico browsers report desktop Linux, so all of them get desktop settings.
- **Performance mode**: a user setting, on by default on mobile and off elsewhere, persisted per origin.
- **Standalone headset**: the viewer's own user-agent test for `OculusBrowser` / `PicoBrowser`, used only in XR.

| | resolution | budget | performance mode |
|---|---|---|---|
| mobile, flat | pixel ratio capped at 1080 px on the screen's short side | 2M | half resolution, 1M |
| desktop (incl. Vision Pro, iPad desktop mode, Quest/Pico windows), flat | capped at 2160 px | 4M | half resolution, 2M |
| XR on Quest/Pico | native per eye | 1M | 0.8x, 1M; always fixed foveation and a 72 Hz target |
| XR elsewhere (Vision Pro, PC VR, phone AR) | native per eye | the flat budget | the flat budget |

Performance mode also refreshes colours every 1 degree of turn instead of 0.2. Level-of-detail selection differs between flat and XR (`lodBehindPenalty` 5 / 1, `lodUpdateAngle` 90 / 0), not by mode. `?budget=N` overrides every budget. The renderer is the engine's sorted one unless the page opts in with `?stochastic` (per-pixel coverage) or `?stochastic=mobile` (interleaved pixel sets), WebGPU only, fixed for the viewer's life.

What this gets wrong:

- **The Vision Pro's flat window gets the full desktop treatment**: 4M at about 3034 x 1482, which locks busy views to 45 fps and is behind the stalls in [frames-in-flight.md](frames-in-flight.md). Quest and Pico windows and iPads in desktop mode get 4M too; only Quest and Pico XR sessions are lowered.
- **Nothing adapts.** A fast desktop never gets more than 4M, a slow laptop never less than 4M (outside performance mode), and the same device gets the same settings on a light object and a 17M city.
- **The user's only control is one switch** that halves both resolution and budget at once.

## Goals

- One place that decides budget, renderer and resolution for every platform and session type, with the reasons written down.
- Wider budget ladders: **desktop 2, 4, 8, 16M; mobile 1, 2, 4, 8M**.
- The stochastic renderer's two modes, `stochastic` and `stochastic-mobile`, chosen per device rather than per page.
- An **Auto** mode, the default, that gives the best detail the device sustains at its display's frame rate, without crashing it for memory, and that the user can override.

Not goals: changing the renderers themselves, changing what level of detail the engine picks for a given budget, or the settings schema (quality is a runtime preference of the viewer, not part of the artwork, so it stays out of `ExperienceSettings`).

## The quality model

A new module, `src/quality.ts`, owns three dials and applies them together. Nothing else sets `splatBudget`, sizes the canvas from performance mode, or picks the XR framebuffer scale.

### Device class

Decided once at startup, from the most reliable signal available:

1. **The gpu, where WebGPU reports it.** `GPUAdapterInfo` (`vendor`, `architecture`) tells a tile-based mobile gpu (Apple, ARM Mali, Qualcomm Adreno, Imagination PowerVR) from a desktop one, which the user agent cannot. On WebGL, `WEBGL_debug_renderer_info` where the browser exposes it (Safari masks it).
2. **The platform**: phone or tablet (`platform.mobile`, plus iPads in desktop mode: a Mac user agent with touch points and no visionOS), Apple Vision Pro (the existing `visionPro` test, the engine's `platform.visionos`), standalone headset (`standaloneHeadset`), desktop.
3. **The session**: flat, or XR, which has its own frame rate, resolution handling and starting point.

The class picks the ladder (desktop or mobile), the renderer, the starting level and the memory ceiling. The Vision Pro is a mobile-class device for the budget (an M2 with a tile-based gpu, and its flat window renders 4.5 million pixels) even though its user agent says desktop.

### Splat budget

Four levels per ladder:

| level | desktop | mobile (phones, tablets, Vision Pro, Quest/Pico) |
|---|---|---|
| Low | 2M | 1M |
| Medium | 4M | 2M |
| High | 8M | 4M |
| Ultra | 16M | 8M |

The budget is a ceiling: a scene with fewer splats than the level allows just draws them all, so a level means the same thing on every scene.

### Renderer

Picked at startup, never by the frame-rate loop. A switch recompiles shaders, reallocates the cache and the accumulation history, loses that history and changes the image's character, and the viewer does not support switching renderers at runtime today.

| device | renderer |
|---|---|
| WebGL (any) | sorted, the only one available |
| WebGPU, desktop gpu | `stochastic` (per-pixel coverage) |
| WebGPU, tile-based gpu (phones, tablets, Vision Pro, Quest/Pico) | `stochastic-mobile` (interleaved pixel sets) |
| a device whose storage-binding limit cannot hold the cache at Low | sorted |

The one exception Auto may make: if even Low misses the target by a wide margin, it may move once to `stochastic-mobile` at the next start (remembered with the level, below), never mid-session. `?stochastic`, `?stochastic=mobile` and a new `?stochastic=off` stay as overrides for development. Whether the stochastic renderer becomes the default on WebGPU at all is an open decision (below); until it is, Auto works the same with the sorted renderer, adjusting budget and resolution.

### Resolution

The pixel-ratio cap stays as it is (1080 px on the short side for phones and tablets, 2160 elsewhere) and is the normal resolution. Auto may lower the scale in steps of 0.85, 0.75 and 0.67 of normal, only as a last resort, after the budget has reached Low; it never goes below 0.67, and it raises resolution back before it raises the budget. In XR the resolution is fixed when the session starts (the projection layer's scale factor), so Auto never changes it within a session; standalone headsets keep their 0.8x at Low. Whether Auto may touch resolution at all is an open decision (below).

### Memory

Every level must fit before it is used, because phones and the Vision Pro kill the tab rather than slow down. What a level costs:

- **Per budget slot**: the engine's work buffer, 28 bytes a slot (allocated even with the direct data path until the engine's external renderer mode lands), and the stochastic cache, 24 bytes a slot (6 words), plus 12 bytes a slot for the second eye in stereo. About 52 bytes a slot flat, 64 in stereo: 16M slots is about 830 MB, 8M about 420 MB, before any splat data.
- **Per resident splat**: the files' own textures, which depend on the format (sog is the smallest). The M4 baselines put whole-viewer vram at 870-907 MB for the 4.4M church and 1.85-2.06 GB for the 17.5M Bowes scene.
- **Per pixel**: the accumulation history, 24 bytes a pixel with its ping-pong (50 MB at 1920 x 1080, 199 MB at 4K), and the frame's targets.

The guard before any level change:

- **Hard limits**: the WebGPU adapter's `maxStorageBufferBindingSize` and `maxBufferSize` for the cache at the level's slots (`StochasticSplatRenderer.cacheFits` already checks the binding), and the device's texture limits.
- **A ceiling per class**, lowered where the platform reports little memory (`navigator.deviceMemory`, Chrome only): Ultra on phones only with at least 8 GB reported, never on the Vision Pro until measured there.
- **A measured total**: the engine's vram counters (`device._vram`, as the remote page's heartbeat logs) after a level change, kept under a per-class share of the device's memory; a level that overshoots is dropped and not retried that session.

## Auto

### The signal

The **gpu frame time**, from the time between a frame's submission and its completion (`queue.onSubmittedWorkDone` on WebGPU, a fence sync on WebGL), which the frames-in-flight limiter already measures. Not frames per second: the viewer renders on demand, so an idle camera renders nothing, and the browser caps the frame rate at the display's refresh. Not gpu timestamps: Safari has none.

Samples count only while frames are continuous and the camera moves: an orbit, a fly or walk move, an XR head turn. They are dropped during loading and while the engine streams or uploads level-of-detail data (an image upload costs about 6 ms on average and up to about 35 ms on the Vision Pro, independently of the budget), and for a few frames after any quality change.

### The target

The display's frame time in flat view: 60, 90 or 120 Hz, estimated from the browser's frame intervals while rendering continuously, or a fixed 60 fps (an open decision, below). In XR, the session's frame rate (`XRSession.frameRate`, 72 or 90 Hz). A battery-saver preference, if performance mode becomes one, halves the flat target.

### The policy

- **Step down quickly**: when the 90th-percentile gpu time over about one second of motion exceeds 1.15 times the target.
- **Step up slowly**: when it stays under 0.7 times the target for several seconds of motion, the next level fits in memory, and preferably while the camera has come to rest, since a budget change makes the engine pick detail again and stream.
- **Hysteresis**: a level that was stepped down from is not retried for a while (doubling each time), so Auto does not oscillate between two levels.
- **Order**: budget first (coarser detail far away is the least visible loss), resolution only below Low, and the renderer fallback only between sessions.

### Starting point and persistence

Auto starts at Medium for the class (4M desktop, 2M mobile; 1M for Quest and Pico XR, as today) and remembers where it settled per device: a key from the gpu's description, the screen size and the session type, in local storage beside the other preferences. The next visit starts there, so a device learns once rather than every visit, and a heavy scene steps down from there and a light one simply never reaches the budget. A failed memory check is remembered too, so a level that crashed or overshot is not tried again on that device.

### XR

The same controller per session type, with its own remembered level: flat and XR settle independently, since the same device renders a 3000 x 1500 window and two 1888 x 1792 eyes at different rates. Auto adjusts only the budget during a session; the resolution and, on standalone headsets, fixed foveation are chosen at its start from the remembered level. On the Vision Pro the XR target is 90 Hz, which nothing on the ladder meets yet: with the shared stereo projection, 1M runs at about 70 fps and 4M at about 38 fps (344-358 and 187-194 frames in 5 s, church nave, 1888 x 1792 per eye). So XR on the Vision Pro starts at Low and stays there until the renderer gets faster; it is the case where the target cannot be met at Low and the resolution cannot change mid-session, so Auto reports it (debug panel) rather than acting on it.

## Settings, API and migration

- **The setting**: Quality, with Auto (the default), Low, Medium, High and Ultra, in the settings panel in place of Performance Mode, and in the VR menu as a row that cycles it. Manual levels hold the budget fixed and leave resolution normal.
- **State**: `state.quality: 'auto' | 'low' | 'medium' | 'high' | 'ultra'`, writable by a host and persisted like the other preferences; `state.qualityLevel`, read-only, the level Auto is at.
- **Flags**: `budget` stays and still overrides everything (Auto then holds it). `stochastic` gains `'off'`, and without the flag the renderer comes from the device table rather than defaulting to sorted, if the open decision below goes that way. A new `resolution` flag (a scale, for development) fixes the resolution.
- **Migration**: a stored `performanceMode: true` becomes Low (or the battery saver, per the decision below); `false` becomes Auto. `state.performanceMode` stays for one release as a deprecated alias that maps to Low and Auto.
- **The public types** (`src/options.ts`, `src/types.ts`) need JSDoc for the new fields, and `test/module/viewer-entry.test.mjs` checks them.

## Work, in order

1. **The quality module and the settings**: device classes, the ladders, the renderer table, the memory guard, the manual levels in the settings panel and the VR menu, the flags and the migration. Auto is a fixed level per class at this stage (Medium), which already fixes the Vision Pro's flat window (2M instead of 4M).
2. **The gpu frame-time sampler** on WebGPU and WebGL, built on the frames-in-flight limiter's timing, with the motion and streaming gates, shown in the debug panel beside the level so its readings can be checked by eye.
3. **The Auto controller**: the policy, the hysteresis, the persistence and the XR handling.
4. **Validation on the device matrix**: Pixel 7 Pro (mobile, Mali), Apple Vision Pro flat and XR, Quest 3 flat and XR, a MacBook (Apple silicon), a Windows desktop with a discrete gpu, an iPad in desktop mode, and Chrome on WebGL. On each: where Auto settles on the church, Bowes and an object (the toy cat), how long it takes, whether it oscillates, the peak vram, and the frame rate moving.

## Risks

- **A misleading signal**: completion timing includes work submitted outside the frame (uploads, picker readbacks), and some browsers resolve `onSubmittedWorkDone` late. The streaming gate and the 90th percentile over a window are the defences; step 2 shows the readings in the debug panel so they can be checked against what the eye sees.
- **Thermal throttling** on phones and headsets lowers the sustainable level over minutes. Stepping down handles it; the remembered level should decay back to the class's start after a while so a throttled session does not set the device's level for good.
- **Budget changes are visible**: picking detail again streams and pops. Stepping up only at rest, and at most once every several seconds, limits it.
- **Memory estimates are rough**: the per-class ceilings start conservative and are raised from the device matrix's measurements, not the other way round.

## Decisions for the user

1. **Resolution**: may Auto lower it below normal as a last resort, as above, or is resolution a fixed preference that Auto leaves alone?
2. **Default renderer**: should the stochastic renderer become the default on WebGPU (per the table), or stay opt-in with Auto applying to whichever renderer the page chose?
3. **The flat target**: the display's refresh rate (60, 90 or 120 Hz), or a fixed 60 fps everywhere?
4. **Performance mode**: does it become Low, or a battery saver that halves Auto's frame-rate target?
