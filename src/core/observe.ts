import type { EventHandler } from 'playcanvas';

// creates an observer proxy object to wrap some target object. fires events when properties change.
const observe = <T extends object>(events: EventHandler, target: T) => {
    const members = new Set(Object.keys(target));

    return new Proxy(target, {
        set(target, property, value, _receiver) {
            // prevent setting symbol properties
            if (typeof property === 'symbol') {
                console.error('Cannot set symbol property on target');
                return false;
            }

            // not allowed to set a new value on target
            if (!members.has(property)) {
                console.error('Cannot set new property on target');
                return false;
            }

            // set and fire event if value changed
            if ((target as unknown as Record<string, unknown>)[property] !== value) {
                const prev = (target as unknown as Record<string, unknown>)[property];
                (target as unknown as Record<string, unknown>)[property] = value;
                events.fire(`${property}:changed`, value, prev);
            }

            return true;
        }
    });
};

export { observe };
