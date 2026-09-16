import { Entity } from 'playcanvas';
import type { ScriptComponent } from 'playcanvas';

import { Annotation, AnnotationContext } from './annotation';
import type { Annotation as AnnotationSettings } from './settings';
import type { Global } from './types';

class Annotations {
    annotations: AnnotationSettings[];

    parentDom: HTMLElement;

    context: AnnotationContext | null;

    constructor(global: Global, hasCameraFrame: boolean) {
        // create dom parent
        const parentDom = document.createElement('div');
        parentDom.className = 'sse-annotations';
        global.root.querySelector('.sse-ui').appendChild(parentDom);

        this.annotations = global.settings.annotations;
        this.parentDom = parentDom;

        // the shared resources exist only when there is something to show, so a scene without
        // annotations adds no layers, mesh or stylesheet
        const context =
            this.annotations.length > 0 ? new AnnotationContext(global.app, global.camera, parentDom) : null;
        this.context = context;

        const { state } = global;

        const updateVisibility = () => {
            const firstPersonGamingControls =
                (state.cameraMode === 'walk' || state.cameraMode === 'fly') && state.gamingControls;
            const hidden = !state.showAnnotations || state.controlsHidden || firstPersonGamingControls;
            parentDom.style.display = hidden ? 'none' : 'block';

            if (context) {
                context.opacity = hidden ? 0.0 : 1.0;
                if (hidden && context.activeAnnotation) {
                    context.activeAnnotation.hideTooltip();
                }
                global.app.renderNextFrame = true;
            }
        };

        global.events.on('controlsHidden:changed', updateVisibility);
        global.events.on('showAnnotations:changed', updateVisibility);
        global.events.on('cameraMode:changed', updateVisibility);
        global.events.on('gamingControls:changed', updateVisibility);
        updateVisibility();

        // create annotation entities
        const parent = global.app.root;
        const scriptMap = new Map<AnnotationSettings, Annotation>();

        if (context) {
            if (hasCameraFrame) {
                context.hotspotColor.gamma();
                context.hoverColor.gamma();
            }

            for (let i = 0; i < this.annotations.length; i++) {
                const ann = this.annotations[i];

                // named app: the engine's default is the most recently created one, which is
                // another viewer's when two share a page
                const entity = new Entity('annotation', global.app);
                entity.addComponent('script');
                entity.script.create(Annotation);
                const script = entity.script as ScriptComponent & { annotation: Annotation };
                script.annotation.context = context;
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
                script.annotation.on('hover', (_hover: boolean) => {
                    global.app.renderNextFrame = true;
                });
            }
        }

        // handle navigator requesting an annotation to be shown
        global.events.on('annotation.navigate', (ann: AnnotationSettings) => {
            const script = scriptMap.get(ann);
            if (script) {
                script.showTooltip();
            }
        });
    }

    /**
     * Remove the annotation dom, which carries the stylesheet, the tooltip and every hotspot.
     * Call after the annotation entities have been destroyed with the app.
     */
    destroy() {
        this.parentDom.remove();
        this.context = null;
    }
}

export { Annotations };
