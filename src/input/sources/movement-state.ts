/**
 * Per-pointer screen-coordinate movement tracker. Ported from the PlayCanvas
 * engine's `extras/input/utils.js`. Returns the screen-space delta since the
 * last move for a given pointer, used when native pointer-lock `movementX/Y`
 * is unavailable.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/movementX
 */
interface MovementState {
    down(event: PointerEvent): void;
    move(event: PointerEvent): [number, number];
    up(event: PointerEvent): void;
}

const movementState = (): MovementState => {
    const state = new Map<number, [number, number]>();
    return {
        down: (event) => {
            state.set(event.pointerId, [event.screenX, event.screenY]);
        },
        move: (event) => {
            const prev = state.get(event.pointerId);
            if (!prev) {
                return [0, 0];
            }
            const mvX = event.screenX - prev[0];
            const mvY = event.screenY - prev[1];
            prev[0] = event.screenX;
            prev[1] = event.screenY;
            return [mvX, mvY];
        },
        up: (event) => {
            state.delete(event.pointerId);
        }
    };
};

export { movementState };
export type { MovementState };
