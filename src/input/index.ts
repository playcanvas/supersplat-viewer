// Public surface of the input library: the per-frame input coordinator, the DOM
// event source it owns, the input frame, and the host contract + frame type.
// Internal building blocks (devices, schemes, movement-state) are not exported.
export { InputController } from './input-controller';
export { DomEvent, DomEventSource } from './dom-event-source';
export { InputFrame } from './input-frame';
export type { InputHost, CameraInputFrame } from './shared';
