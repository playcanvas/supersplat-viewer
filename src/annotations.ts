import { Entity } from 'playcanvas';

import { Annotation } from './annotation';
import type { Annotation as AnnotationSettings } from './settings';
import type { Global } from './types';

class Annotations {
    annotations: AnnotationSettings[];

    parentDom: HTMLElement;

    constructor(global: Global, hasCameraFrame: boolean) {
        // create dom parent
        const parentDom = document.createElement('div');
        parentDom.id = 'annotations';
        Annotation.parentDom = parentDom;
        document.querySelector('#ui').appendChild(parentDom);

        this.annotations = global.settings.annotations;
        this.parentDom = parentDom;

        const { state } = global;

        const updateVisibility = () => {
            const hidden = state.controlsHidden || (state.cameraMode === 'walk' && state.gamingControls);
            parentDom.style.display = hidden ? 'none' : 'block';
            Annotation.opacity = hidden ? 0.0 : 1.0;
            if (this.annotations.length > 0) {
                global.app.renderNextFrame = true;
            }
        };

        global.events.on('controlsHidden:changed', updateVisibility);
        global.events.on('cameraMode:changed', updateVisibility);
        global.events.on('gamingControls:changed', updateVisibility);
        updateVisibility();

        if (hasCameraFrame) {
            Annotation.hotspotColor.gamma();
            Annotation.hoverColor.gamma();
        }

        // create annotation entities
        const parent = global.app.root;
        const scriptMap = new Map<AnnotationSettings, Annotation>();

        for (let i = 0; i < this.annotations.length; i++) {
            const ann = this.annotations[i];

            const entity = new Entity();
            entity.addComponent('script');
            entity.script.create(Annotation);
            const script = entity.script as any;
            script.annotation.label = (i + 1).toString();
            script.annotation.title = ann.title;
            script.annotation.text = ann.text;

            entity.setPosition(ann.position[0], ann.position[1], ann.position[2]);

            parent.addChild(entity);

            scriptMap.set(ann, script.annotation);

            // handle an annotation being activated/shown
            script.annotation.on('show', () => {
                global.events.fire('annotation.activate', ann);
            });

            script.annotation.on('hide', () => {
                global.events.fire('annotation.deactivate');
            });

            // re-render if hover state changes
            script.annotation.on('hover', (hover: boolean) => {
                global.app.renderNextFrame = true;
            });
        }

        // handle navigator requesting an annotation to be shown
        global.events.on('annotation.navigate', (ann: AnnotationSettings) => {
            const script = scriptMap.get(ann);
            if (script) {
                script.showTooltip();
            }
        });
    }
}

export { Annotations };
