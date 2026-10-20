import type { EventHandler } from 'playcanvas';

import type { QualityLevel, State } from './types';

type Preferences = Pick<
    State,
    'quality' | 'stochastic' | 'performanceMode' | 'gamingControls' | 'showAnnotations' | 'lookNavigation' | 'iceCream'
>;

const QUALITY_VALUES: readonly QualityLevel[] = ['performance', 'default', 'high', 'max'];

const readPreferences = (mobile: boolean): Preferences => {
    const defaults = {
        quality: (mobile ? 'performance' : 'default') as QualityLevel,
        stochastic: false,
        performanceMode: mobile,
        gamingControls: false,
        showAnnotations: true,
        lookNavigation: false,
        iceCream: false
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
        // the Quality slider replaced the Performance Mode switch (2026-10-19): a stored switch
        // migrates to its position, and the deprecated alias follows the slider
        const storedQuality = localStorage.getItem('quality');
        const quality = QUALITY_VALUES.includes(storedQuality as QualityLevel)
            ? (storedQuality as QualityLevel)
            : performanceMode === null
              ? defaults.quality
              : performanceMode === 'true'
                ? 'performance'
                : 'default';
        return {
            quality,
            stochastic: localStorage.getItem('stochastic') === 'true',
            performanceMode: quality === 'performance',
            gamingControls: localStorage.getItem('gamingControls') === 'true',
            showAnnotations: localStorage.getItem('showAnnotations') !== 'false',
            lookNavigation: localStorage.getItem('lookNavigation') === 'true',
            iceCream: localStorage.getItem('iceCream') === 'true'
        };
    } catch {
        // Embedded documents can be denied storage. Preferences must not prevent viewing.
        return defaults;
    }
};

const persistPreferences = (events: EventHandler) => {
    // Write changes only, so creating a viewer does not persist platform defaults.
    const subscriptions = (
        [
            'quality',
            'stochastic',
            'performanceMode',
            'gamingControls',
            'showAnnotations',
            'lookNavigation',
            'iceCream'
        ] as const
    ).map((key) =>
        events.on(`${key}:changed`, (value: boolean | string) => {
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
