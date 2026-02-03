import { Annotation } from './annotation';
import type { Annotation as AnnotationSettings } from './settings';
import type { Global } from './types';

type AnnotationEntry = {
    settings: AnnotationSettings;
    instance: Annotation;
};

class AnnotationNavigator {
    private global: Global;
    private entries: AnnotationEntry[];
    private currentIndex = 0;
    private hasActivated = false;

    private container: HTMLDivElement;
    private title: HTMLDivElement;
    private prevButton: HTMLButtonElement;
    private nextButton: HTMLButtonElement;

    constructor(global: Global, entries: AnnotationEntry[]) {
        this.global = global;
        this.entries = entries;

        this.container = document.createElement('div');
        this.container.id = 'annotationNavigator';
        this.container.setAttribute('role', 'group');
        this.container.setAttribute('aria-label', 'Annotation navigator');

        this.prevButton = this.createButton('Previous annotation', 'prev');
        this.nextButton = this.createButton('Next annotation', 'next');

        this.title = document.createElement('div');
        this.title.className = 'annotationNavigator-title';
        this.title.textContent = this.entries[0]?.settings.title ?? '';
        this.title.addEventListener('click', (event) => {
            event.stopPropagation();
            this.global.events.fire('inputEvent', 'interact', event);
            this.activateIndex(this.currentIndex);
        });

        this.container.append(this.prevButton, this.title, this.nextButton);

        const ui = document.querySelector('#ui');
        ui?.appendChild(this.container);

        this.prevButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.navigate(-1, event);
        });

        this.nextButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.navigate(1, event);
        });

        this.global.events.on('annotation.activate', (annotation: AnnotationSettings) => {
            const index = this.entries.findIndex((entry) => entry.settings === annotation);
            if (index !== -1) {
                this.currentIndex = index;
                this.hasActivated = true;
                this.updateTitle();
            }
        });
    }

    private createButton(label: string, direction: 'prev' | 'next') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `annotationNavigator-button annotationNavigator-${direction}`;
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', direction === 'prev' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-width', '2');

        svg.appendChild(path);
        button.appendChild(svg);

        return button;
    }

    private updateTitle() {
        this.title.textContent = this.entries[this.currentIndex]?.settings.title ?? '';
    }

    private navigate(direction: -1 | 1, event: Event) {
        if (this.entries.length === 0) {
            return;
        }

        this.global.events.fire('inputEvent', 'interact', event);

        if (!this.hasActivated) {
            const initialIndex = direction === 1 ? 0 : this.entries.length - 1;
            this.activateIndex(initialIndex);
            return;
        }

        const nextIndex = (this.currentIndex + direction + this.entries.length) % this.entries.length;
        this.activateIndex(nextIndex);
    }

    private activateIndex(index: number) {
        if (this.entries.length === 0) {
            return;
        }

        this.currentIndex = (index + this.entries.length) % this.entries.length;
        this.hasActivated = true;
        this.updateTitle();
        this.entries[this.currentIndex].instance.showTooltip();
    }
}

export { AnnotationNavigator };
