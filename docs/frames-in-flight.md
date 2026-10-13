# Frames-in-flight limiter (flat view on Vision Pro)

Status (2026-10-12): planned, not started. The user agreed to try this first, before a Vision Pro flat-view budget.

## Problem

Turning the camera in the flat (non-VR) view on the Vision Pro hitches badly. The user felt stalls of more than 50 ms, starting about 30 s into a scripted turn, with the debug panel showing `cull: suspended` after each hitch, and found it "fine after a few rotations".

## What the measurements showed

The scripts are in `.claude/xr-dev/` (`avp-flat-rotate-*.js`, `avp-flat-upload-ab.js`, `avp-flat-manual*.js`), and the results are in its README, section "2026-10-12 afternoon".

- The cpu side is smooth. Scripted turns (cold or warm, level or pitched, at 4M or 1M) had a median frame of 11 ms and a worst of about 45 ms. Each worst frame held one `copyExternalImageToTexture` of a LOD image, which costs about 6 ms on average and up to about 35 ms, the same at 1M.
- The gpu side is where the stall is. Timing gpu completion with `queue.onSubmittedWorkDone` at `frameend` (`avp-flat-manual-gpu.js`), busy views of the church at 3034x1482 lock to 45 fps (about 20 ms of gpu a frame). The gpu also runs 80-140 ms behind the cpu's submissions, so the image on screen is 4-7 frames older than the input. Safari's rAF keeps going while the gpu is behind.
- Culling was suspended (`cull: auto`) on 5 % of frames, none of them in the slow stretches.
- The Vision Pro's user agent says Macintosh, so it gets the desktop 4M budget. Flat mode uses `lodBehindPenalty` 5 and `lodUpdateAngle` 90; VR uses 1 and 0.

## The idea

Don't start a frame while the gpu is N or more frames behind. In flat mode the viewer renders on demand: `autoRender` is false once loaded, and `renderNextFrame` is set by the camera-change detection in `viewer.ts`'s `framerender` handler, by `frame:request` and by the stochastic renderer's accumulation. So a gate can hold the render without stopping the updates. The camera keeps integrating input, and the next frame drawn shows the latest pose instead of a queued old one.

Sketch:

- At `frameend` after a frame that rendered, add `device.wgpu.queue.onSubmittedWorkDone()` to a pending list. When it resolves, drop it, and if a frame is owed, set `app.renderNextFrame = true`.
- In a `framerender` listener that runs after the camera-change detection: if `renderNextFrame` is set and N or more frames are pending, clear it and mark a frame owed. The camera-change detection copies `prevWorld` whenever it sets `renderNextFrame`, so a held frame would never be asked for again if it weren't remembered here.
- Start with N = 2. That keeps the cpu and gpu overlapping and caps the lag near 40 ms at 20 ms of gpu a frame, against 80-140 ms now. N = 1 loses the overlap: the gpu idles while the cpu builds the next frame (about 11 ms).
- Flat view only. It is off while `app.xr.active`, where the compositor paces frames, and while `autoRender` is true during loading, where `renderNextFrame` isn't consulted.
- WebGPU only. The stochastic renderer is WebGPU only, and WebGL would need fence syncs.
- Teardown: remove the listeners in destroy, and check `destroyed` in the promise continuations.

## Things to check

- `capture.ts` sets `renderNextFrame` and reads the target at the next `frameend`, assuming that frame rendered. A held frame would capture an unrendered target. Either never hold a frame while a capture is pending, or have capture wait for a frame that actually rendered.
- Other code that awaits the next `frameend` after asking for a frame: `picker-frame-depth.ts`, `ui/annotations.ts`, `debug/pick-depth-overlay.ts`.
- `onSubmittedWorkDone` resolves through the event loop, a little after the gpu finishes. N = 2 absorbs that.
- It counts all submitted work, including LOD uploads and picker readbacks, which is what we want.

## How to test

- Run `avp-flat-manual-gpu.js` before and after while the user turns the camera by hand around the church. Expect the gpu lag to cap near N frames, with the frame rate unchanged (45 fps on busy views).
- Ask the user to rate the stalls subjectively.
- Check desktop Chrome and the Pixel for regressions in frame rate.

## If stalls remain

- A Vision Pro flat-view budget, e.g. 2-3M instead of the desktop 4M. The detection already exists as `visionPro` in `xr.ts`.
- The cost of LOD image uploads: `copyExternalImageToTexture` takes about 6 ms on average and up to about 35 ms on the main thread. Options are to decode ahead of time (`createImageBitmap` in a worker) or to spread the uploads across frames.
