type Direction = 'left' | 'right' | 'top' | 'bottom';

class Tooltip {
    register: (target: HTMLElement, text: string, direction?: Direction) => void;

    unregister: (target: HTMLElement) => void;

    destroy: () => void;

    constructor(dom: HTMLElement) {
        const { style } = dom;

        style.display = 'none';

        const targets = new Map<HTMLElement, any>();
        let timer: number = 0;

        this.register = (target: HTMLElement, textString: string, direction: Direction = 'bottom') => {

            const activate = () => {
                const rect = target.getBoundingClientRect();
                const midx = Math.floor((rect.left + rect.right) * 0.5);
                const midy = Math.floor((rect.top + rect.bottom) * 0.5);

                switch (direction) {
                    case 'left':
                        style.left = `${rect.left}px`;
                        style.top = `${midy}px`;
                        style.transform = 'translate(calc(-100% - 10px), -50%)';
                        break;
                    case 'right':
                        style.left = `${rect.right}px`;
                        style.top = `${midy}px`;
                        style.transform = 'translate(10px, -50%)';
                        break;
                    case 'top':
                        style.left = `${midx}px`;
                        style.top = `${rect.top}px`;
                        style.transform = 'translate(-50%, calc(-100% - 10px))';
                        break;
                    case 'bottom':
                        style.left = `${midx}px`;
                        style.top = `${rect.bottom}px`;
                        style.transform = 'translate(-50%, 10px)';
                        break;
                }

                dom.textContent = textString;
                style.display = 'inline';
            };

            const startTimer = (fn: () => void) => {
                timer = window.setTimeout(() => {
                    fn();
                    timer = -1;
                }, 250);
            };

            const cancelTimer = () => {
                if (timer >= 0) {
                    clearTimeout(timer);
                    timer = -1;
                }
            };

            const enter = () => {
                cancelTimer();

                if (style.display === 'inline') {
                    activate();
                } else {
                    startTimer(() => activate());
                }
            };

            const leave = () => {
                cancelTimer();

                if (style.display === 'inline') {
                    startTimer(() => {
                        style.display = 'none';
                    });
                }
            };

            target.addEventListener('pointerenter', enter);
            target.addEventListener('pointerleave', leave);

            targets.set(target, { enter, leave });
        };

        this.unregister = (target: HTMLElement) => {
            const value = targets.get(target);
            if (value) {
                target.removeEventListener('pointerenter', value.enter);
                target.removeEventListener('pointerleave', value.leave);
                targets.delete(target);
            }
        };

        this.destroy = () => {
            for (const target of targets.keys()) {
                this.unregister(target);
            }
        };
    }
}

export { Tooltip };
