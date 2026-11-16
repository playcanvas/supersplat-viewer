import type { XrInputSource } from 'playcanvas';

/**
 * Whether an input source is a bare tracked hand. Some runtimes (SteamVR) also give a controller a
 * hand, posed from its finger sensors; it keeps its buttons and thumbsticks, so it stays a
 * controller. A bare hand has a generic-hand profile, or a gamepad with no axes, as the engine's
 * XR scripts tell them apart.
 *
 * @param source - The input source.
 * @returns True for a bare hand.
 */
const isHand = (source: XrInputSource) =>
    !!source.hand &&
    (!source.gamepad?.axes.length || source.profiles.some((profile) => profile.startsWith('generic-hand')));

export { isHand };
