import { describe, expect, it } from 'vitest';

import {
    ANIM_TRACK_LIMITS,
    ANNOTATION_LIMITS,
    CAMERA_FOV_RANGE,
    POST_EFFECT_RANGES,
    defaultPostEffectSettings,
    defaultSettings,
    importSettings,
    validateSettings
} from '../settings';
import type { ExperienceSettings } from '../settings';

const clone = (settings: ExperienceSettings) => structuredClone(settings);

const withAnimTrack = (overrides: Record<string, unknown> = {}) => {
    const settings = defaultSettings();
    settings.animTracks = [
        {
            name: 'track',
            duration: 10,
            frameRate: 30,
            loopMode: 'repeat',
            interpolation: 'spline',
            smoothness: 0,
            keyframes: { times: [0, 1], values: { position: [], target: [], fov: [] } },
            ...overrides
        } as ExperienceSettings['animTracks'][number]
    ];
    return settings;
};

describe('defaults', () => {
    it('produces settings that pass both shape and limit validation', () => {
        expect(() => validateSettings(defaultSettings())).not.toThrow();
        expect(() => validateSettings(defaultSettings(), { limits: true })).not.toThrow();
        expect(() => validateSettings(defaultSettings('object'), { limits: true })).not.toThrow();
    });

    it('uses the values matching settings already published in the wild', () => {
        const settings = defaultSettings();
        expect(settings.tonemapping).toBe('linear');
        expect(settings.background.color).toEqual([0, 0, 0]);
        expect(settings.postEffectSettings.bloom.intensity).toBe(0.1);
        expect(settings.postEffectSettings.grading.brightness).toBe(1);
    });

    it('returns fresh objects, so callers cannot corrupt the defaults', () => {
        const a = defaultSettings();
        a.background.color[0] = 1;
        a.postEffectSettings.bloom.intensity = 99;
        expect(defaultSettings().background.color).toEqual([0, 0, 0]);
        expect(defaultPostEffectSettings().bloom.intensity).toBe(0.1);
    });

    it('freezes the published constants, so a consumer cannot change validation globally', () => {
        // the validators read these at call time; a successful mutation would alter results
        // for every other caller in the realm
        expect(Object.isFrozen(POST_EFFECT_RANGES)).toBe(true);
        expect(Object.isFrozen(POST_EFFECT_RANGES.bloom.intensity)).toBe(true);
        expect(Object.isFrozen(CAMERA_FOV_RANGE)).toBe(true);
        expect(Object.isFrozen(ANIM_TRACK_LIMITS.duration)).toBe(true);
        expect(Object.isFrozen(ANNOTATION_LIMITS)).toBe(true);

        const settings = clone(defaultSettings());
        settings.postEffectSettings.bloom.intensity = 1;
        expect(() => validateSettings(settings, { limits: true })).toThrow();

        // still rejected after an attempted widening of the bound
        try {
            (POST_EFFECT_RANGES.bloom.intensity as { max: number }).max = 99;
        } catch {
            // strict mode throws on frozen writes; either outcome is fine
        }
        expect(POST_EFFECT_RANGES.bloom.intensity.max).toBe(0.1);
        expect(() => validateSettings(settings, { limits: true })).toThrow();
    });

    it('frames from inside for environment and outside for object', () => {
        expect(defaultSettings('environment').cameras[0].initial.position).toEqual([0, 2, 0]);
        expect(defaultSettings('object').cameras[0].initial.target).toEqual([0, 0, 0]);
    });
});

