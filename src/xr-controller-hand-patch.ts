import type { AppBase, Entity, XrInputSource } from 'playcanvas';

import { isHand } from './xr-input';

// TEMPORARY: some runtimes (SteamVR, on the Steam Frame) give a controller a hand, posed from its
// finger sensors, and the engine treats such a controller as a bare hand: no grip pose, a ray from
// the fingers, squeeze only with all four fingers folded, and XrControllers leaves its model where
// it was made. playcanvas/engine#10053 fixes that in the engine. Until the viewer requires an
// engine with it, these patches do the same from outside, through engine internals as of 2.24:
// delete this file and its uses then.

// the engine internals the patches reach
type SourceInternals = {
    _hand: HandInternals | null;
    _squeezing: boolean;
    update(frame: XRFrame): void;
};
type HandInternals = {
    update(frame: XRFrame): void;
    _fingerIsClosed(index: number): boolean;
};

const controllerHand = (source: XrInputSource) => !!source.hand && !isHand(source);

// Updates a controller with a hand as the controller it is: its hand's joints, then, with the hand
// set aside, the grip pose and target ray the engine gives a device. The hand's squeeze test reads
// back the grip button's squeeze, so it neither starts nor ends one
const patchSource = (source: XrInputSource) => {
    if (!controllerHand(source)) return;
    const internals = source as unknown as SourceInternals;
    const hand = internals._hand;
    const update = internals.update;
    hand._fingerIsClosed = () => internals._squeezing;
    internals.update = (frame: XRFrame) => {
        hand.update(frame);
        internals._hand = null;
        try {
            update.call(internals, frame);
        } finally {
            internals._hand = hand;
        }
    };
};

/**
 * Runs a callback with a controller's hand set aside, so engine code that would take the
 * controller for a bare hand (XrNavigation's palm test for the system menu) sees the device.
 *
 * @param source - The input source.
 * @param callback - The callback.
 * @returns The callback's result.
 */
const withoutControllerHand = <T>(source: XrInputSource, callback: () => T): T => {
    if (!controllerHand(source)) return callback();
    const internals = source as unknown as SourceInternals;
    const hand = internals._hand;
    internals._hand = null;
    try {
        return callback();
    } finally {
        internals._hand = hand;
    }
};

/**
 * Patches the controllers with a hand as the session adds them, and places their models at their
 * grips each frame after XrControllers, which only poses a hand's joints.
 *
 * @param app - The application.
 * @param models - XrControllers' models by input source.
 * @returns A handle that removes the patch for later input sources.
 */
const patchControllerHands = (
    app: AppBase,
    models: Map<XrInputSource, { entity: Entity; jointMap: Map<unknown, Entity> }>
) => {
    const added = app.xr.input.on('add', patchSource);
    const updating = app.on('update', () => {
        for (const [source, { entity, jointMap }] of models) {
            if (jointMap.size || !source.grip || !controllerHand(source)) continue;
            entity.setPosition(source.getPosition());
            entity.setRotation(source.getRotation());
        }
    });
    return {
        off() {
            added.off();
            updating.off();
        }
    };
};

export { patchControllerHands, withoutControllerHand };
