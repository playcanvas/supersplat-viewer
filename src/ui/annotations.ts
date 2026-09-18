import { Entity } from 'playcanvas';
import type { AppBase, EventHandle, ScriptComponent } from 'playcanvas';

import type { ViewerHandle } from '../types';

import { Annotation, AnnotationContext } from './annotation';

// Built-in hotspot and panel presentation. Selection and camera navigation belong to the viewer.
class Annotations {
    private app: AppBase;

    private parentDom: HTMLElement;

    private parent: Entity;

    private context: AnnotationContext;

    private subscriptions: EventHandle[];

    private removeClick: () => void;

    constructor(
        viewer: Pick<ViewerHandle, 'app' | 'state' | 'events' | 'annotations' | 'selectAnnotation'>,
        root: HTMLElement,
        camera: Entity,
        hasCameraFrame: boolean
    ) {
        const { app, state, events, annotations } = viewer;
        this.app = app;
        const parentDom = document.createElement('div');
        parentDom.className = 'sse-annotations';
        root.querySelector('.sse-ui').appendChild(parentDom);
        this.parentDom = parentDom;

        const context = new AnnotationContext(app, camera, parentDom);
        this.context = context;
        if (hasCameraFrame) {
            context.hotspotColor.gamma();
            context.hoverColor.gamma();
        }

        const parent = new Entity('annotations', app);
        app.root.addChild(parent);
        this.parent = parent;
        const scripts: Annotation[] = [];

        for (let i = 0; i < annotations.length; i++) {
            const ann = annotations[i];
            const entity = new Entity('annotation', app);
            entity.addComponent('script');
            entity.script.create(Annotation);
            const script = (entity.script as ScriptComponent & { annotation: Annotation }).annotation;
            script.context = context;
            script.label = (i + 1).toString();
            script.title = ann.title;
            script.text = ann.text;
            entity.setPosition(ann.position[0], ann.position[1], ann.position[2]);
            parent.addChild(entity);
            scripts.push(script);

            script.on('select', () => viewer.selectAnnotation(i));
            script.on('hover', () => {
                app.renderNextFrame = true;
            });
        }

        const update = () => {
            const firstPersonGamingControls =
                (state.cameraMode === 'walk' || state.cameraMode === 'fly') && state.gamingControls;
            const hidden = !state.loaded || !state.showAnnotations || state.controlsHidden || firstPersonGamingControls;
            parentDom.style.display = hidden ? 'none' : 'block';
            context.opacity = hidden ? 0 : 1;
            const selected = hidden || state.selectedAnnotation === null ? null : scripts[state.selectedAnnotation];
            if (selected !== context.activeAnnotation) {
                context.activeAnnotation?.hideTooltip();
                selected?.showTooltip();
            }
            app.renderNextFrame = true;
        };
        this.subscriptions = [
            events.on('loaded:changed', update),
            events.on('selectedAnnotation:changed', update),
            events.on('controlsHidden:changed', update),
            events.on('showAnnotations:changed', update),
            events.on('cameraMode:changed', update),
            events.on('gamingControls:changed', update)
        ];
        update();

        const onClick = () => {
            if (state.loaded && state.selectedAnnotation !== null) viewer.selectAnnotation(null);
        };
        root.addEventListener('click', onClick);
        this.removeClick = () => root.removeEventListener('click', onClick);
    }

    destroy() {
        for (const subscription of this.subscriptions) subscription.off();
        this.removeClick();
        this.parent.destroy();
        clearTimeout(this.context.hideTimeout);
        const { camera, layers } = this.context;
        camera.camera.layers = camera.camera.layers.filter((id) => !layers.some((layer) => layer.id === id));
        for (const layer of layers) this.app.scene.layers.remove(layer);
        this.parentDom.remove();
    }
}

export { Annotations };
