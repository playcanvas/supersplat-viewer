# Stochastic splat renderer (WebGPU, opt-in)

An alternative to the engine's sorted splat renderer, selected per viewer at creation time with `?stochastic` in the standalone document or `createViewer({ stochastic: true })` for an embed. WebGPU only: on WebGL, and while an XR session is active, the engine's sorted renderer draws. A viewer without the flag never constructs it, patches nothing in the engine and changes no gsplat setting, so the sorted path is untouched.

It follows StochasticSplats (Kheradmand et al. 2025): every fragment keeps itself with probability alpha and writes opaque colour with hardware depth, so no sort is needed, and the depth buffer holds the nearest surviving sample per pixel, which later milestones reuse for the occlusion cull and for picking.

## Data flow

The engine keeps octree LOD, the splat budget, file streaming, reference counting and the block allocator that gives each resident node a slot range in the work buffer. The renderer consumes those decisions and owns everything after them.

```
engine                                              viewer (src/render/)
GSplatManager.update()
  world.update()      LOD / streaming
  world.bake()        work-buffer copy
  renderer.prepareRenderView()  <- switched off      EngineResidentSetProvider (frame:ready hook)
  fire frame:ready  ------------------------------>   ResidentSet on version change (files, nodes, slots, bounds)
                                                      StochasticSplatRenderer.frame()
                                                        cpu node frustum cull -> visibility bits
                                                        projector compute -> dense cache, survivor count
                                                        args compute -> indirect draw arguments
frame graph
  camera.beforePasses: sse-splat-raster              indirect instanced draw into RGBA8 + depth32
  forward pass: World opaque, Skybox, transparent    compose quad blends the target over the scene, writes depth
```

