// Public surface of the animation library: the runtime track type, playback
// state/cursor, and the built-in track generators (turntable / figure-8).
export type { AnimTrack } from './anim-track';
export { AnimState } from './anim-state';
export { AnimCursor } from './anim-cursor';
export { createRotateTrack } from './create-rotate-track';
export { createFigure8Track } from './create-figure8-track';
