# Tiled voxel collision

Large scenes can split collision into spatial XZ tiles while continuing to use the ordinary
`.voxel.json` / `.voxel.bin` format for each tile. Pass the manifest through the existing
`collision` URL parameter or the programmatic `collisionUrl` option:

```js
const viewer = await createViewer({
    container,
    contentUrl: './scene/lod-meta.json',
    collisionUrl: './collision/voxel-tiles.json'
});
```

JSON collision assets are identified from their contents. An object with `tiles` is a tiled
manifest; ordinary single-voxel metadata and `.glb` mesh assets keep their existing behavior.

## Manifest version 1

All bounds are in PlayCanvas world coordinates (Y up). `ix` and `iz` are zero-based indices
from `fullBounds.min`; the core begins at that origin plus the index times `tileSize`, with
the final row/column clipped to `fullBounds.max`. Cores never overlap. `dataBounds` contains
the core plus the generation overlap, and must match the tile's voxel grid bounds.

```json
{
    "version": 1,
    "voxelResolution": 0.08,
    "tileSize": 64,
    "overlap": 8,
    "fullBounds": { "min": [0, 0, 0], "max": [128, 16, 64] },
    "tiles": [
        {
            "id": "x0_z0",
            "ix": 0,
            "iz": 0,
            "coreBounds": { "min": [0, 0, 0], "max": [64, 16, 64] },
            "dataBounds": { "min": [0, 0, 0], "max": [72, 16, 64] },
            "url": "tiles/x0_z0/walk.voxel.json"
        },
        {
            "id": "x1_z0",
            "ix": 1,
            "iz": 0,
            "coreBounds": { "min": [64, 0, 0], "max": [128, 16, 64] },
            "dataBounds": { "min": [56, 0, 0], "max": [128, 16, 64] },
            "url": "tiles/x1_z0/walk.voxel.json"
        }
    ]
}
```

Tile URLs resolve relative to the manifest URL, including when the manifest is redirected.
Each tile must use voxel format `1.1` at `voxelResolution`; its sibling binary URL replaces
`.voxel.json` with `.voxel.bin`. Use a consistent voxel lattice when generating overlapping
tiles. Occupied voxels are combined as a union: free space in one tile cannot erase geometry
in another, and duplicate overlap does not double collision push-out.

## Loading and missing data

The viewer loads the camera's core tile and up to eight adjacent tiles. Requests are
deduplicated; leaving the neighborhood releases tile data and cancels pending requests.
Failed active tiles retry after 1, 2, 4, 8, 16 and then 30 seconds, including while the camera
is stationary. Only the first failure in a run emits a warning. Destroying the viewer cancels
requests and retries.

Splat rendering does not wait for collision. Walk becomes available when the camera's
footprint is covered by loaded cores; movement, spawn search and walk navigation targets
cannot enter unavailable coverage. Movement pauses at a missing boundary and can resume
after loading succeeds. Orbit and fly remain available. Empty cores can be omitted from the
manifest; those gaps, and positions outside `fullBounds`, have no walking coverage.

Collision queries work with WebGPU and WebGL. **Show Collision** and the `heatmap` option
visualize loaded tiles on WebGPU. Their GPU resources are allocated when shown and released
when hidden, evicted or destroyed. The working set uses one overlay per active tile, so its
rendering cost scales with the number of visible tiles and viewport size.

The debug view composites tiles independently. Overlapping surfaces can appear brighter,
and a tile's overlay is not occluded by a nearer hit from another tile. This view shows the
active collision working set; it is not a globally depth-resolved rendering of their union.
Collision queries themselves resolve the occupied union as described above.
