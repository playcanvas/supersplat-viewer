import type { Entity } from 'playcanvas';

import type { CameraMode, InputMode } from '../core/modes';

/**
 * What the host application provides to the navigation modality — the only
 * coupling `nav-interaction` / `nav-cursor` have to the surrounding app's state
 * + camera. The viewer supplies a `global`-backed adapter; another app
 * implements these to drop the navigation modality in. (The intent `events` bus,
 * `collision`, and `picker` are injected separately — the bus is shared with the
 * camera manager by nature.)
 */
interface NavHost {
    /** The scene camera entity — position, projection, screen<->world. */
    readonly camera: Entity;
    /** The render canvas — offset normalisation + desktop cursor style. */
    readonly canvas: HTMLCanvasElement;
    /** Active camera mode (read-only — the orbit/walk→fly swap requests it via a `requestFirstPerson` intent). */
    readonly cameraMode: CameraMode;
    /** Desktop vs touch — gates the click-target affordances. */
    readonly inputMode: InputMode;
    /** Whether desktop gaming controls are enabled. */
    readonly gamingControls: boolean;
    /** Whether the scene is walk-sized — drives ring sizing + the walk hover ring. */
    readonly walkAllowed: boolean;
}

export type { NavHost };
