class PointerDevice {
    constructor(element) {
        this.target = null;

        element.addEventListener('wheel', (event) => {
            this.target?.wheel?.(event, element);
        }, { passive: false });

        element.addEventListener('pointerdown', (event) => {
            this.target?.pointerDown?.(event, element);
        });

        element.addEventListener('pointermove', (event) => {
            this.target?.pointerMove?.(event, element);
        });

        element.addEventListener('pointerup', (event) => {
            this.target?.pointerUp?.(event, element);
        });

        element.addEventListener('pointercancel', (event) => {
            this.target?.pointerCancel?.(event, element);
        });

        element.addEventListener('contextmenu', (event) => {
            this.target?.contextMenu?.(event, element);
        });

        window.addEventListener('keydown', (event) => {
            this.target?.keyDown?.(event, window);
        });

        window.addEventListener('keyup', (event) => {
            this.target?.keyUp?.(event, window);
        });
    }
}

export { PointerDevice };
