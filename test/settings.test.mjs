import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Tests run against the built artifact, so they exercise exactly what the package ships.
// Run `npm run build` first (`npm test` does both).
import {
    ANIM_TRACK_LIMITS,
    ANNOTATION_LIMITS,
    CAMERA_FOV_RANGE,
    DEFAULT_CAMERA_FOV,
    POST_EFFECT_RANGES,
    defaultPostEffectSettings,
    defaultSettings,
    importSettings,
    validateSettings
} from '../dist/settings.js';

const clone = (settings) => structuredClone(settings);

const withAnimTrack = (overrides = {}) => {
    const settings = defaultSettings();
    settings.animTracks = [
        {
            name: 'track',
            duration: 10,
            frameRate: 30,
            loopMode: 'repeat',
            interpolation: 'spline',
            smoothness: 0,
            keyframes: {
                times: [0, 1],
                values: { position: [0, 0, 0, 1, 1, 1], target: [0, 0, 0, 0, 0, 0], fov: [75, 75] }
            },
            ...overrides
        }
    ];
    return settings;
};

describe('defaults', () => {
    it('produces settings that pass both shape and limit validation', () => {
        assert.doesNotThrow(() => validateSettings(defaultSettings()));
        assert.doesNotThrow(() => validateSettings(defaultSettings(), { limits: true }));
        assert.doesNotThrow(() => validateSettings(defaultSettings('object'), { limits: true }));
    });

    it('uses the values matching settings already published in the wild', () => {
        const settings = defaultSettings();
        assert.strictEqual(settings.tonemapping, 'linear');
        assert.deepStrictEqual(settings.background.color, [0, 0, 0]);
        assert.strictEqual(settings.postEffectSettings.bloom.intensity, 0.1);
        assert.strictEqual(settings.postEffectSettings.grading.brightness, 1);
    });

    it('returns fresh objects, so callers cannot corrupt the defaults', () => {
        const a = defaultSettings();
        a.background.color[0] = 1;
        a.postEffectSettings.bloom.intensity = 99;
        assert.deepStrictEqual(defaultSettings().background.color, [0, 0, 0]);
        assert.strictEqual(defaultPostEffectSettings().bloom.intensity, 0.1);
    });

    it('freezes the published constants, so a consumer cannot change validation globally', () => {
        // the validators read these at call time; a successful mutation would alter results
        // for every other caller in the realm
        assert.strictEqual(Object.isFrozen(POST_EFFECT_RANGES), true);
        assert.strictEqual(Object.isFrozen(POST_EFFECT_RANGES.bloom.intensity), true);
        assert.strictEqual(Object.isFrozen(CAMERA_FOV_RANGE), true);
        assert.strictEqual(Object.isFrozen(ANIM_TRACK_LIMITS.duration), true);
        assert.strictEqual(Object.isFrozen(ANNOTATION_LIMITS), true);

        const settings = clone(defaultSettings());
        settings.postEffectSettings.bloom.intensity = 1;
        assert.throws(() => validateSettings(settings, { limits: true }));

        // still rejected after an attempted widening of the bound
        try {
            POST_EFFECT_RANGES.bloom.intensity.max = 99;
        } catch {
            // module code runs in strict mode, which throws on frozen writes; either
            // outcome is fine
        }
        assert.strictEqual(POST_EFFECT_RANGES.bloom.intensity.max, 0.1);
        assert.throws(() => validateSettings(settings, { limits: true }));
    });

    it('frames from inside for environment and outside for object', () => {
        assert.deepStrictEqual(defaultSettings('environment').cameras[0].initial.position, [0, 2, 0]);
        assert.deepStrictEqual(defaultSettings('object').cameras[0].initial.target, [0, 0, 0]);
    });
});