- `resident-set.ts` reads the engine's internal world state (`@ignore` api, narrowed to the members used) and switches the engine's own splat renderer off for the camera and layer: its render prep returns false, so the hybrid renderer never allocates its projector, sorter or cache, and its mesh instance is hidden. Restored on destroy and while XR is active.
- `splat-source.ts` is the seam for the data paths to be profiled. `splat-source-workbuffer.ts` is path (i), the engine's work buffer read through the engine's generated read code. Direct SOG reads and a light work buffer are the planned alternatives.
- `shaders/projector.ts`: one 256-thread workgroup per chunk-table entry (up to 256 splats of one node). Projection, size cull, contribution cull, offscreen cull, then a workgroup-aggregated append into a dense 28-byte-per-splat cache: ndc (snorm16), view depth, major axis, minor length | alpha | flags, rgb (10/10/10 + shared exponent), a reserved word for the popless depth gradient, and the stable splat id that seeds the coverage hash.
- `shaders/raster.ts`: reconstructs each quad from the cache, keeps fragments with a per-(2x2 quad, splat) stratified threshold (`spp:quad`) or a plain per-pixel one (`spp:1`).
- `shaders/compose.ts`: a fullscreen quad in the World layer's transparent sublayer; averages each 2x2 quad in `spp:quad`, applies the engine's `gsplatOutputVS` output transform once per pixel (so tonemapping, and the viewer's CameraFrame pass-through patch, behave as for the sorted renderer) and writes `frag_depth`.

The raster pass draws an explicit mesh-instance list through `renderForwardLayer` rather than a layer: a layer in `camera.layers` is culled once per frame and drawn by every pass for that camera, so the scene pass would draw the splats into the camera target too.

## Flags

| flag          | meaning                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `stochastic`  | opt in (creation time, WebGPU only)                                                                                   |
| `splatSource` | data path: `workbuffer` (default); `direct` and `light` are not implemented yet                                       |
| `variant`     | comma-separated `key:value` experiment switches: `spp` (1, quad), `compose` (blend, none, depth), `cull` (off, l1, l2, auto), `order` (append, bucket), `contribution` (threshold while moving, 0 off), `popless` (on, off), `taa` (on, off) with `taaMax`, `taaMoveMax`, `taaMotion`, `taaClip`, `taaFilter`, `taaReproj`, `taaRun`, `taaDebug`, `units` (engine, px), `colorMax` |

## Occlusion cull (M3)

Each pixel of the renderer's depth texture holds the nearest sample that survived there, so the farthest depth over the blocks a splat covered bounds what could still have shown behind it. At the start of the next frame's hook the previous depth is reduced to two grids (`shaders/reduce.ts`): the farthest depth per 8 px block, and per 32 px block as the maximum of 4x4 of those. The projector reprojects each splat's centre through the previous view, picks the grid from the footprint it had (8 px blocks up to 16 px, 32 px blocks up to 64 px, larger splats are not tested), reads the block under the centre first and gathers the neighbourhood only when that block alone would cull, and drops the splat when its front (centre less 2 sqrt(2) sigma along the view) lies beyond the maximum. Static splats reproject exactly, so only true disocclusions arrive a frame late.

The test is skipped, and the frame never becomes the previous one, when the previous frame drew elsewhere or at another size (a capture, a resize, performance mode), when a splat was removed since (its depth would hide what is behind it; arrivals are safe, so the cull stays on while a scene streams in), or when the projection type changed. A capture never culls unless the harness asks (`allowQueryCull`), so picks and thumbnails see every splat. At a fixed pose with the same seed the cull is exact: culled splats would have failed the depth test everywhere, and the harness's culled captures are bit-identical to unculled ones on every scene measured.

`cull:auto`, the default, reads each culled frame's counts back asynchronously and suspends the test for 60 frames (faster while the camera moves) whenever it removed less than 8 % of the splats, then probes again; the decision holds while a readback is in flight, and the projector is compiled with and without the test so a suspended cull costs nothing. The break-even came from Bowes: the reprojection and one grid load per splat cost 0.13 to 0.33 ms over 17.5 M splats, about what an 8 % cull saves in the raster.

Measured (`docs/bench/*-m3*.json`, minima of the round minima, since this session's medians drifted by up to 20 % between identical runs):

| scene, pose      | off ms | l2 ms | culled | auto                  |
| ---------------- | -----: | ----: | -----: | --------------------- |
| bicycle subject  |   4.19 |  3.60 |   39 % | on                    |
| church framed    |   2.49 |  1.44 |   43 % | on                    |
| church subject   |   4.85 |  2.95 |   77 % | on                    |
| windmill default |   5.11 |  5.18 |   12 % | on, a wash            |
| Bowes facade     |   8.32 |  8.26 |   26 % | on                    |
| Bowes wide       |   5.90 |  6.23 |    7 % | suspended, equals off |
| Bowes aerial     |   4.52 |  4.98 |  1.5 % | suspended, equals off |

Level 2 over level 1 matters where large splats occlude: church subject 456 k survivors with level 1 against 324 k with both. The reduce itself is one 65 µs profiler tick at 2081x1171.

## Popless depth (M5)

With one depth per splat (its centre's), two overlapping splats swap pixel ownership all at once when the camera moves their centres past each other: the popping of every sorted splat renderer, and of a stochastic one with flat quads. Section 3.4 of StochasticSplats instead gives each fragment the depth of the Gaussian's peak along its own view ray, which lies on the plane through the centre with normal Sigma^-1 (mu - o). The projector (`shaders/projector.ts`) forms that normal in view space from the adjugate of the view-space covariance it already has (no division by a flat splat's tiny determinant), stores the gradient g = n.xy / (n . mu) in the cache's word 5, and the raster tilts each corner onto the plane: a corner at view-space offset d from the centre lands at depth / (1 + g . d), on the same view ray as before, so the screen footprint is unchanged and hardware depth interpolation across the planar quad hands every fragment the plane's depth. Orthographic cameras use n = adj(Sigma) e_z and depth + g . d. The gradient is bounded so no corner leaves the centre's 2 sqrt(2) sigma_z band (the same margin the occlusion cull's front uses, so the cull stays conservative) and the perspective scale stays positive; the Gaussian falloff coordinate is interpolated screen-linearly so the footprint does not pick up the plane's perspective. It works on any scene: the formula uses only the position and covariance every trained splat has.

`popless:on` is the default; `popless:off` restores flat quads. `compose:depth` shows the splat depth as grey (24-bit log depth in rgb, for captures), and the harness reports a depth roughness for such captures: the mean step between neighbouring pixels in thousandths of the near-to-far log range. Measured at 1920x1080 (`docs/bench/2026-09-26-m4max-{bicycle,church}-m5.json`):

| scene, pose     | roughness off | roughness on | image vs sorted off / on (rms, noise floor) | ms off / on |
| --------------- | ------------: | -----------: | ------------------------------------------- | ----------: |
| bicycle framed  |         1.636 |        1.654 | 8.76 / 8.77 (6.64)                          | 0.92 / 0.92 |
| bicycle subject |         33.23 |        31.93 | not captured                                | 2.82 / 2.82 |
| church framed   |         1.789 |        1.781 | 1.35 / 1.35 (1.35)                          | 1.31 / 1.31 |
| church subject  |         29.42 |        29.00 | 12.53 / 12.70 (16.44)                       | 2.43 / 2.43 |

The stochastic choice of splat per pixel dominates the roughness (neighbouring pixels draw different splats), so the plate steps popless removes show as a 1 to 4 % drop on the in-scene poses and nothing on the framed ones, at no cost in the vertex stage and with the image still inside the sampling noise. A cleaner test of the surface itself needs a low-noise image, which is what TAA will provide; the pick normals of M6 will test it too.

## Temporal accumulation (M8, in progress)

One stochastic sample a pixel is a noisy estimate of the splat composite (a raw frame differs from the expectation by about 51 rms in 8-bit units on the church subject pose). `taa:on`, the default (`shaders/taa.ts`, the debug panel's TAA button), accumulates those samples over frames. The history is a premultiplied colour plus coverage per pixel, so coverage averages like any other quantity and the compose blends the result over the scene exactly as it blends a raw frame, and it is kept in 32-bit floats: a half-float mean stalls once the 1 / N increments fall below its resolution, which showed as an error floor of about 5 rms from N = 64. Beside it sits a depth record (mean, variance, count, run) in a second attachment of the same ping-pong target; the resolve is a fullscreen pass in `camera.beforePasses` after the raster, and the compose reads the accumulated texture instead of the raw one.

At rest every sample is accepted (a still camera cannot disocclude anything), the pixel is its own history texel, and the count grows to `taaMax` (256), the renderer requesting frames until it has (the request is made on `frameend`: the engine clears `renderNextFrame` right after `render()`, so a request from inside the frame is lost, which is what kept the history from accumulating at rest until 2026-09-26); the raster's coverage seed advances every frame while the accumulation runs. Measured against the mean of 128 to 256 raw frames the converged image is unbiased, its error the 51 / sqrt(N) of a mean, and against the sorted frame it lands at 6.1 rms on the church subject where a raw frame is 12.7 and the renderer's own expectation is 6.9 (the popless order and the culls differ from the sorted composite). Moving, the pixel's world point (through this frame's sample depth, or the history's mean depth where there is no sample) is carried into the previous view and the history fetched there with a Catmull-Rom filter, clamped to the mean plus or minus 1.25 standard deviations of the current frame's 3x3 neighbourhood (the anti-ghosting that matters: without it the moving error doubles), and blended at a cap of `taaMoveMax` (16) samples that shrinks with the image motion (`taaMotion`: 4 px a frame halves it). The shrinking cap is what makes motion work: a stochastic pixel's history is a mixture of layers reprojected through one layer's depth, so their parallax smears it by an amount that grows with the motion, and past a few pixels a frame the raw frame is the better estimate. The input while moving is the 2x2 quad resolve (four samples a pixel) rather than the pixel's own sample, which measured far lower error. The depth-distribution test that was to catch disocclusions (`taaRun`) is off: with fast adaptation it either reset semi-transparent pixels every few frames or accepted everything, and the colour clamp does the job.

Measured on the church (`docs/bench/2026-09-26-m4max-church-taa-*.json`, 1920x1080, rms against the sorted frame at the same pose; the raw frame is the 2x2 quad resolve):

| pose, motion                     | raw frame | taa   |
| -------------------------------- | --------: | ----: |
| subject, at rest (converged)     |     12.70 |  6.08 |
| subject, 3 deg/s orbit @60 / @180 |  13.4 / 15.6 | 9.6 / 12.0 |
| subject, 15 deg/s orbit @60 / @180 | 11.7 / 7.6 | 10.4 / 7.7 |
| framed, at rest                  |      2.45 |  2.29 |
| framed, 3 deg/s orbit            | 2.40 / 2.18 | 2.28 / 2.05 |
| framed, 15 deg/s orbit           | 2.14 / 2.11 | 2.05 / 2.05 |

Cost: at rest the resolve does not show in the frame minima (church subject 1.835 ms with and without it; it is one texel of history and one of the frame per pixel, under the 65 us profiler tick); moving it adds the 16-tap Catmull-Rom fetch, the 3x3 neighbourhood and the quad resolve, not isolated yet because the profiler folds the pass into its neighbour's slot whenever passes are toggled between variants. The debug panel toggles it at runtime; `taaDebug:1` shows count, acceptance and motion state, `taaDebug:2` the reprojection offsets.

Open: the history costs 64 bytes a pixel (two RGBA32F pairs, 133 MB at 1920x1080), which wants a compact info encoding and a single read-write history in a compute pass; sub-pixel jitter of the projection for anti-aliasing of small splats; the picker's use of the accumulated depth; and PROD scenes. Two bugs found on the way are worth knowing about: a material texture that is declared but never set makes the engine create and upload a placeholder inside the render pass, which on WebGPU submits the command buffer mid-pass and invalidates the frame (every declared texture is now bound every frame); and a matrix passed to a material by its data array and overwritten later in the same frame reaches the shader with the new value, since the material uploads when it draws (the previous-frame matrices are double-buffered).

## Size cull

The projector drops a splat whose footprint radius `sqrt(2 lambda1)` (with the 0.3 px dilation) is below half of `scene.gsplat.minPixelSize`. `minPixelSize` is a diameter: the engine dispatches its own projector with half the value, and its quad path tests the full extent `2 sqrt(2 lambda)` against the whole value, so both engine paths cut at 1 px for the default of 2. The M8 commit had the stochastic projector testing the radius against the whole value, a 2 px cut that removed fine detail (grass, foliage, distant texture) on PROD scenes while the sorted renderer kept it; restored on 2026-09-26. On the church subject pose the 2 px cut removed 22% of the survivors with no measurable image change, so a still interior does not show it. On the bicycle it does (`docs/bench/2026-09-26-m4max-bicycle-sizecull-{strict,restored}.json`, 1920x1080, raw frame and converged TAA against the sorted frame):

| pose    | cut  | survivors | ms   | raw vs sorted rms | TAA vs sorted rms | raw mean vs sorted rms |
| ------- | ---- | --------: | ---: | ----------------: | ----------------: | ---------------------: |
| framed  | 2 px |    28.7 k | 0.66 |              12.8 |              11.8 |                   12.0 |
| framed  | 1 px |   151.4 k | 1.05 |               8.8 |               6.3 |                    7.4 |
| subject | 2 px |    989 k  | 2.29 |              10.8 |               3.9 |                    9.2 |
| subject | 1 px |   1.64 M  | 2.88 |              10.7 |               3.7 |                    9.1 |

The bench takes `minPixelSize=<px>` for the stochastic mode only (and `minPixelSizeAll=<px>` for both), so the threshold can be varied against a fixed sorted reference. The threshold's units are the engine's since M1 (below): the radius the cull tests is the engine's `sqrt(2 lambda)`, which is 2 sqrt(2) sigma in true pixels.

## Correctness against the sorted image (M1)

Judged with the bench's converged accumulation against the sorted frame at the same pose, with the mean of 64 raw frames beside it (the renderer's own expectation) and a signed per-channel bias (`docs/bench/2026-09-26-m4max-{church,lion,hog,garden}-m1.json`, 1920x1080). The whole-scene framings the bench makes up are not representative on scenes with a sky, so the PROD scenes use their settings' start pose (`docs/bench/poses/`).

The one systematic difference found was units. The engine's projector works with `focal = viewport * projection[0][0]`, twice the pixel focal length, so its 2D covariance is in units of 4 px^2: its `+ 0.3` dilation is 0.075 px^2 in true pixels, its size cull at `minPixelSize / 2` cuts at a 2 sqrt(2) sigma radius of 1 px, and its contribution cull `opacity 2 pi sqrt(det) < 1` is four times as lenient as the same rule in true pixels. The stochastic projector used true pixels (the reference rasteriser's convention), which makes every small splat a little larger and drops more of the faint ones: nothing on a still interior of large splats, a brighter image on fur and grass, a darker one where faint small splats dominate. `units:engine` (the default now) reproduces the engine's convention; `units:px` keeps true pixels for comparison. Converged accumulation against the sorted frame, rms in 8-bit units and mean signed bias (r/g/b):

| scene, pose                | units:px rms | bias             | units:engine rms | bias                |
| -------------------------- | -----------: | ---------------- | ---------------: | ------------------- |
| church framed (PLY)        |         0.79 | 0.00/0.00/0.00   |             0.49 | -0.01/-0.01/0.00    |
| church subject (interior)  |         6.08 | -0.54/0.27/0.10  |             6.07 | -0.55/0.26/0.09     |
| lion start (SOG LOD)       |        10.52 | 1.49/1.61/1.76   |             3.43 | -0.02/0.00/0.04     |
| hog framed (SOG)           |         8.18 | -1.54/-1.65/-1.64 |            2.66 | -0.26/-0.22/-0.19   |
| hog subject                |         4.47 | 0.61/0.73/0.67   |             3.92 | -0.21/-0.08/-0.14   |
| garden start (SOG LOD)     |         9.84 | 1.40/1.85/1.48   |             5.44 | -1.62/-0.91/-0.48   |

The church subject pose sits inside the geometry among large interpenetrating splats; its residual is the sort order, radial distance in the engine against the raster's depth test: sorting the engine by view depth (`radial=0` in the bench) and turning popless off brings it to 3.7. The garden keeps a residual of 5.4 with a red bias spread over the foliage that the units, the far clamp, the sort order and the streaming state do not explain; open. Ruled out along the way, each by measurement: the sampler (`spp:1` and `spp:quad` accumulate to the same image), colour clamping (the work buffer's colour is already 8-bit), 8-bit blending in the sorted path, tonemapping (the default `linear` is the identity), stale work-buffer colour (the direct data path gives the same numbers), the LOD selection, and splats beyond the far plane (the raster now clamps clip z just inside it, as the engine clamps to it, since the compose reads depth 1 as empty; no visible change).

Two notes for the engine. Its dilation of 0.075 px^2 is a quarter of the reference rasteriser's, and its `minContribution` is in units of 4 px^2, so the same `minPixelSize` and `minContribution` values mean different things to the engine's splat renderer and to a renderer in true pixels. And the whole-scene framings and interior poses show that an rms against the sorted frame needs a signed bias beside it to mean anything: the noise floors of a converged accumulation are 0.2 to 0.5, the raw mean of 64 frames 1.5 to 6, so a 3 rms residual with zero bias is order and noise, a 1.6 bias is a renderer difference.

## Picking from the frame (M6)

In stochastic mode there is no pick pass. Every pixel of the renderer's depth texture is the nearest surviving sample, which is what the pass picker in `src/picker.ts` renders on purpose, so `src/picker-frame-depth.ts` snapshots that texture into the pass picker's encoding (normalised linear depth in four half-float channels at css resolution, 1 where nothing survived; the four channels are four of the device pixels the css pixel covers) and the shared estimators, the annotation occlusion test and the debug overlay read it unchanged. The renderer publishes `depthFrame` after each on-screen frame: the camera it was drawn with, the size and the clip-z mapping; a capture frame or XR clears it. A pick uses the last frame if the camera has not moved since, otherwise requests a frame and waits for its end, and unprojects with the frame's own camera. The viewer constructs this picker instead of the pass picker whenever the stochastic renderer exists; the sorted path keeps the pass picker on both backends. Consumers depend on the `ScenePicker` interface both implement.

Checked on the lion (7e4e9bcb) and the shoe: the pick-depth overlay shows continuous surfaces with no plates (the popless depth), a double-click focus lands on the splats, the sorted overlay is as before, and the teardown loop is clean. On the annotated reference scene (7f0a5157, start view) the occlusion test hides annotations 2, 3 and 4 and shows 1, 5 and 6 in both modes, as pick-depth.md section 3 records. Not yet measured: the surface estimate's noise with one sample per device pixel against the pass picker's four trials (the 0.3 quantile over a 2 px disc has 13 to 52 samples depending on the pixel ratio). With temporal accumulation on, each frame is a fresh sample, so a pick at rest reads one frame's samples, not the history; the history's mean depth is a mean, which is what pick-depth.md argued against.

## Draw order (M4)

The depth test makes the image independent of draw order, but not its cost: a fragment drawn behind an existing sample is rejected by early-z before the fragment shader runs, so drawing front to back turns overdraw into rejected fragments. `order:bucket` gets most of that from a counting sort. The projector writes each survivor's depth bucket (256 buckets, log-spaced over the fitted clip range) into the flags byte of its cache entry and counts its workgroup's buckets in shared memory, one global atomic per non-empty bucket. A one-workgroup scan turns the counts into offsets, and a scatter (`shaders/order.ts`, dispatched indirectly over the survivor count that the args pass also writes) places each survivor in its bucket, again aggregated per workgroup so consecutive cache slots, which come from one chunk, stay consecutive inside a bucket. The raster reads the cache through that list. Ordered captures are bit-identical to append ones.

Measured (`docs/bench/*-m4.json`, minima in ms; the append columns repeat the M3 numbers within a tick):

| scene, pose      | append | bucket | append + cull | bucket + cull |
| ---------------- | -----: | -----: | ------------: | ------------: |
| bicycle framed   |   1.18 |   1.05 |          1.31 |          1.18 |
| bicycle subject  |   4.19 |   3.08 |          3.54 |          2.75 |
| church framed    |   2.49 |   1.44 |          1.44 |          1.38 |
| church subject   |   4.78 |   2.69 |          2.95 |          1.97 |
| windmill default |   4.85 |   4.65 |          5.18 |          5.05 |
| Bowes wide       |   5.83 |   5.83 |          6.16 |          6.36 |
| Bowes facade     |   8.78 |   8.65 |          8.13 |          8.13 |
| Bowes aerial     |   4.52 |   4.59 |          4.92 |          5.05 |

The order and the cull are complementary rather than redundant: the cull removes splats that were fully hidden last frame, the order cheapens the fragments of the partly hidden ones that remain, and on the in-scene poses the pair beats either alone (church subject 4.78 to 1.97 ms, bicycle subject 4.19 to 2.75 ms). Outdoors the order is a wash, as the editor found: Bowes has little overdraw to reject, and the scatter plus the bucket atomics cost one to three profiler ticks (0.07 to 0.2 ms). `order:bucket` is the default. The scan is below a tick everywhere; the scatter is 0.07 to 0.33 ms depending on the survivor count.

Not measured yet: `order:node` (the chunk table sorted by node depth on the cpu, free but only meaningful on an octree scene, which needs a streamed SOG LOD file) and the engine's full radix sort, which the editor measured as slower than buckets because it loses tiler locality.

## Contribution cull while moving (M4)

`contribution:<t>` raises the projector's contribution threshold (a splat's opacity times its projected area in pixels, the engine's `minContribution` rule; the viewer's scene value is 1) to `t` on frames where the view changed, and requests one more frame at the scene's threshold once the camera has stopped, so a still image is never thinned. It is off by default (0). Measured on Bowes orbiting at 0.25 degrees a frame with the cull on, 1920x1080 (`docs/bench/2026-09-26-m4max-bowes-move-contribution.json`, minima in ms):

| pose   | scene threshold | 2    | 4    | 8    |
| ------ | --------------: | ---: | ---: | ---: |
| wide   |            5.90 | 4.33 | 3.08 | 2.56 |
| facade |            6.62 | 5.18 | 4.00 | 3.21 |
| aerial |            4.78 | 3.54 | 2.62 | 2.16 |

The saving is in the raster (fewer, larger splats survive) and a little in the projector's colour work. What the harness does not measure yet is what the raised threshold costs in the moving image; the editor tolerated it because the still frame is untouched. The plan's adaptive form (step the threshold toward a GPU-time budget, from the profiler's frame span) needs a per-frame GPU time signal in the viewer, which the engine's timestamp profiler can provide once enabled; that controller and its budget are a product decision and are not built.

Not measured: `cache:off` (projecting in the vertex shader instead of caching) and `clipCorner` (the engine's opacity-based quad shrink); both are cheap to add to the variant switch if wanted.

## Data paths (M4, decision pending)

`?splatSource=` selects how per-splat data reaches the projector; both paths stay in the tree until they have been compared on PROD scenes for frame time and memory together.

- `workbuffer` (default): the engine copies every resident node into its work buffer (24 bytes a splat, world space, sh colour baked for the current camera) and the projector reads that. The copy re-runs for a node when its lod changes and, for colour only, whenever the camera's direction to the node has turned by `colorUpdateAngle` (0.2 degrees in the viewer), which on a moving camera is nearly every frame for the near nodes.
- `direct`: the projector reads each resident file's own textures (sog, ply or compressed ply) through the engine's format read chunks (`splat-source-direct.ts`), applies the file's model transform and evaluates its sh per splat per frame. One projector compute per file, since a compute owns the uniform buffer its dispatch reads. Nothing is copied. Interim: the engine still allocates its work buffer and this source only switches its copy passes off, so the memory saving (about 32 bytes a splat) waits for engine change E2.

Both paths produce the same image (the diffs against the sorted frame agree to the noise floor on every pose measured). Measured at 1920x1080 (`docs/bench/2026-09-26-m4max-church*-*.json`, minima in ms):

| scene, pose, cull                                   | work buffer | direct |
| --------------------------------------------------- | ----------: | -----: |
| church still, framed, off                           |        1.31 |   1.51 |
| church still, framed, on                            |        1.11 |   1.25 |
| church still, subject, off                          |        2.43 |   2.95 |
| church still, subject, on                           |        1.57 |   1.77 |
| streamed church orbiting 0.25 deg/frame, framed, off |        3.93 |   1.97 |
| streamed church orbiting 0.25 deg/frame, framed, on  |        3.74 |   1.84 |

Still, direct pays 0.15 to 0.5 ms a frame for decoding, the transform and the sh evaluation over every resident splat (its projector is two to three times the work buffer's). Moving, the work buffer's colour refresh costs 2.6 ms a frame on the streamed church, more than the rest of the stochastic frame, and direct has no equivalent. The sorted renderer pays the same refresh (5.8 ms moving against 3.9 still). Not yet measured: PROD streamed scenes (many more files per frame, so more dispatches), memory once the work buffer is not allocated, and whether a cheaper colour refresh (a larger `colorUpdateAngle`, or baking sh0 only) changes the picture for the work buffer.

A colour-only cache for the direct path (decode geometry from the files, cache the sh-evaluated colour) was considered and set aside: in the direct projector colour is evaluated last, once per surviving splat (about 115 k a frame on the streamed church orbit), while any cache has to refresh every resident splat whose view direction moved (4.4 M there), which is exactly the shape of the engine's 2.6 ms refresh. What is not known yet is how direct's extra cost at rest splits between geometry decode over the resident splats and sh over the survivors (16 texels a survivor for sog); an `sh:<bands>` variant capping the evaluated bands would measure that and double as a moving-camera quality knob. Noted for later.

The streamed church used here was generated locally with splat-transform (three lods by decimation to 25 % and 6 %, 128 k-splat chunks, 44 files, 5.8 M splats); it lives in `public/church-lod/` and is not committed.

## Bench harness

`/bench?content=<url>` (source `src/dev/bench.html`, emitted with the dev build, never shipped) loads the scene once per mode, sorted then stochastic, sets each camera pose and measures every variant with the engine's GPU timestamp profiler while a MessageChannel pump drives frames as fast as the GPU takes them. Three round-robin rounds per pose; the table reports the median of the round medians and the minimum of the minimums, per-pass medians go to the log and the JSON. Stochastic frames are diffed against the sorted frame at the same pose (pixels changed by more than 8/255, mean absolute and RMS in 8-bit units) and against a second stochastic frame with another seed, which is the sampling noise floor. Memory is the engine's VRAM stats plus the renderer's own buffers, and the survivor count is read back from the GPU.

Parameters: `poses=<json url>` (the debug panel's `getCameraState` shape, or `{ name, position, target, fov }`; without it the scene is framed whole), `modes=sorted,stochastic`, `variants=cull:off;cull:l2;cull:auto` (`;` separated variant strings), `rounds=3`, `warmup=40`, `frames=180`, `width`/`height` of the host in css pixels, `budget=<millions>` (default 8; the engine allocates its work buffer for the whole budget, so keep it just above the scene), `splatSource=workbuffer|direct`, `move=<degrees>` (orbit the camera around its focus by this much per measured frame, restarting each round; 0 measures a still camera), `dpr=<ratio>` (pin the pixel ratio and screen size, since the desktop app's browser pane changes both with tab visibility; the target is then host size times the ratio), `nodiff`, `fx`, `hpr`. The page stops the viewer's own frame loop as soon as the viewer exists and pumps every frame itself (loading, framing, captures and measurement), because the desktop app's browser pane hides the page whenever it is not in front and a hidden page gets no `requestAnimationFrame`. A capture of a `compose:depth` variant reports its depth roughness instead of an image difference. Results are in `window.benchResults` and behind the download button; committed runs live under `docs/bench/`, pose files under `docs/bench/poses/`.

Local scenes: hard-link the editor's `dist/*.ply` files into `public/` (gitignored). The Bowes and windmill poses match the editor's measurements in `supersplat/webgpu-stochastic-order-results.md`.

## Checks

- `/mount-loop?content=./shoe.ply&iterations=20&stochastic` (and `&instances=2`): teardown releases every `sse-splat-*` texture; the harness reports `splat=true (n)`.
- Without the flag the same runs must behave as on `main`.
- `npm run lint`, `npm run fmt`, `npm run type:check`, and `npm test` when `src/options.ts` changes.

## Baseline numbers (M0 renderer, M2 harness)

Apple M4 Max, Chrome 152, 2026-09-25, `docs/bench/2026-09-25-m4max-*.json`. GPU frame span in ms, median of three round medians; stochastic is `spp:quad`, append order, no occlusion cull, no popless depth yet. Memory is the engine's VRAM total for the whole viewer.

| scene                      | pose    | sorted ms | stochastic ms | survivors | sorted MB | stochastic MB | vs sorted rms | noise rms |
| -------------------------- | ------- | --------: | ------------: | --------: | --------: | ------------: | ------------: | --------: |
| bicycle 6.1 M, 2081x1171   | framed  |      2.62 |          1.18 |     174 k |       686 |           629 |           8.6 |       6.6 |
| bicycle                    | subject |      8.32 |          4.26 |    1.70 M |       686 |           629 |          10.7 |      14.5 |
| church 4.4 M, 2081x1171    | framed  |      4.13 |          2.56 |     161 k |       907 |           872 |           1.3 |       1.4 |
| church                     | subject |      8.91 |          4.92 |    1.44 M |       907 |           872 |          12.5 |      16.4 |
| Bowes 17.5 M, 1635x920     | wide    |     11.53 |          5.05 |    1.84 M |      2049 |          1845 |          21.3 |      25.2 |
| Bowes                      | facade  |     16.32 |          7.47 |    3.66 M |      2060 |          1845 |          23.4 |      28.3 |
| Bowes                      | aerial  |      8.72 |          3.67 |    1.14 M |      2060 |          1845 |          21.4 |      18.6 |
| windmill 17.9 M, 2081x1171 | default |     10.09 |          4.92 |    1.26 M |      2370 |          2161 |          23.7 |      29.4 |

What the first pass says: the stochastic frame is 1.6 to 2.4 times faster than the sorted one everywhere measured, the difference to the sorted image is within one stochastic frame's own noise on seven of nine poses (Bowes aerial and the distant bicycle framing sit slightly above it), and `spp:1` and `compose:none` are indistinguishable from `spp:quad` in frame time, so the compose costs nothing measurable. Per pass, the projector over every resident splat costs 0.33 to 1.44 ms and the raster the rest; on Bowes the raster dominates (3.6 to 6.0 ms), which is what the occlusion cull and the ordering experiments target. Memory: the stochastic path saves the engine's 32-byte projected cache and sort buffers but adds its own 28-byte cache, so today it is 5 to 10 % below the sorted total; the data-path experiments (no work buffer) are where the larger saving is.

Two harness caveats: whole-scene framing size-culls most splats, so the subject pose (median of the splat centres) is the one to compare across renderers, and the canvas backing size follows the viewer's pixel-ratio cap (2160 over the screen's short side), so the target size is recorded in every result file.

## Status

M0 (skeleton), M2 (bench harness and baselines), M3 (occlusion cull), M4 (ordering, the direct data path, the moving-camera contribution cull, a moving-camera bench mode) and M5 (popless depth) are done, with the work-buffer against direct decision deferred until PROD scenes and the engine's external mode allow a memory comparison: the renderer draws, captures at another size, composes under CameraFrame, tears down cleanly, culls against the previous frame with an adaptive switch that stays on while a scene streams in, draws front to back through depth buckets, and reads either the work buffer or the resident files directly. Temporal accumulation (M8) is implemented, measured and on by default. Picking from the frame depth (M6) replaces the pick pass in stochastic mode. The correctness pass (M1) found and removed the one systematic difference to the sorted image, the covariance units; the garden's residual is open. Not yet: `cache:off` and `clipCorner`, the light work buffer (iii), the engine changes that remove the interim patches (M7), and the TAA memory and jitter work above. PROD streamed scenes await content urls.
