# SuperSplat Viewer

This is the official viewer for https://superspl.at and the SuperSplat Editor HTML export.

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

```
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

## Notes
- We plan to convert the source to typescript