describe('validateSettings', () => {
    it('accepts a valid v2 document and rejects a broken one', () => {
        assert.doesNotThrow(() => validateSettings(defaultSettings()));
        assert.throws(() => validateSettings({ version: 2 }));
        assert.throws(() => validateSettings({ version: 9 }), /Unsupported/);
        assert.throws(() => validateSettings({ version: 'two' }), /must be a number/);
    });

    it('does not enforce authoring limits by default', () => {
        const settings = clone(defaultSettings());
        // a value older defaults wrote, outside the authoring range
        settings.postEffectSettings.bloom.intensity = 1;

        assert.doesNotThrow(() => validateSettings(settings));
        assert.throws(() => validateSettings(settings, { limits: true }), /bloom.intensity must be between 0 and 0.1/);
    });

    it('enforces post-effect ranges when asked', () => {
        const settings = clone(defaultSettings());
        settings.postEffectSettings.vignette.curvature = POST_EFFECT_RANGES.vignette.curvature.max + 1;
        assert.throws(() => validateSettings(settings, { limits: true }), /vignette.curvature/);
    });

    it('enforces camera fov range when asked', () => {
        const settings = clone(defaultSettings());
        settings.cameras[0].initial.fov = CAMERA_FOV_RANGE.max + 1;
        assert.throws(() => validateSettings(settings, { limits: true }), /cameras\[0\].initial.fov/);
    });

    it('allows more than one camera — the format permits it even though the viewer reads only the first', () => {
        const settings = clone(defaultSettings());
        settings.cameras.push(structuredClone(settings.cameras[0]));
        assert.doesNotThrow(() => validateSettings(settings, { limits: true }));
    });

    it('enforces anim track limits when asked', () => {
        assert.throws(() => validateSettings(withAnimTrack({ frameRate: 30.5 }), { limits: true }), /integer/);
        assert.throws(
            () => validateSettings(withAnimTrack({ duration: ANIM_TRACK_LIMITS.duration.max + 1 }), { limits: true }),
            /duration/
        );
        assert.throws(
            () =>
                validateSettings(
                    withAnimTrack({ keyframes: { times: [-1], values: { position: [], target: [], fov: [] } } }),
                    { limits: true }
                ),
            /non-negative/
        );
        assert.throws(
            () =>
                validateSettings(withAnimTrack({ name: 'x'.repeat(ANIM_TRACK_LIMITS.nameMax + 1) }), { limits: true }),
            /name/
        );
    });

    it('enforces keyframe invariants when asked', () => {
        const kf = (times, position, target, fov) =>
            withAnimTrack({ keyframes: { times, values: { position, target, fov } } });

        // frames must be integers, strictly ascending, and each value array correctly sized
        assert.throws(
            () => validateSettings(kf([0, 1.5], [0, 0, 0, 1, 1, 1], [0, 0, 0, 0, 0, 0], [75, 75]), { limits: true }),
            /times\[1\] must be an integer/
        );
        assert.throws(
            () => validateSettings(kf([0, 0], [0, 0, 0, 1, 1, 1], [0, 0, 0, 0, 0, 0], [75, 75]), { limits: true }),
            /greater than the previous frame/
        );
        assert.throws(
            () => validateSettings(kf([5, 1], [0, 0, 0, 1, 1, 1], [0, 0, 0, 0, 0, 0], [75, 75]), { limits: true }),
            /greater than the previous frame/
        );
        assert.throws(
            () => validateSettings(kf([0, 1], [0, 0, 0], [0, 0, 0, 0, 0, 0], [75, 75]), { limits: true }),
            /position must have 3 values per keyframe \(6\), got 3/
        );
        assert.throws(
            () => validateSettings(kf([0, 1], [0, 0, 0, 1, 1, 1], [0, 0, 0], [75, 75]), { limits: true }),
            /target must have 3 values per keyframe/
        );
        assert.throws(
            () => validateSettings(kf([0, 1], [0, 0, 0, 1, 1, 1], [0, 0, 0, 0, 0, 0], [75]), { limits: true }),
            /fov must have 1 value per keyframe \(2\), got 1/
        );
    });

    it('rejects a track with no keyframes, which the viewer cannot load', () => {
        // CubicSpline.calcKnots derives dim as points.length / times.length, so an empty
        // track computes 0/0 and allocates new Array(NaN), which throws at load
        const settings = clone(defaultSettings());
        settings.startMode = 'animTrack';
        settings.animTracks = [
            {
                ...withAnimTrack().animTracks[0],
                keyframes: { times: [], values: { position: [], target: [], fov: [] } }
            }
        ];

        assert.doesNotThrow(() => validateSettings(settings));
        assert.throws(() => validateSettings(settings, { limits: true }), /at least one keyframe/);
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
        assert.throws(() => validateSettings(settings, { limits: true }), /annotations\[0\].title/);
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
                target: 'camera',
                loopMode: 'repeat',
                interpolation: 'spline',
                // 3 values per keyframe for position/target; the migration fills fov itself
                keyframes: {
                    times: [0, 1],
                    values: { position: [0, 0, 0, 1, 1, 1], target: [0, 0, 0, 0, 0, 0] }
                }
            }
        ]
    });

    it('migrates v1 to v2 and passes v2 through', () => {
        const migrated = importSettings(v1());
        assert.strictEqual(migrated.version, 2);
        assert.strictEqual(migrated.startMode, 'animTrack');
        assert.deepStrictEqual(migrated.background.color, [0.2, 0.2, 0.2]);
        assert.strictEqual(migrated.cameras[0].initial.fov, 60);

        const already = defaultSettings();
        assert.strictEqual(importSettings(already), already);
    });

    it('does not mutate the object it is given', () => {
        const input = v1();
        const before = structuredClone(input);

        importSettings(input);

        // v1 migration backfills frameRate and smoothness and rescales keyframe times —
        // an API consumer holding this object must not see any of that
        assert.deepStrictEqual(input, before);
    });

    it('migrates using the shared post-effect defaults, so a sane v1 doc passes limits', () => {
        // regression: the migration used to invent bloom.intensity = 1, outside the authoring
        // range, so limit validation failed for every v1 input regardless of its own contents
        const migrated = importSettings(v1());
        assert.deepStrictEqual(migrated.postEffectSettings, defaultPostEffectSettings());
        assert.doesNotThrow(() => validateSettings(v1(), { limits: true }));
    });

    it("still reports the caller's own out-of-bounds v1 data", () => {
        const doc = v1();
        doc.camera.fov = 500;
        assert.throws(() => validateSettings(doc, { limits: true }), /fov/);
    });

    it('keeps tonemapping at none, since it applies unconditionally', () => {
        assert.strictEqual(importSettings(v1()).tonemapping, 'none');
    });

    it('checks v1 fields the migration would coerce, before it coerces them', () => {
        // `frameRate: 0` becomes 30 and `camera.fov: 0` becomes the default fov during
        // migration, so a post-migration check cannot see an explicitly invalid zero
        const withFov = (fov) => ({ ...v1(), camera: { ...v1().camera, fov } });
        assert.throws(
            () => validateSettings(withFov(0), { limits: true }),
            /settings\.camera\.fov must be between 10 and 120, got 0/
        );
        assert.throws(() => validateSettings(withFov(500), { limits: true }), /settings\.camera\.fov/);
        assert.doesNotThrow(() => validateSettings(withFov(75), { limits: true }));

        const withFrameRate = (frameRate) => {
            const doc = v1();
            return { ...doc, animTracks: [{ ...doc.animTracks[0], frameRate }] };
        };
        assert.throws(
            () => validateSettings(withFrameRate(0), { limits: true }),
            /animTracks\[0\]\.frameRate must be between 1 and 120, got 0/
        );
        assert.throws(() => validateSettings(withFrameRate(30.5), { limits: true }), /frameRate must be an integer/);
        assert.doesNotThrow(() => validateSettings(withFrameRate(30), { limits: true }));
    });

    it('rejects v1 vectors whose arity would migrate to invalid v2', () => {
        // migration casts these straight into v2 tuples, so any other arity used to pass
        // validation while producing migrated output that failed it
        const withColor = { ...v1(), background: { color: [1, 0, 0, 1] } };
        assert.throws(() => validateSettings(withColor), /background.color must have exactly 3 elements/);

        const withPosition = { ...v1(), camera: { ...v1().camera, position: [1, 2] } };
        assert.throws(() => validateSettings(withPosition), /camera.position must have exactly 3 elements/);
    });

    it('falls back to the shared default fov for both the camera and anim keyframes', () => {
        // these two fallbacks used to disagree (60 for keyframes, 75 for the camera), giving
        // fov-less v1 docs a zoom pop when playback handed off to the interactive camera
        const doc = { ...v1(), camera: { position: [1, 2, 3], target: [0, 0, 0], startAnim: 'animTrack' } };
        const migrated = importSettings(doc);

        assert.strictEqual(migrated.cameras[0].initial.fov, DEFAULT_CAMERA_FOV);
        assert.deepStrictEqual(migrated.animTracks[0].keyframes.values.fov, [DEFAULT_CAMERA_FOV, DEFAULT_CAMERA_FOV]);
    });

    it('marks limit failures that come from migrated rather than authored values', () => {
        // v1 times are in seconds when frameRate is absent; migration rescales by 30, which
        // can land on a fraction the caller never wrote
        const doc = v1();
        doc.animTracks[0].keyframes.times = [0, 0.05];

        assert.throws(() => validateSettings(doc, { limits: true }), /checked after migrating from v1/);
    });

    it('rejects an unsupported version', () => {
        assert.throws(() => importSettings({ version: 99 }), /Unsupported/);
    });
});
