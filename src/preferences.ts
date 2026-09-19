import type { EventHandler } from 'playcanvas';

import type { State } from './types';

type Preferences = Pick<State, 'performanceMode' | 'gamingControls' | 'showAnnotations'>;

const readPreferences = (mobile: boolean): Preferences => {
    const defaults = { performanceMode: mobile, gamingControls: false, showAnnotations: true };
    try {
        // Preserve the legacy preference migration and origin-wide keys.
        const legacyRetina = localStorage.getItem('retinaDisplay');
        if (legacyRetina !== null && localStorage.getItem('performanceMode') === null) {
            localStorage.setItem('performanceMode', String(legacyRetina === 'false'));
            localStorage.removeItem('retinaDisplay');
        }
        const performanceMode = localStorage.getItem('performanceMode');
        return {
            performanceMode: performanceMode === null ? mobile : performanceMode === 'true',
            gamingControls: localStorage.getItem('gamingControls') === 'true',
            showAnnotations: localStorage.getItem('showAnnotations') !== 'false'
        };
    } catch {
        // Embedded documents can be denied storage. Preferences must not prevent viewing.
        return defaults;
    }
};

const persistPreferences = (events: EventHandler) => {
    // Write changes only, so creating a viewer does not persist platform defaults.
    const subscriptions = (['performanceMode', 'gamingControls', 'showAnnotations'] as const).map((key) =>
        events.on(`${key}:changed`, (value: boolean) => {
            try {
                localStorage.setItem(key, String(value));
            } catch {
                // Storage may be blocked or full; runtime state still takes effect.
            }
        })
    );
    return () => subscriptions.forEach((subscription) => subscription.off());
};

export { readPreferences, persistPreferences };
