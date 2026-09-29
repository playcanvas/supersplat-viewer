import { Entity, Mat4 } from 'playcanvas';
import type { CameraComponent, EventHandle, ScriptComponent } from 'playcanvas';

import { TAP_EPSILON } from '../input/shared';
import type { ScenePicker } from '../picker';
import type { ViewerHandle } from '../types';

import { Annotation, AnnotationContext } from './annotation';

// how long the camera must be still before the hotspots are tested against the scene
const SETTLE_MS = 150;

// the scene in front of a hotspot must be at least this opaque to hide it, so haze does not
const OCCLUDING_OPACITY = 0.5;

// an annotation sits on the surface it describes, so the scene there is at about its depth;
// only content this much nearer than the annotation counts as in front of it. Relative, since
// the coarser detail streamed for a farther view thickens surfaces toward the camera
const OCCLUSION_TOLERANCE = 0.1;

// the hotspot's radius in css pixels: the opacity in front is averaged over its whole disc
const HOTSPOT_RADIUS = 13;

// the selected annotation's tooltip starts fading in once the camera has eased this far along
// a transition, its move there among them: the move settles slowly, so waiting for it to stop
// shows the tooltip well after the camera looks to have arrived
const REVEAL_PROGRESS = 0.9;

// Built-in hotspot and panel presentation. Selection and camera navigation belong to the viewer.
class Annotations {
    private parentDom: HTMLElement;

    private parent: Entity;

    private subscriptions: EventHandle[];

    private removeClick: () => void;

    private removeOcclusion: () => void;

    constructor(
        viewer: Pick<ViewerHandle, 'app' | 'state' | 'events' | 'annotations' | 'selectAnnotation'>,
        root: HTMLElement,
        camera: Entity,
        getPicker: () => ScenePicker | undefined,
        getCameraProgress: () => number
    ) {
        const { app, state, events, annotations } = viewer;
        const parentDom = document.createElement('div');
        parentDom.className = 'sse-annotations';
        // over the scene, beneath the ui
        root.querySelector('.sse-sceneLayer').appendChild(parentDom);
        this.parentDom = parentDom;

        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        const context = new AnnotationContext(canvas, camera, parentDom);

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
        }

        // Occlusion: a hotspot is either in front of the scene or behind it, never partly
        // covered. Once the camera has been still for a moment, pick the scene at every hotspot
        // on screen and fade the ones it covers; while the camera moves they keep their state.
        // One pick pass per stop, not per frame.
        let destroyed = false;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        // bumped on every camera move, so a test that resolves after the camera moved again is
        // discarded rather than applied to a pose it was not taken from
        let pose = 0;
        const lastWorld = new Mat4();
        const lastProjection = new Mat4();

        const testOcclusion = async () => {
            settleTimer = null;
            const picker = getPicker();
            if (destroyed || !picker || parentDom.style.display === 'none') return;

            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            const targets = scripts.filter(({ screen }) => {
                return screen && screen.x >= 0 && screen.x < width && screen.y >= 0 && screen.y < height;
            });
            if (targets.length === 0) return;

            const testedPose = pose;
            let opacities: (number | null)[];
            try {
                opacities = await picker.pickVisibility(
                    targets.map(({ screen }) => ({
                        x: screen.x / width,
                        y: screen.y / height,
                        depth: screen.depth * (1 - OCCLUSION_TOLERANCE)
                    })),
                    HOTSPOT_RADIUS / height
                );
            } catch {
                // a read-back that failed (a lost device, say): keep the hotspots as they are, and
                // the next camera stop or content change tests again
                return;
            }
            if (destroyed || testedPose !== pose) return;

            targets.forEach((script, i) => {
                script.setOccluded((opacities[i] ?? 0) >= OCCLUDING_OPACITY);
            });
        };

