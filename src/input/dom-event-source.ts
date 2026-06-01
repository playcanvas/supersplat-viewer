type DomTarget = 'canvas' | 'window';

type DomEventHandler = (event: Event) => boolean | void;

type DomListener = (event: Event) => void;

// The fixed set of DOM events the input subsystem dispatches. Bound up front on
// attach() — registration is an explicit step, never a side effect of on().
const CANVAS_EVENTS = [
    'wheel', 'pointerdown', 'pointermove', 'pointerup',
    'pointercancel', 'pointerleave', 'lostpointercapture', 'contextmenu', 'keydown'
];
const WINDOW_EVENTS = ['keydown', 'keyup', 'blur', 'pointerdown', 'pointermove'];

/**
 * Central DOM event source for the input subsystem. Registers exactly one real
 * listener per (target, event) on `attach(canvas)`, and dispatches each event to
 * its subscribers in **subscription order**. A handler returning `true` claims
 * the event — later handlers for that event are skipped (the explicit
 * replacement for `stopImmediatePropagation` + attach-order). `on()` only
 * registers handlers; it never touches the DOM.
 */
class DomEventSource {
    /** The attached canvas — readers use it for pointer-capture / pointer-lock checks. */
    canvas: HTMLCanvasElement | null = null;

    private _handlers = new Map<string, DomEventHandler[]>();

    private _bound = new Map<string, DomListener>();

    attach(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        for (const event of CANVAS_EVENTS) {
            this._bind('canvas', canvas, event);
        }
        for (const event of WINDOW_EVENTS) {
            this._bind('window', window, event);
        }
    }

    detach(): void {
        for (const [key, fn] of this._bound) {
            const event = key.slice(key.indexOf(':') + 1);
            const target = key.startsWith('canvas') ? this.canvas : window;
            target?.removeEventListener(event, fn);
        }
        this._bound.clear();
        this._handlers.clear();
        this.canvas = null;
    }

    on<E extends Event = Event>(target: DomTarget, event: string, handler: (event: E) => boolean | void): void {
        const key = `${target}:${event}`;
        const h = handler as DomEventHandler;
        const list = this._handlers.get(key);
        if (list) {
            list.push(h);
        } else {
            this._handlers.set(key, [h]);
        }
    }

    private _bind(target: DomTarget, el: EventTarget, event: string): void {
        const key = `${target}:${event}`;
        const fn = (e: Event) => this._dispatch(key, e);
        el.addEventListener(event, fn, event === 'wheel' ? { passive: false } : undefined);
        this._bound.set(key, fn);
    }

    private _dispatch(key: string, event: Event): void {
        const list = this._handlers.get(key);
        if (!list) {
            return;
        }
        for (let i = 0; i < list.length; i++) {
            if (list[i](event) === true) {
                break;
            }
        }
    }
}

export { DomEventSource };
export type { DomEventHandler };
