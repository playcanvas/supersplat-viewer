// creates an observer proxy object to wrap some target object. fires events when properties change.
const observe = (events, target) => {
    const members = new Set(Object.keys(target));

    return new Proxy(target, {
        set(target, property, value, receiver) {
            // not allowed to set a new value on target
            if (!members.has(property)) {
                console.log('err');
                return false;
            }

            // set and fire event if value changed
            if (target[property] !== value) {
                const prev = target[property];
                target[property] = value;
                events.fire(`${property}:changed`, value, prev);
            }

            return true;
        }
    });
};

export { observe };
