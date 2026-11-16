import type { AppBase, XrInputSource } from 'playcanvas';

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

// Runs a callback with the hands of the controllers among `sources` set aside, so engine code that
// would take them for bare hands sees the devices
const withoutControllerHands = <T>(sources: Iterable<XrInputSource>, callback: () => T): T => {
    const setAside: [SourceInternals, HandInternals][] = [];
    for (const source of sources) {
        if (!controllerHand(source)) continue;
        const internals = source as unknown as SourceInternals;
        setAside.push([internals, internals._hand]);
        internals._hand = null;
    }
    try {
        return callback();
    } finally {
        for (const [internals, hand] of setAside) internals._hand = hand;
    }
};

/**
 * Runs a callback with a controller's hand set aside, so engine code that would take the
 * controller for a bare hand (XrNavigation's palm test for the system menu) sees the device.
 *
 * @param source - The input source.
 * @param callback - The callback.
 * @returns The callback's result.
 */
const withoutControllerHand = <T>(source: XrInputSource, callback: () => T): T =>
    withoutControllerHands([source], callback);

/**
 * Patches the controllers with a hand as the session adds them, and runs XrControllers' update
 * with their hands set aside, so it shows and places their models as it does a device's: at the
 * grip, hidden only while the session is, rather than posing joints the model does not have and
 * hiding it whenever the hand loses tracking.
 *
 * @param app - The application.
 * @param controllers - The XrControllers script.
 * @returns A handle that removes the patch.
 */
const patchControllerHands = (app: AppBase, controllers: { update(dt: number): void }) => {
    const added = app.xr.input.on('add', patchSource);
    const update = controllers.update;
    controllers.update = (dt: number) =>
        withoutControllerHands(app.xr.input.inputSources, () => update.call(controllers, dt));
    return {
        off() {
            added.off();
            controllers.update = update;
        }
    };
};

export { patchControllerHands, withoutControllerHand };
