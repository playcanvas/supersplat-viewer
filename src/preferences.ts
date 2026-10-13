import type { EventHandler } from 'playcanvas';

import type { State } from './types';

type Preferences = Pick<
    State,
    'performanceMode' | 'gamingControls' | 'showAnnotations' | 'lookNavigation' | 'worldOnFist'
>;

const readPreferences = (mobile: boolean): Preferences => {
    const defaults = {
        performanceMode: mobile,
        gamingControls: false,
        showAnnotations: true,
        lookNavigation: false,
        worldOnFist: false
    };
    try {
        // Preserve the legacy preference migration and origin-wide keys.
        const legacyRetina = localStorage.getItem('retinaDisplay');
        let performanceMode = localStorage.getItem('performanceMode');
        if (legacyRetina !== null && performanceMode === null) {
            performanceMode = String(legacyRetina === 'false');
            try {
                localStorage.setItem('performanceMode', performanceMode);
                localStorage.removeItem('retinaDisplay');
            } catch {
                // Keep the migrated runtime value even if storage cannot be updated.
            }
        }
        return {
            performanceMode: performanceMode === null ? mobile : performanceMode === 'true',
            gamingControls: localStorage.getItem('gamingControls') === 'true',
            showAnnotations: localStorage.getItem('showAnnotations') !== 'false',
            lookNavigation: localStorage.getItem('lookNavigation') === 'true',
            worldOnFist: localStorage.getItem('worldOnFist') === 'true'
        };
    } catch {
        // Embedded documents can be denied storage. Preferences must not prevent viewing.
        return defaults;
    }
};

const persistPreferences = (events: EventHandler) => {
    // Write changes only, so creating a viewer does not persist platform defaults.
    const subscriptions = (
        ['performanceMode', 'gamingControls', 'showAnnotations', 'lookNavigation', 'worldOnFist'] as const
    ).map((key) =>
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
