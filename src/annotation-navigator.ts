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
    private showAnnotations = true;

    private container: HTMLDivElement;
    private panel: HTMLDivElement;
    private collapsedBar: HTMLDivElement;
    private collapsedTitle: HTMLDivElement;
    private mobileNav: HTMLDivElement;
    private listButtons: HTMLButtonElement[] = [];
    private toggleButton: HTMLButtonElement;

    constructor(global: Global, entries: AnnotationEntry[]) {
        this.global = global;
        this.entries = entries;

        this.container = document.createElement('div');
        this.container.id = 'annotationList';
        this.container.setAttribute('role', 'region');
        this.container.setAttribute('aria-label', 'Annotation list');
        this.container.addEventListener('click', (event) => event.stopPropagation());

        this.collapsedBar = this.createCollapsedBar();
        this.panel = this.createPanel();
        this.mobileNav = this.createMobileNav();

        this.container.append(this.collapsedBar, this.panel, this.mobileNav);

        const ui = document.querySelector('#ui');
        ui?.appendChild(this.container);

        this.global.events.on('controlsHidden:changed', (hidden: boolean) => {
            this.container.classList.toggle('is-hidden', hidden);
        });

        this.setCollapsed(true);
        this.updateListSelection();
        this.updateCollapsedTitle();

        this.global.events.on('annotation.activate', (annotation: AnnotationSettings) => {
            const index = this.entries.findIndex((entry) => entry.settings === annotation);
            if (index !== -1) {
                this.currentIndex = index;
                this.hasActivated = true;
                this.updateListSelection();
                this.updateCollapsedTitle();
            }
        });

        this.global.events.on('annotation.navigate', (direction: -1 | 1, event?: Event) => {
            this.navigate(direction, event);
        });
    }

    private createPanel() {
        const panel = document.createElement('div');
        panel.className = 'annotationList-panel';

        const header = document.createElement('div');
        header.className = 'annotationList-header';

        const headerTitle = document.createElement('div');
        headerTitle.className = 'annotationList-title';
        headerTitle.textContent = 'ANNOTATION LIST';

        const collapseButton = this.createIconButton('Collapse annotation list', 'collapse');
        collapseButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.setCollapsed(true);
        });

        header.append(headerTitle, collapseButton);

        const toggleRow = document.createElement('div');
        toggleRow.className = 'annotationList-toggleRow';

        const toggleLabel = document.createElement('span');
        toggleLabel.textContent = 'Show Annotations';

        this.toggleButton = document.createElement('button');
        this.toggleButton.type = 'button';
        this.toggleButton.className = 'annotationList-toggle';
        this.toggleButton.setAttribute('aria-pressed', 'true');
        this.toggleButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.setAnnotationsVisible(!this.showAnnotations);
        });

        toggleRow.append(toggleLabel, this.toggleButton);

        const list = document.createElement('div');
        list.className = 'annotationList-items';

        this.entries.forEach((entry, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'annotationList-item';
            item.addEventListener('click', (event) => {
                event.stopPropagation();
                this.activateIndex(index, event);
            });

            const check = document.createElement('span');
            check.className = 'annotationList-check';
            check.textContent = '✓';

            const label = document.createElement('span');
            label.className = 'annotationList-itemText';
            label.textContent = entry.settings.title;

            item.append(check, label);
            list.appendChild(item);
            this.listButtons.push(item);
        });

        const navRow = document.createElement('div');
        navRow.className = 'annotationList-nav';
        navRow.append(
            this.createNavButton('Previous annotation', 'prev'),
            this.createNavButton('Next annotation', 'next')
        );

        panel.append(header, toggleRow, list, navRow);
        return panel;
    }

    private createCollapsedBar() {
        const bar = document.createElement('div');
        bar.className = 'annotationList-collapsedBar';

        const expandButton = this.createIconButton('Expand annotation list', 'expand');
        expandButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.setCollapsed(false);
        });

        this.collapsedTitle = document.createElement('div');
        this.collapsedTitle.className = 'annotationList-collapsedTitle';
        this.collapsedTitle.textContent = 'Annotations';

        const navGroup = document.createElement('div');
        navGroup.className = 'annotationList-collapsedNav';
        navGroup.append(
            this.createNavButton('Previous annotation', 'prev'),
            this.createNavButton('Next annotation', 'next')
        );

        bar.append(expandButton, this.collapsedTitle, navGroup);
        return bar;
    }

    private createMobileNav() {
        const nav = document.createElement('div');
        nav.className = 'annotationList-mobileNav';
        nav.append(
            this.createNavButton('Previous annotation', 'prev'),
            this.createNavButton('Next annotation', 'next')
        );
        return nav;
    }

    private createNavButton(label: string, direction: 'prev' | 'next') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `annotationList-navButton annotationList-navButton--${direction}`;
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
        button.appendChild(this.createArrowIcon(direction));

        button.addEventListener('click', (event) => {
            event.stopPropagation();
            this.navigate(direction === 'prev' ? -1 : 1, event);
        });

        return button;
    }

    private createArrowIcon(direction: 'prev' | 'next') {
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
        return svg;
    }

    private createIconButton(label: string, type: 'collapse' | 'expand') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `annotationList-iconButton annotationList-iconButton--${type}`;
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        if (type === 'expand') {
            path.setAttribute('d', 'M4 6h12M4 12h12M4 18h12');
        } else {
            path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
        }
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-width', '2');

        svg.appendChild(path);
        button.appendChild(svg);

        return button;
    }

    private setCollapsed(collapsed: boolean) {
        this.container.classList.toggle('is-collapsed', collapsed);
    }

    private setAnnotationsVisible(visible: boolean) {
        this.showAnnotations = visible;
        this.toggleButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
        this.container.classList.toggle('annotations-hidden', !visible);
        this.global.events.fire('annotations.visible', visible);
    }

    private updateListSelection() {
        this.listButtons.forEach((button, index) => {
            const isActive = this.hasActivated && index === this.currentIndex;
            button.classList.toggle('is-active', isActive);
        });
    }

    private updateCollapsedTitle() {
        if (!this.collapsedTitle) {
            return;
        }

        if (!this.hasActivated || this.entries.length === 0) {
            this.collapsedTitle.textContent = 'Annotations';
            return;
        }

        const entry = this.entries[this.currentIndex];
        const labelText = entry.instance.label ? `${entry.instance.label} ${entry.settings.title}` : entry.settings.title;
        this.collapsedTitle.textContent = labelText;
    }

    private navigate(direction: -1 | 1, event?: Event) {
        if (this.entries.length === 0) {
            return;
        }

        if (event) {
            this.global.events.fire('inputEvent', 'interact', event);
        }

        if (!this.hasActivated) {
            const initialIndex = direction === 1 ? 0 : this.entries.length - 1;
            this.activateIndex(initialIndex, event);
            return;
        }

        const nextIndex = (this.currentIndex + direction + this.entries.length) % this.entries.length;
        this.activateIndex(nextIndex, event);
    }

    private activateIndex(index: number, event?: Event) {
        if (this.entries.length === 0) {
            return;
        }

        if (event) {
            this.global.events.fire('inputEvent', 'interact', event);
        }

        this.currentIndex = (index + this.entries.length) % this.entries.length;
        this.hasActivated = true;
        this.updateListSelection();
        this.updateCollapsedTitle();
        this.entries[this.currentIndex].instance.showTooltip();
        this.listButtons[this.currentIndex]?.scrollIntoView({ block: 'nearest' });
    }
}

export { AnnotationNavigator };
