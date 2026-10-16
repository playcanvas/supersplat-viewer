# Frames-in-flight limiter

Status (2026-10-13): built (`src/frame-gate.ts`), default limit 2 on every platform, measured on Apple Vision Pro, a Pixel 7 Pro and an M4 Max Mac. The `framesInFlight` option (`?fif=` on the standalone and remote pages, 0 = off) is a developer knob for comparing.

## Problem

Turning the camera in the flat (non-VR) view on the Vision Pro hitched badly. The user felt stalls of more than 50 ms, starting about 30 s into a scripted turn, with the debug panel showing `cull: suspended` after each hitch, and found it "fine after a few rotations".

The first measurements (2026-10-12; scripts in `.claude/xr-dev/`, `avp-flat-rotate-*.js`, `avp-flat-upload-ab.js`, `avp-flat-manual*.js`, results in its README, section "2026-10-12 afternoon"):

- The cpu side is smooth. Scripted turns had a median frame of 11 ms and a worst of about 45 ms, each worst frame holding one `copyExternalImageToTexture` of a LOD image (about 6 ms on average, up to about 35 ms).
- The gpu is where the stall is. Busy views of the church at 3034x1482 run behind the cpu's submissions by 80-140 ms, so the image on screen is several frames older than the input, and Safari's rAF keeps going while the gpu is behind.

## What was built

The viewer renders on demand once loaded (`autoRender` false), so a frame renders only when something asks for one. `FrameGate.request()` replaces `app.renderNextFrame = true` for the requests made every frame:

- the camera-change detection in `viewer.ts`'s `framerender` handler (input moving the camera);
- the stochastic renderer's continuation frames (accumulating at rest, the raised contribution cull while moving), through its new `requestFrame` option.

The gate counts rendered frames the gpu has not finished. A request waits while `limit` are unfinished and is granted as soon as one finishes, so the next frame shows the camera where it is by then rather than a queued old pose. Completion comes from `queue.onSubmittedWorkDone()` on WebGPU and from a fence per frame on WebGL, checked at the start of every tick (cheap, no timers; a lost context clears them). A rendered frame is one that fired `postrender`, counted at its `frameend`, after all its work is submitted. The gate is open with a limit of 0 and whenever `autoRender` is on: during loading, and in XR sessions, which the compositor paces.

What it deliberately leaves alone: every one-shot request still sets `renderNextFrame` itself, so the code that waits for the frame it asked for (`capture.ts`, the frame-depth picker, `window.scrubTo`, the debug panel's screenshot, annotations) gets that frame at once. The engine's `frame:request` (streamed detail) also stays ungated, as it keeps the work buffer's textures tied to the frame that shows them.

## Results

Measured with `.claude/mobile-dev/fif-ab.js`: a level 360 degree turn over 8 s per run, alternating the limit in the same page so thermal drift hits both, after a warm-up turn. Per rendered frame it records the interval, the gpu lag (submission to completion) and the pose latency (the pose's age when its frame finished on the gpu), the closest measure to what the user feels. Latency is p50 / p90.

| device and view | renderer | limit 0 (off) | limit 2 |
|---|---|---|---|
| Vision Pro, Safari, church hitch view, 3014x1526, 4M | WebGPU stochastic-mobile | 82-84 fps, 133-135 / 170-173 ms | 65 fps, 33-35 / 45 ms |
| Vision Pro, same scene, smaller window (2092x1244) | WebGPU stochastic-mobile | 89 fps, 21 / 28-30 ms | 88-89 fps, 21-22 / 28-30 ms |
| Pixel 7 Pro, Chrome, church, 1079x2017, 2M | WebGPU stochastic-mobile | 38-42 fps, 119-127 / 138-144 ms | 36-45 fps, 47-55 / 57-64 ms |
| Pixel 7 Pro, Chrome, church, 1079x2017, 2M | WebGL sorted | 9-10 fps, 423-439 / 619-641 ms | 9-10 fps, 245 / 539-568 ms |
| M4 Max, Chrome, church, 1183x1294 and 3269x1839, 4M | WebGPU stochastic | 60 fps, 17-22 / 23-25 ms | identical, 0-3 requests held per run |
| M4 Max, Chrome, same | WebGL sorted | 55-59 fps, 23-29 / 28-33 ms | identical, 1 request held per run |

Other limits:

- **Pixel, WebGPU**: 1 halves the frame rate (22 fps, it loses the cpu and gpu overlap) for the same latency as 2 (48 ms); 3 gains no frame rate and adds about 30 ms (82-84 ms).
- **Vision Pro, hitch view**: 3 gives 68-69 fps at 44 / 56 ms, 4 gives 78 fps at 52 / 65 ms. Measured, each extra frame buys some frame rate for about 10 ms of latency there, but by hand the user found 2 "way better" than 4, which "was hitching badly", and than 0.

So the gate costs nothing where the gpu keeps up (it never holds), and where the gpu is behind it cuts the latency by 43-75 % at the same frame rate, or at about 20 % fewer frames on the Vision Pro, which still felt much better. Limit 2 is the default everywhere.

Measuring trap: the debug panel's `setCameraState` calls the camera manager's `snap()`, which sets `renderNextFrame` itself, so a script that drives the camera through it bypasses the gate; `fif-ab.js` clears that request after each pose so the frame is asked for as input would ask for it.

## If stalls remain

- **The budget**: the Vision Pro's flat window gets the desktop 4M. Treating it as mobile class, or stepping the budget down when the gpu falls behind, would lighten the gpu's load.
- **LOD image uploads**: `copyExternalImageToTexture` takes about 6 ms on average and up to about 35 ms on the main thread. Options are to decode ahead of time (`createImageBitmap` in a worker) or to spread the uploads across frames.
