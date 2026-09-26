# Pick Depth — Stochastic Picking and Annotation Occlusion

**Status:** stochastic pick pass, opacity-based annotation occlusion and the debug view implemented in `src/picker.ts`, `src/ui/annotations.ts`, `src/ui/annotation.ts`, `src/debug/pick-depth-overlay.ts` and `src/debug/debug-panel.ts`; everything in §5 is open; with the opt-in stochastic renderer (`docs/stochastic-renderer.md`) the pass is replaced by a snapshot of the frame's own depth (`src/picker-frame-depth.ts`, §5.4), the estimators shared
**Scope:** `@playcanvas/supersplat-viewer`, PlayCanvas engine (`playcanvas` 2.22.4)
**Author:** Donovan Hutchence

## 1. Summary

Annotation hotspots hid when they were plainly visible (annotation 3 of <https://superspl.at/scene/7f0a5157> vanished when zooming out a little), and navigation picks landed short of surfaces. Both came from the picker's depth estimate.

| # | Problem | Effect | Status |
| --- | --- | --- | --- |
| 1 | The pick shader weighted each fragment by the splat's peak opacity (`gaussianColor.a`), not its opacity at the fragment | with `alphaClip` at 1/255 every splat counted as a solid disc to its edge, so surfaces and silhouettes read nearer than they are (the post in front of annotation 3 read 2 units in front across the whole hotspot) | fixed, §2 |
| 2 | An alpha-weighted mean depth mixes everything along the ray | faint haze in front pulls it forward, a semi-transparent surface lets content behind pull it back; no weighting fixes both | replaced, §2 |
| 3 | Occlusion tested one pixel's mean depth against the annotation with a 5% tolerance | coarse streamed detail thickens surfaces by more than that | replaced, §2 |

## 2. What the picker does now

One stochastic render per camera pose, shared by every pick until the camera moves or finer detail streams in:

- Each splat fragment survives with probability equal to its falloff-weighted alpha. A MIN blend keeps each pixel's nearest survivor, so a pixel's value is nearer than a depth with probability equal to the scene's opacity in front of that depth, whatever order the splats draw in.
- The four channels of the RGBA16F target are four independent trials: a hash of the pixel, the splat's depth and a per-splat seed from its projected centre, which the picker patches into the three splat vertex chunks (pick pass only). Depth alone correlated splats at exactly the same depth: four overlapping splats of alpha 0.2 read 12–19% opacity instead of 59%, and now read 58–60% (WebGPU) and 54–61% (WebGL). Not the GPU-sort path's cache index, which changes from render to render; exact duplicates (same centre and depth) stay correlated.
- The target has one pixel per css pixel, capped at the backbuffer, so picking behaves the same in performance mode and at any device pixel ratio, and the pixel sizes below are css pixels. The splat budget still differs between modes, so picks can differ slightly with the resident detail.
- **Annotations** (`pickVisibility`): the share of samples over the hotspot's disc nearer than the annotation's depth less 10%. Hidden at 50% or more.
- **Navigation** (`pick`, `pickSurface`): the depth where the opacity in front first reaches 0.3, the 0.3 quantile over a 2 px disc (13 pixels × 4 trials). 0.5 was too strict: this capture's deck is only about 63% opaque with default streaming (75% at full detail), and a median went through it to the ground. Returns null where the opacity never reaches 0.3.
- **Debug view:** the debug panel's Pick depth button shows the navigation depth at every pixel, log distance with the palette repeating per doubling, magenta where no surface is found. It picks and resolves after each frame, only when the pick render changed, and trails the camera by a frame while it moves. Offscreen renders (`captureFrame`) do not show it: it follows the on-screen camera, whose framing a capture need not share.

## 3. Measurements

Scene 7f0a5157, default streaming budget, WebGPU on an M4 Max unless stated.

Annotation 3, zooming out along its view (1024×768):

| Camera distance | 3.2 | 4.5 | 5.0 | 5.4 | 6.0 | 7.0 |
| --- | --- | --- | --- | --- | --- | --- |
| Before | visible | visible | hidden | hidden | – | hidden |
| Now: opacity in front | 0% | 2.6% | 4.2% | 3.9% | 8.4% | 9.0% |
| Now | visible | visible | visible | visible | visible | visible |

From the start view the garden (91%), column (68%) and chair (61%) stay hidden; the title in open sky, the fireplace seen through the open side and the roof structure behind the clerestory glass show. WebGL matches within noise.

Surface picks on the deck against a reference (the depth where opacity in front reaches 0.5, bisected with `pickVisibility`): old pick 16–23% short at all four points; new pick within about 7%. The deck normals' y component went from 0.97, 1.00, 0.98, 0.48 to 1.00, 1.00, 1.00, 0.46 (the last point is the deck edge in both). A 7×7 patch of floor picks reads a smooth 3.1–4.0.

GPU cost, one pick rendered inside a frame and timed with the engine's timestamp profiler, 1161×2051 device pixels, medians over about 60 frames:

| | Old (mean depth, device res) | Stochastic, device res | Stochastic, css res (now) |
| --- | --- | --- | --- |
| Pick target | 1161×2051 | 1161×2051 | 909×1606 |
| Pick raster pass | 9.7–11.4 ms | 19.5–22.5 ms | 10.9–11.7 ms |
| Frame with a pick | ~21 ms | 30–33 ms | ~22 ms |
| Frame without | 5.2–7.0 ms | 5.2–5.8 ms | 6.4–7.4 ms |

This pane's pixel ratio is capped at 1.28 by the viewer's 2160 px limit, so css resolution is 1.6× fewer pixels here; on an uncapped 2× display it is 4×. Accuracy at css resolution (1024×768 against the earlier 1308×981): the same hidden and visible decisions everywhere, deck depths within 0.1 of before, deck normals y 1.00 / 0.99 / 0.98 (edge 0.37). Annotation 4 from the start view dropped from 61% to 53% opacity in front, close to the 0.5 threshold.

The picker used to switch `app.scene.gsplat.enableIds` on around each pick. That adds and removes the `pcId` stream in the work buffer's format, which forces a full work-buffer rebuild on the next frame, and the pass outputs depth, not ids. With the switch gone (same build, alternating runs, 909×1606): frame with a pick 20.5–20.8 ms against 22.5–23.1 ms, the 3.3–3.7 ms rebuild pass gone. Picks on WebGL return the same depths as WebGPU with ids off.

A pick runs once per camera stop in scenes with visible annotations, and per click; it is not a per-frame cost outside the debug view. The picker drops its cached render on every frame the engine reports detail still arriving (`frame:ready`), and once when it all has, so a still camera does not keep picking against stale content. GPU memory: one RGBA16F target at css resolution (8 B/px, 11.7 MB at 909×1606), which replaced the old device-resolution accumulation target. WebGL was not timed: the browser pane's timer throttling makes its read-back timings meaningless.

## 4. Not yet verified

- Other scenes. The thresholds (0.3 surface, 0.5 occlusion, 0.1 depth tolerance) are tuned on this one. Cover an object on an empty background (null picks and silhouettes, which this scene cannot test), an interior, a large outdoor scene, a sparse or hazy capture, and one with many annotations.
- The navigation cursor and fly-to by eye; only the numbers behind them were checked.
- Jitter while the camera moves: the trials are fixed per pose but change with it.
- The debug view's own teardown: the mount-loop harness never opens the debug panel.
- Why a pick pass rendered during a frame (in `prerender`) comes out empty, drawing nothing but its clear, while the same pick rendered after the frame (`frameend`) or between frames works. Reproduced on a fresh load with the scene state already sorted; once, a work-buffer rebuild made in-frame picks work for the rest of the page. All picks now run between frames, so nothing depends on it, but it would matter to anything that wants a pick inside a frame, such as the frame's own depth in 5.3.

## 5. Future plans

### 5.1 Pick pass cost

The stochastic raster pass takes twice as long as the old one. Candidates, unconfirmed: five hashes and four trial tests per fragment, MIN blending all four channels of a 16-bit float target, and the `discard`.

- Profile one trial against four, and R16F against RGBA16F. One trial in R16F is also 4× less memory and bandwidth. The noisy floor normals turned out to be the 0.5 threshold, not the sample count, so one trial may be enough at 0.3; re-check with the debug view.
- Half-resolution pick target: 4× fewer fragments and less memory, softer edges.
- The engine's pick path always sorts, back to front: `GSplatManager._fillPickParams` forces `stochastic = false` ("Picking needs sorted indices even when the work buffer has no per-splat IDs"), including in 2.23 where the forward render can skip the sort (#9443). The pass does not need an order at all: an engine option for an unsorted pick (the compacted order the stochastic forward path uses) removes the sort. The current pass has no depth test, so draw order cannot buy early-z rejection; a depth-tested single-trial pass drawn front to back could, which the editor measured at 16–25% on scenes with deep overdraw. Measure it against the four-trial MIN pass for speed and noise.
- Splats write their centre's depth across their whole quad, so a surface resolves into flat camera-facing plates, 1–10 cm apart here. This limits pick accuracy and made short-range normals useless in the debug view. The depth where each pixel's ray meets the splat's density peak is the Gaussian's conditional mean, `z = μz + Σz,xy Σxy⁻¹ (xy − μxy)`: a 2D slope per splat from the covariance the projection already has, two flat varyings, one dot product per fragment. On WebGL that is a patch to the splat vertex chunk; on WebGPU it needs two more words in the projector's cache (8 to 10), so it is an engine change.

### 5.2 GPU gather

Queries read raw blocks back and compute on the CPU: about 80 KB per surface pick, and one read-back per annotation (twenty annotations, twenty round trips). The CPU maths is negligible; the cost is read-back count and latency.

- WebGPU: upload the query list, one workgroup per query computing the opacity in front or the surface quantile, one small read-back for the batch. The ring points for normals become extra depth queries, with the plane fit on the CPU over 33 depths.
- WebGL: keep the CPU path, or a fragment-pass gather into an N×1 target.
- Interim: batch the annotation reads into one read-back of their bounding rectangle, or a few tiles.

This is the retrieval design in the editor's `depth-median-plan.md` (step 4 of its resolve), and it carries over unchanged to 5.3 and 5.4, since it only reads a texture.

### 5.3 Reusing the frame's depth

The engine (2.23, the viewer is on 2.22.4) can already write the splats' depth alongside the colour, as an extra full-screen attachment, with no second pass: `scene.gsplat.sceneDepthWrite` (#9175), requiring `CameraFrame`, R32F or R16F. What it holds depends on the forward mode:

- **Stochastic forward** (#9443): the surviving fragments are opaque and depth-tested, so each pixel holds the nearest survivor's depth, exactly the sample the estimators here use. No extra pass, no sort, early-z from the depth test, and the engine's blue-noise dither spreads the samples more evenly than the pick pass's white-noise hash. Check that the attachment outlives the frame so picks at rest can read it, and map css positions to its device resolution.
- **Sorted forward:** it holds a coverage-weighted average of 1/depth, a mean, so haze still pulls it forward. Either keep the dedicated pass for this mode, or change the engine so the sorted pass writes the stochastic trial into that attachment with a MIN blend (the attachment and its per-frame blend selection already exist).
- A second camera is not an alternative: each camera gets its own gsplat manager, with its own LOD, streaming and work buffer, and the stochastic setting is scene-wide.
- WebGL keeps the dedicated pass.

### 5.4 Stochastic renderer integration

The plan is to bring the editor's stochastic renderer (`supersplat/src/projected-splat-renderer.ts`) into the viewer as an always-on performance mode, alongside the sorted renderer. Either mode can then leave the pick depth behind, removing the dedicated pick render on WebGPU:

- **Stochastic mode:** each frame's depth buffer already holds the nearest survivor per pixel, exactly what the pick pass computes. It is one sample per pixel, stratified over 2×2 quads, against four trials now, so re-measure the surface estimate and widen the disc if needed.
- **Sorted mode:** the depth buffer cannot do it, because a discard or failed depth test drops the colour too. A second colour target with its own MIN blend can: the fragment writes its depth where its trial passes and the far plane where it does not. It needs a blend state per target (WebGPU yes; WebGL2 needs `OES_draw_buffers_indexed`).
- Writing that target in both modes gives one format and one reader. It persists after the frame, unlike the depth buffer, which the gizmo pass clears, so picks can read it any time the camera rests.
- The same map feeds the editor's previous-frame occlusion cull in both modes. In sorted mode that cull is an approximation: a culled splat still contributes its opacity times the (small) transmittance in front of it.
- Things that must not write it or be picked from it: captures and XR (other sizes and poses), and warped frames unless lookups apply `warpPosition`. The motion-time size and contribution culls thin surfaces, so a query frame should be unculled.
- WebGL keeps the dedicated pass: the editor renderer is compute-based.

### 5.5 Related

- The editor's picker has the same peak-opacity weighting bug; its `depth-median-plan.md` notes it.
- That plan weighs two exact resolvers (tile lists, multipass raster). Stochastic sampling is a third candidate: far cheaper, but statistical, returning some surviving Gaussian's depth, not necessarily the exact crossing Gaussian's.
- A general "are these 3D points visible" query would be useful beyond annotations, and belongs in the engine once 5.2 to 5.4 settle.
