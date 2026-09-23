import type { ViewerHandle } from '../types';

const initAnnotationControls = (
    viewer: Pick<ViewerHandle, 'state' | 'events' | 'annotations' | 'selectAnnotation'>,
    root: HTMLElement
) => {
    const { state, events, annotations } = viewer;
    const nav = root.querySelector<HTMLElement>('.sse-annotationNav');
    const info = root.querySelector<HTMLElement>('.sse-annotationInfo');
    const number = root.querySelector<HTMLElement>('.sse-annotationNavNumber');
    const title = root.querySelector<HTMLElement>('.sse-annotationNavTitle');
    const prev = root.querySelector<HTMLButtonElement>('.sse-annotationPrev');
    const next = root.querySelector<HTMLButtonElement>('.sse-annotationNext');
    const row = root.querySelector<HTMLElement>('.sse-annotationsRow');
    const check = root.querySelector<HTMLElement>('.sse-annotationsCheck');

    // Retain the last title and navigation position when the panel is dismissed, greyed out
    // while nothing is selected so it does not read as the selection; clicking it selects it.
    let currentIndex = state.selectedAnnotation ?? 0;
    const update = () => {
        currentIndex = state.selectedAnnotation ?? currentIndex;
        // the number its hotspot shows in the scene
        number.textContent = annotations[currentIndex] ? String(currentIndex + 1) : '';
        title.textContent = annotations[currentIndex]?.title ?? '';
        nav.classList.toggle('sse-hidden', !state.loaded || !state.showAnnotations || annotations.length < 2);
        nav.classList.toggle('sse-unselected', state.selectedAnnotation === null);
        nav.classList.toggle('sse-desktop', state.inputMode === 'desktop');
        nav.classList.toggle('sse-touch', state.inputMode === 'touch');
        nav.classList.toggle('sse-faded-in', !state.controlsHidden);
        nav.classList.toggle('sse-faded-out', state.controlsHidden);
        prev.disabled = next.disabled = !state.loaded || annotations.length < 2;
        row.classList.toggle('sse-hidden', annotations.length === 0);
        check.classList.toggle('sse-active', state.showAnnotations);
    };
    const onPrev = (event: MouseEvent) => {
        event.stopPropagation();
        viewer.selectAnnotation((currentIndex - 1 + annotations.length) % annotations.length);
    };
    const onNext = (event: MouseEvent) => {
        event.stopPropagation();
        viewer.selectAnnotation((currentIndex + 1) % annotations.length);
    };
    const onInfo = (event: MouseEvent) => {
        event.stopPropagation();
        if (state.loaded && state.selectedAnnotation === null && annotations[currentIndex]) {
            viewer.selectAnnotation(currentIndex);
        }
    };
    const onVisibility = (event: MouseEvent) => {
        event.stopPropagation();
        state.showAnnotations = !state.showAnnotations;
    };
    prev.addEventListener('click', onPrev);
    next.addEventListener('click', onNext);
    info.addEventListener('click', onInfo);
    row.addEventListener('click', onVisibility);
    const subscriptions = [
        events.on('loaded:changed', update),
        events.on('selectedAnnotation:changed', update),
        events.on('showAnnotations:changed', update),
        events.on('inputMode:changed', update),
        events.on('controlsHidden:changed', update)
    ];
    update();

    return () => {
        for (const subscription of subscriptions) subscription.off();
        prev.removeEventListener('click', onPrev);
        next.removeEventListener('click', onNext);
        info.removeEventListener('click', onInfo);
        row.removeEventListener('click', onVisibility);
    };
};

export { initAnnotationControls };