describe('validateSettings', () => {
    it('accepts a valid v2 document and rejects a broken one', () => {
        expect(() => validateSettings(defaultSettings())).not.toThrow();
        expect(() => validateSettings({ version: 2 })).toThrow();
        expect(() => validateSettings({ version: 9 })).toThrow(/Unsupported/);
        expect(() => validateSettings({ version: 'two' })).toThrow(/must be a number/);
    });

    it('does not enforce authoring limits by default', () => {
        const settings = clone(defaultSettings());
        // a value older defaults wrote, outside the authoring range
        settings.postEffectSettings.bloom.intensity = 1;

        expect(() => validateSettings(settings)).not.toThrow();
        expect(() => validateSettings(settings, { limits: true })).toThrow(/bloom.intensity must be between 0 and 0.1/);
    });

    it('enforces post-effect ranges when asked', () => {
        const settings = clone(defaultSettings());
        settings.postEffectSettings.vignette.curvature = POST_EFFECT_RANGES.vignette.curvature.max + 1;
        expect(() => validateSettings(settings, { limits: true })).toThrow(/vignette.curvature/);
    });

    it('enforces camera fov range when asked', () => {
        const settings = clone(defaultSettings());
        settings.cameras[0].initial.fov = CAMERA_FOV_RANGE.max + 1;
        expect(() => validateSettings(settings, { limits: true })).toThrow(/cameras\[0\].initial.fov/);
    });

    it('allows more than one camera — the format permits it even though the viewer reads only the first', () => {
        const settings = clone(defaultSettings());
        settings.cameras.push(structuredClone(settings.cameras[0]));
        expect(() => validateSettings(settings, { limits: true })).not.toThrow();
    });

    it('enforces anim track limits when asked', () => {
        expect(() => validateSettings(withAnimTrack({ frameRate: 30.5 }), { limits: true })).toThrow(/integer/);
        expect(() =>
            validateSettings(withAnimTrack({ duration: ANIM_TRACK_LIMITS.duration.max + 1 }), { limits: true })
        ).toThrow(/duration/);
        expect(() =>
            validateSettings(
                withAnimTrack({ keyframes: { times: [-1], values: { position: [], target: [], fov: [] } } }),
                { limits: true }
            )
        ).toThrow(/non-negative/);
        expect(() =>
            validateSettings(withAnimTrack({ name: 'x'.repeat(ANIM_TRACK_LIMITS.nameMax + 1) }), { limits: true })
        ).toThrow(/name/);
    });

    it('enforces annotation limits when asked', () => {
        const settings = clone(defaultSettings());
        settings.annotations = [
            {
                position: [0, 0, 0],
                title: 'x'.repeat(ANNOTATION_LIMITS.titleMax + 1),
                text: 'ok',
                camera: { initial: { position: [0, 0, 0], target: [0, 0, 0], fov: 75 } }
            }
        ];
        expect(() => validateSettings(settings, { limits: true })).toThrow(/annotations\[0\].title/);
    });
});

describe('importSettings', () => {
    const v1 = () => ({
        camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 60, startAnim: 'animTrack' },
        background: { color: [0.2, 0.2, 0.2] },
        animTracks: [
            {
                name: 'anim',
                duration: 5,
                target: 'camera' as const,
                loopMode: 'repeat',
                interpolation: 'spline',
                keyframes: { times: [0, 1], values: { position: [] as number[], target: [] as number[] } }
            }
        ]
    });

    it('migrates v1 to v2 and passes v2 through', () => {
        const migrated = importSettings(v1());
        expect(migrated.version).toBe(2);
        expect(migrated.startMode).toBe('animTrack');
        expect(migrated.background.color).toEqual([0.2, 0.2, 0.2]);
        expect(migrated.cameras[0].initial.fov).toBe(60);

        const already = defaultSettings();
        expect(importSettings(already)).toBe(already);
    });

    it('does not mutate the object it is given', () => {
        const input = v1();
        const before = structuredClone(input);

        importSettings(input);

        // v1 migration backfills frameRate and smoothness and rescales keyframe times —
        // an API consumer holding this object must not see any of that
        expect(input).toEqual(before);
    });

    it('migrates using the shared post-effect defaults, so a sane v1 doc passes limits', () => {
        // regression: the migration used to invent bloom.intensity = 1, outside the authoring
        // range, so limit validation failed for every v1 input regardless of its own contents
        const migrated = importSettings(v1());
        expect(migrated.postEffectSettings).toEqual(defaultPostEffectSettings());
        expect(() => validateSettings(v1(), { limits: true })).not.toThrow();
    });

    it("still reports the caller's own out-of-bounds v1 data", () => {
        const doc = v1();
        doc.camera.fov = 500;
        expect(() => validateSettings(doc, { limits: true })).toThrow(/fov/);
    });

    it('keeps tonemapping at none, since it applies unconditionally', () => {
        expect(importSettings(v1()).tonemapping).toBe('none');
    });

    it('rejects an unsupported version', () => {
        expect(() => importSettings({ version: 99 })).toThrow(/Unsupported/);
    });
});
