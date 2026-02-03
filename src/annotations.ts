import { Entity } from 'playcanvas';

import { Annotation } from './annotation';
import { AnnotationNavigator } from './annotation-navigator';
import type { Annotation as AnnotationSettings } from './settings';
import type { Global } from './types';

class Annotations {
    annotations: AnnotationSettings[];

    parentDom: HTMLElement;

    navigator: AnnotationNavigator | null = null;

    constructor(global: Global, hasCameraFrame: boolean) {
        // create dom parent
        const parentDom = document.createElement('div');
        parentDom.id = 'annotations';
        Annotation.parentDom = parentDom;
        document.querySelector('#ui').appendChild(parentDom);

        global.events.on('controlsHidden:changed', (value) => {
            parentDom.style.display = value ? 'none' : 'block';
            Annotation.opacity = value ? 0.0 : 1.0;
            if (this.annotations.length > 0) {
                global.app.renderNextFrame = true;
            }
        });

        this.annotations = global.settings.annotations;
        this.parentDom = parentDom;

        if (hasCameraFrame) {
            Annotation.hotspotColor.gamma();
            Annotation.hoverColor.gamma();
        }

        // create annotation entities
        const parent = global.app.root;

        const annotationEntries: Array<{ settings: AnnotationSettings; instance: Annotation }> = [];

        for (let i = 0; i < this.annotations.length; i++) {
            const ann = this.annotations[i];

            const entity = new Entity();
            entity.addComponent('script');
            entity.script.create(Annotation);
            const script = entity.script as any;
            const instance = script.annotation as Annotation;
            instance.label = (i + 1).toString();
            instance.title = ann.title;
            instance.text = ann.text;

            entity.setPosition(ann.position[0], ann.position[1], ann.position[2]);

            parent.addChild(entity);

            // handle an annotation being activated/shown
            annotationEntries.push({ settings: ann, instance });

            instance.on('show', () => {
                global.events.fire('annotation.activate', ann);
            });

            // re-render if hover state changes
            instance.on('hover', (hover: boolean) => {
                global.app.renderNextFrame = true;
            });
        }

        if (annotationEntries.length > 0) {
            this.navigator = new AnnotationNavigator(global, annotationEntries);
        }
    }
}

export { Annotations };