        const scheduleOcclusion = () => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(testOcclusion, SETTLE_MS);
        };

        // A new camera transition (a reset, say): the tooltip hides until it nearly ends, as on
        // the move to an annotation. Checked after the camera update but before the frame
        // renders, so the tooltip is not laid out for the transition's first frame
        let lastProgress = 1;
        const onFrameRender = () => {
            const progress = getCameraProgress();
            if (progress < lastProgress) context.revealed = false;
            lastProgress = progress;
        };
        app.on('framerender', onFrameRender);

        // after each frame, since the hotspots' screen positions are updated in prerender. The
        // camera entity's transform rather than its view matrix, which the engine refreshes only
        // for frames that render: the viewer skips a frame whose camera moved too little to see,
        // and a stale view matrix would pass for a camera at rest
        const onFrameEnd = () => {
            const world = camera.getWorldTransform();
            const { projectionMatrix } = camera.camera;
            const still = lastWorld.equals(world) && lastProjection.equals(projectionMatrix);
            const progress = getCameraProgress();

            // Show the selected annotation's tooltip once the camera is nearly there with the
            // hotspot on the canvas, fading in as the camera lands, or once the camera is at rest.
            // A hotspot that ends beyond the canvas gets its tooltip at rest, clamped to the edge,
            // rather than one that shows and then hides again as the hotspot slides off
            const { activeAnnotation } = context;
            const screen = activeAnnotation?.screen;
            const onCanvas =
                screen &&
                screen.x >= 0 &&
                screen.x <= canvas.clientWidth &&
                screen.y >= 0 &&
                screen.y <= canvas.clientHeight;
            if (activeAnnotation && !context.revealed && (still || (progress >= REVEAL_PROGRESS && onCanvas))) {
                activeAnnotation.revealTooltip();
            }
            if (still) return;
            lastWorld.copy(world);
            lastProjection.copy(projectionMatrix);
            pose++;
            scheduleOcclusion();
        };
        app.on('frameend', onFrameEnd);

        // The scene can change under a still camera: finer detail streams in after the reveal,
        // and after every move. The engine reports each frame whether all the detail it wants is
        // resident; when that turns true, new content has landed, so test again (the picker
        // drops its own cached render).
        const gsplatSystem = app.systems.gsplat;
        let contentReady = false;
        const onFrameReady = (frameCamera: CameraComponent, _layer: unknown, ready: boolean) => {
            if (frameCamera !== camera.camera) return;
            if (ready && !contentReady) {
                pose++;
                scheduleOcclusion();
            }
            contentReady = ready;
        };
        gsplatSystem.on('frame:ready', onFrameReady);

        this.removeOcclusion = () => {
            destroyed = true;
            if (settleTimer) clearTimeout(settleTimer);
            app.off('framerender', onFrameRender);
            app.off('frameend', onFrameEnd);
            gsplatSystem.off('frame:ready', onFrameReady);
        };

        const update = () => {
            const firstPersonGamingControls =
                (state.cameraMode === 'walk' || state.cameraMode === 'fly') && state.gamingControls;
            const hidden = !state.loaded || !state.showAnnotations || state.controlsHidden || firstPersonGamingControls;
            const wasHidden = parentDom.style.display === 'none';
            parentDom.style.display = hidden ? 'none' : 'block';
            // hotspots coming back may have been covered or uncovered while hidden
            if (wasHidden && !hidden) scheduleOcclusion();
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

        // A click deselects, but a drag ends in a click too, so releasing an orbit would close
        // the tooltip. A press that moved farther than a tap may is a drag, as the navigation
        // clicks count it
        let pressMovement = 0;
        const onPointerDown = () => {
            pressMovement = 0;
        };
        const onPointerMove = (event: PointerEvent) => {
            if (event.buttons) pressMovement += Math.abs(event.movementX) + Math.abs(event.movementY);
        };
        const onClick = () => {
            // consumed, so a later click from the keyboard is not taken for the drag
            const dragged = pressMovement >= TAP_EPSILON;
            pressMovement = 0;
            if (!dragged && state.loaded && state.selectedAnnotation !== null) viewer.selectAnnotation(null);
        };
        root.addEventListener('pointerdown', onPointerDown);
        root.addEventListener('pointermove', onPointerMove);
        root.addEventListener('click', onClick);
        this.removeClick = () => {
            root.removeEventListener('pointerdown', onPointerDown);
            root.removeEventListener('pointermove', onPointerMove);
            root.removeEventListener('click', onClick);
        };
    }

    destroy() {
        for (const subscription of this.subscriptions) subscription.off();
        this.removeClick();
        this.removeOcclusion();
        this.parent.destroy();
        this.parentDom.remove();
    }
}

export { Annotations };
