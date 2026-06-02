type DomListener = (event: Event) => void;

/**
 * One DOM event's ordered, claimable handler list. `on(handler)` appends a
 * handler; `dispatch` runs them in subscription order and stops at the first
 * that returns `true` — the explicit **claim** (e.g. trackpad claims the wheel
 * so the keyboard-mouse reader doesn't also see it). Generic over the concrete
 * event type, so handlers are strongly typed at the call site.
 */
class DomEvent<E extends Event> {
    private _handlers: Array<(event: E) => boolean | void> = [];

    // Append a handler. Handlers run in subscription order; returning `true`
    // claims the event and skips the handlers registered after it.
    on(handler: (event: E) => boolean | void): void {
        this._handlers.push(handler);
    }

    // Internal — invoked by DomEventSource with the real DOM event.
    dispatch(event: E): void {
        const handlers = this._handlers;
        for (let i = 0; i < handlers.length; i++) {
            if (handlers[i](event) === true) {
                break;
            }
        }
    }
}

/**
 * Central DOM event source for the input subsystem. Constructed and
 * `attach(canvas)`'d explicitly by `InputController`, which binds one real
 * listener per event up front. Each managed event is exposed as a **typed**
 * `DomEvent<E>` member — subscribe with `source.wheel.on(handler)` etc., where
 * `handler`'s argument is the concrete event type. Keys + blur live on `window`,
 * everything else on the canvas; that split is fixed here so consumers never
 * think about targets.
 */
class DomEventSource {
    /** The attached canvas — readers use it for pointer-capture / pointer-lock checks. */
    canvas: HTMLCanvasElement | null = null;

    readonly wheel = new DomEvent<WheelEvent>();

    readonly pointerdown = new DomEvent<PointerEvent>();

    readonly pointermove = new DomEvent<PointerEvent>();

    readonly pointerup = new DomEvent<PointerEvent>();

    readonly pointercancel = new DomEvent<PointerEvent>();

    readonly pointerleave = new DomEvent<PointerEvent>();

    readonly lostpointercapture = new DomEvent<PointerEvent>();

    readonly contextmenu = new DomEvent<MouseEvent>();

    readonly keydown = new DomEvent<KeyboardEvent>();

    readonly keyup = new DomEvent<KeyboardEvent>();

    readonly blur = new DomEvent<FocusEvent>();

    private _bound: Array<{ target: EventTarget; type: string; fn: DomListener }> = [];

    attach(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this._bind(canvas, 'wheel', this.wheel);
        this._bind(canvas, 'pointerdown', this.pointerdown);
        this._bind(canvas, 'pointermove', this.pointermove);
        this._bind(canvas, 'pointerup', this.pointerup);
        this._bind(canvas, 'pointercancel', this.pointercancel);
        this._bind(canvas, 'pointerleave', this.pointerleave);
        this._bind(canvas, 'lostpointercapture', this.lostpointercapture);
        this._bind(canvas, 'contextmenu', this.contextmenu);
        this._bind(window, 'keydown', this.keydown);
        this._bind(window, 'keyup', this.keyup);
        this._bind(window, 'blur', this.blur);
    }

    detach(): void {
        for (const { target, type, fn } of this._bound) {
            target.removeEventListener(type, fn);
        }
        this._bound = [];
        this.canvas = null;
    }

    private _bind<E extends Event>(target: EventTarget, type: string, event: DomEvent<E>): void {
        const fn = (e: Event) => event.dispatch(e as E);
        target.addEventListener(type, fn, type === 'wheel' ? { passive: false } : undefined);
        this._bound.push({ target, type, fn });
    }
}

export { DomEvent, DomEventSource };
