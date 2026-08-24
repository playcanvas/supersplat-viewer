# SuperSplat Viewer

[![NPM Version](https://img.shields.io/npm/v/@playcanvas/supersplat-viewer)](https://www.npmjs.com/package/@playcanvas/supersplat-viewer)
[![NPM Downloads](https://img.shields.io/npm/dw/@playcanvas/supersplat-viewer)](https://npmtrends.com/@playcanvas/supersplat-viewer)
[![License](https://img.shields.io/npm/l/@playcanvas/supersplat-viewer)](https://github.com/playcanvas/supersplat-viewer/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-5865F2?style=flat&logo=discord&logoColor=white&color=black)](https://discord.gg/RSaMRzg)
[![Reddit](https://img.shields.io/badge/Reddit-FF4500?style=flat&logo=reddit&logoColor=white&color=black)](https://www.reddit.com/r/PlayCanvas)
[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white&color=black)](https://x.com/intent/follow?screen_name=playcanvas)

| [User Manual](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/supersplat/import-export/#html-viewer-htmlzip) | [Blog](https://blog.playcanvas.com) | [Forum](https://forum.playcanvas.com) |

This is the official viewer for [SuperSplat](https://superspl.at).

<img width="1114" height="739" alt="supersplat-viewer" src="https://github.com/user-attachments/assets/15d2c654-9484-4265-a279-99acb65e38c9" />

The web app compiles to a simple, self-contained static website.

## URL Parameters

The app supports a number of URL parameters (these are subject to change):

### Content

| Parameter | Description | Default |
| --------- | ----------- | ------- |
| `settings` | URL of the `settings.json` file | `./settings.json` |
| `content` | URL of the scene file (`.ply`, `.sog`, `.compressed.ply`, `.meta.json`, `.lod-meta.json`) | `./scene.compressed.ply` |
| `skybox` | URL of an equirectangular skybox image | |
| `poster` | URL of an image to show while loading | |
| `collision` | URL of a collision asset (`.glb` mesh, or voxel data). `voxel` is accepted as an alias. | |

### UI

| Parameter | Description |
| --------- | ----------- |
| `noui` | Hide the UI overlay |
| `noanim` | Start with animation paused |
| `ministats` | Show runtime CPU/GPU performance graphs |
| `lang` | Override the UI language (`de`, `en`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`; default: detect from browser) |

### Renderer

By default the viewer uses WebGPU when available (falling back automatically when not). The flag below forces the WebGL renderer (also required for WebXR / AR / VR):

| Parameter | Description |
| --------- | ----------- |
| `webgl` | Force the WebGL renderer (required for AR/VR) |
| `aa` | Enable antialiasing (WebGL only) |
| `nofx` | Disable post effects |
| `hpr` | Override `highPrecisionRendering` from settings (`?hpr`, `?hpr=1`, `?hpr=true`, `?hpr=enable` to enable) |
| `budget` | Override the splat budget, in millions of splats |
| `colorize` | Render with LOD colorization |
| `fullload` | Load all streaming LOD data before the first frame |
| `heatmap` | Use heatmap mode for the voxel collision debug overlay. Requires WebGPU and voxel collision data; press `V` or use the collision toolbar button to show the overlay. |
| `debug` | Open the developer debug panel on load (`Ctrl+Shift+D` to toggle) |

## NPM Package

### Embedding the viewer

If you generate a page around the viewer, use `renderViewerHtml`. It returns a complete
document, with your asset URLs and settings supplied through a single JSON block:

```ts
import { renderViewerHtml } from '@playcanvas/supersplat-viewer';

const document = renderViewerHtml({
    bootstrap: {
        settings,                      // an object, or omit and set settingsUrl
        contentUrl: 'scene.sog',
        posterUrl: 'poster.jpg'
    },
    baseHref: '/viewer/',              // serving from a sub-path
    backgroundColor: [0, 0, 0],        // components are 0..1, not 0..255
    headExtras: '<script src="analytics.js"></script>',
    inlineCss: true                    // no sibling index.css needed
});
```

Called with no options it returns the document the package ships, unmodified. URL parameters
on the served page override the bootstrap's asset URLs, so an embed stays overridable per
instance — except an inline `settings` object, which takes precedence over `?settings=`.

Set both `inlineCss` and `inlineJs` for a single self-contained file, with the splat passed as
a `data:` URI in `contentUrl`. They are independent, so a server that serves the bundle from
its own route can inline only the stylesheet.

`html`, `css` and `js` are still exported as raw strings, but are **deprecated**: their
formatting is not part of this package's API and changes between releases, so pattern-matching
them is unsupported. `js` remains useful for serving the bundle yourself.

### Settings

The `/settings` subpath exports the schema types plus helpers for generating, validating and
migrating a `settings.json` file:

```ts
import {
    defaultSettings,
    importSettings,
    validateSettings,
    POST_EFFECT_RANGES,
    type ExperienceSettings
} from '@playcanvas/supersplat-viewer/settings';

// a complete settings object every tool agrees on; pass 'object' to frame a subject
// from outside rather than a captured space from within
const settings: ExperienceSettings = defaultSettings();

// throws on invalid input, naming the offending field
validateSettings(json);

// additionally check the authoring bounds — stricter than what the viewer will render,
// so existing files may fail. Producers writing new settings should enable it
validateSettings(json, { limits: true });

// migrates older versions forward; does not mutate its argument
const migrated = importSettings(json);

// the bounds are data, so an editor UI can drive a slider from the same numbers
const { min, max, step } = POST_EFFECT_RANGES.bloom.intensity;
```

`CAMERA_FOV_RANGE`, `POST_EFFECT_RANGES`, `ANIM_TRACK_LIMITS` and `ANNOTATION_LIMITS` are
exported as data, so an editor UI can drive sliders from the same bounds the validator uses.
They are frozen at runtime.

## Local Development

To initialize a local development environment for SuperSplat Viewer, ensure you have [Node.js](https://nodejs.org/) 20 or later installed. Follow these steps:

1. Clone the repository:

   ```sh
   git clone https://github.com/playcanvas/supersplat-viewer.git
   cd supersplat-viewer
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Start the development build and local web server:

   ```sh
   npm run develop
   ```

4. Open your browser at http://localhost:3000.

### Debug engine build

By default the viewer links against the release build of the PlayCanvas engine. Set `ENGINE=debug` to link against the engine's debug build instead, which includes runtime assertions and unminified, readable source for easier debugging:

```sh
ENGINE=debug npm run develop
```

This also works with `npm run build` and `npm run watch`.

## Settings Schema

The `settings.json` file uses the schema below (defined in TypeScript and exported from `@playcanvas/supersplat-viewer/settings`). Legacy v1 settings produced by older SuperSplat releases are automatically migrated to v2 on load.

```typescript
type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
            fov: number[],
        }
    }
};

type CameraPose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type Camera = {
    initial: CameraPose
};

type Annotation = {
    position: [number, number, number],
    title: string,
    text: string,
    extras?: any,
    camera: Camera
};

type PostEffectSettings = {
    sharpness: { enabled: boolean, amount: number },
    bloom:     { enabled: boolean, intensity: number, blurLevel: number },
    grading:   { enabled: boolean, brightness: number, contrast: number, saturation: number, tint: [number, number, number] },
    vignette:  { enabled: boolean, intensity: number, inner: number, outer: number, curvature: number },
    fringing:  { enabled: boolean, intensity: number }
};

type ExperienceSettings = {
    version: 2,
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral',
    highPrecisionRendering: boolean,
    soundUrl?: string,
    background: {
        color: [number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,
    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],
    startMode: 'default' | 'animTrack' | 'annotation'
};
```

### Example settings.json

```json
{
    "version": 2,
    "tonemapping": "none",
    "highPrecisionRendering": false,
    "background": {
        "color": [0, 0, 0]
    },
    "postEffectSettings": {
        "sharpness": { "enabled": false, "amount": 0 },
        "bloom":     { "enabled": false, "intensity": 0.1, "blurLevel": 2 },
        "grading":   { "enabled": false, "brightness": 1, "contrast": 1, "saturation": 1, "tint": [1, 1, 1] },
        "vignette":  { "enabled": false, "intensity": 0.5, "inner": 0.3, "outer": 0.75, "curvature": 1 },
        "fringing":  { "enabled": false, "intensity": 0.5 }
    },
    "animTracks": [],
    "cameras": [
        {
            "initial": {
                "position": [0, 1, -1],
                "target": [0, 0, 0],
                "fov": 60
            }
        }
    ],
    "annotations": [],
    "startMode": "default"
}
```
