import { Entity } from 'playcanvas';

import type { Global } from './types';
import type { Annotation as AnnotationSettings } from './settings';
import { Annotation } from './annotation';

class Annotations {
    annotations: AnnotationSettings[];

    constructor(global: Global) {
        this.annotations = global.settings.annotations;

        // create annotation entities
        const parent = global.app.root;
        for (const ann of this.annotations) {
            const entity = new Entity();
            entity.addComponent('script');
            entity.script.create(Annotation);
            const script = entity.script as any;
            script.annotation.title = ann.title;
            script.annotation.text = ann.text;

            entity.setPosition(ann.position[0], ann.position[1], ann.position[2]);

            parent.addChild(entity);

            // handle an annotation being activated/shown
            script.annotation.on('show', () => {
                global.events.fire('annotation.activate', ann);
            });
        }
    }
};

export { Annotations };
