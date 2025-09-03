# SuperSplat Viewer

[![NPM Version][npm-version-badge]][npm-url]
[![NPM Downloads][npm-downloads-badge]][npm-trends-url]
[![License][license-badge]][license-url]
[![GitHub Actions Build Status][build-status-badge]][workflow-url]
[![Github Issue Resolve Time][issue-resolve-badge]][isitmaintained-url]
[![Github Open Issues][open-issues-badge]][isitmaintained-url]

| [User Manual][manual-url] | [API Reference][api-url] | [Blog][blog-url] | [Forum][forum-url] | [Discord][discord-url] | [Reddit][reddit-url] | [Twitter][twitter-url] |

This is the official viewer for https://superspl.at and the SuperSplat Editor HTML export.

<img width="1088" alt="Screenshot 2025-04-11 at 13 36 02" src="https://github.com/user-attachments/assets/a5e2a2eb-3064-4d73-beb9-eb9c4708b2b2" />

This webapp compiles to simple, self-contained, static website.

The app supports a few useful URL parameters (though please note these are subject to change):
- `&settings=url` - specify the URL of the `settings.json` file (default is `./settings.json`)
- `&content=url` - specify the URL of the `scene.compressed.ply` file (default is `./scene.compressed.ply`)

As well as the following:
- `&noui` - hide UI
- `&noanim` - start with animation paused
- `&poster=url` - show an image while loading the scene content
- `&ministats` - show the runtime CPU (and on desktop, GPU) performance graphs
- `&skybox=url` - specify an equirectangular skybox image for the skybox

The webapp source files is available as strings for templating when imported as an NPM module:

```ts
import { html, css, js } from '@playcanvas/supersplat-viewer`;

// logs the source of index.html
console.log(html);

// logs the source of index.css
console.log(css);

// logs the source of index.js
console.log(js);
```

## Local Development

To initialize a local development environment for SuperSplat Viewer, ensure you have [Node.js](https://nodejs.org/) 18 or later installed. Follow these steps:

1. Clone the repository:

   ```sh
   git clone https://github.com/playcanvas/supersplat-viewer.git
   cd supersplat-viewer
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Build SuperSplat Viewer and start a local web server:

   ```sh
   npm run develop
   ```

4. Open the browser at http://localhost:3000.

## Settings Schema

The `settings.json` file has the following schema (as defined in typescript, taken from SuperSplat editor):


```typescript
type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    target: 'camera',
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
        }
    }
};

type ExperienceSettings = {
    camera: {
        fov?: number,
        position?: number[],
        target?: number[],
        startAnim: 'none' | 'orbit' | 'animTrack',
        animTrack: string
    },
    background: {
        color?: number[]
    },
    animTracks: AnimTrack[]
};
```

### Example settings.json

```json
{
  "background": {"color": [0,0,0,0]},
  "camera": {
    "fov": 1.0,
    "position": [0,1,-1],
    "target": [0,0,0],
    "startAnim": "orbit"
  }
}
```

[npm-version-badge]: https://img.shields.io/npm/v/@playcanvas/supersplat-viewer.svg
[npm-downloads-badge]: https://img.shields.io/npm/dw/@playcanvas/supersplat-viewer
[license-badge]: https://img.shields.io/npm/l/@playcanvas/supersplat-viewer.svg
[build-status-badge]: https://github.com/playcanvas/supersplat-viewer/actions/workflows/ci.yml/badge.svg
[issue-resolve-badge]: https://isitmaintained.com/badge/resolution/playcanvas/supersplat-viewer.svg
[open-issues-badge]: https://isitmaintained.com/badge/open/playcanvas/supersplat-viewer.svg

[npm-url]: https://www.npmjs.com/package/@playcanvas/supersplat-viewer
[npm-trends-url]: https://npmtrends.com/@playcanvas/supersplat-viewer
[license-url]: https://github.com/playcanvas/supersplat-viewer/blob/main/LICENSE
[isitmaintained-url]: https://isitmaintained.com/project/playcanvas/supersplat-viewer
[workflow-url]: https://github.com/playcanvas/supersplat-viewer/actions/workflows/ci.yml

[manual-url]: https://developer.playcanvas.com
[api-url]: https://api.playcanvas.com
[blog-url]: https://blog.playcanvas.com
[forum-url]: https://forum.playcanvas.com
[discord-url]: https://discord.gg/RSaMRzg
[reddit-url]: https://www.reddit.com/r/PlayCanvas/
[twitter-url]: https://twitter.com/intent/follow?screen_name=playcanvas