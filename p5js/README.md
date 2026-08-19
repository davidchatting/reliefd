# p5js — Isometric Terrain Viewer

Browser-based viewers for the SRTM tile server, served automatically at `http://localhost:3000` when the parent server is running. Two of the three (`index.html`, `contours.html`) are p5.js sketches; `skyline.html` isn't — it just fetches and re-projects real SVG output, no canvas library needed.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Isometric bar-chart page shell — mounts the p5.js canvas and a coordinate overlay |
| `style.css` | Full-screen canvas, grab cursor, fixed info overlay (for `index.html`) |
| `sketch.js` | Isometric bar-chart rendering logic |
| `contours.html` / `contours-sketch.js` | Pannable contour-map viewer |
| `skyline.html` / `skyline.js` | Isometric skyline viewer — see below |

## How it works

1. **`preload()`** fetches `/info` from the server to get the native SRTM sample spacing (`files[0].pixelDeg` — assumes a single resolution across all loaded tiles); **`setup()`** then uses it to compute `GRID_W × GRID_H` (so each bar in the chart maps to exactly one SRTM data point) and the `DATA_ZOOM` tile-request level.
2. **`ensureTilesLoaded()`** requests elevation tiles (`/tiles/z/x/y.png?raw=true` — the exact 16-bit encoding, not the server's default greyscale) for all slippy-map tiles in the current view. Pixel data is extracted once on load via `img.loadPixels()` and cached as a `Uint8Array`.
3. **`draw()`** samples the cached tile pixels at each grid cell, decodes the 16-bit R/G-encoded value back to metres (`v16 = (R << 8) | G`, then `(v16 / 65535) × 9000 − 500`), then renders the scene in four layers (back to front):
   - **Soil layer** — opaque brown diamond, offset `maxBarH × 2.875` below ground.
   - **Sea layer** — opaque blue diamond at ground level (0 m). Cells at or below sea level are skipped in the bar loop; this layer covers them.
   - **Terrain bars** — green isometric bars for cells above sea level, rendered back-to-front (ascending `gx+gy` diagonals). Each bar has three faces (top, right, front) at different brightnesses for a 3-D appearance.
   - **Sky layer** — semi-transparent blue diamond, offset `maxBarH × 2.875` above ground.

## Configuration

Most tunable values are constants at the top of `sketch.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `LON_DEFAULT` | −1.6 | Centre longitude, overridable via `?lon=` in the URL |
| `LAT_DEFAULT` | 55.0 | Centre latitude, overridable via `?lat=` in the URL |
| `RADIUS_KM` | 2.5 | Half-width of the view in kilometres |
| `ELEV_MIN` / `ELEV_RANGE` | −500 / 9000 | Must match the server's elevation encoding range |
| `ELEV_DISPLAY_MAX` | 300 | Elevation (metres) at which the colour scale tops out |
| `MAX_BARS` | 120 | Cap on bars per axis, to bound draw cost for large views |

`DATA_ZOOM` isn't one of these — it's computed in `setup()` from the server's `pixelDeg` so tile requests match the loaded SRTM resolution, rather than being a value you'd tune directly.

## Interaction

| Action | Effect |
|--------|--------|
| Drag | Pan the view |
| Window resize | Canvas and layout recalculate automatically |

## Skyline viewer

`skyline.html` renders `/skyline.svg`'s visible-horizon data as a ring in isometric view instead of an unrolled strip — same idea as the README's "Skyline profile" section, just wrapped around a circle.

Since `/skyline.svg` only returns rendered SVG, not raw JSON, `skyline.js` recovers the real bearing/height samples by parsing its own output back out (`width` and the `<polyline points="...">` attribute), the same "decode the server's own rendered output" approach `sketch.js` already uses for elevation tiles — just on an SVG string instead of PNG pixels. It then re-projects those samples itself:

- **Isometric angle**: true isometric (30° ground-line angle: `KX = cos(30°)`, `KY = sin(30°)`), not the flatter 2:1 dimetric ratio common in pixel-art isometric tiles.
- **North at the top**: an isometric projection skews a true ground-plane circle into a rotated ellipse, so bearing 0 only lands at the ellipse's screen-top vertex after a −45° ground-angle offset is applied first (see `groundPoint()`). The outermost ring's line always starts there and runs clockwise (N→E→S→W), marked with a small dot.
- **Vertical scale**: `PX_PER_M = 0.5`, a legibility pick rather than a geographic one — unlike `/line.svg`, there's no real horizontal distance axis here to tie a "true scale" to, since the x-axis is bearing, not distance. It's the same for every radius, so real elevation genuinely is comparable ring to ring.
- **Multiple radii**: `?radii=5,10,15` (comma-separated) fetches `/skyline.svg` once per radius and draws them as concentric rings in one image, instead of the single `?radius=` ring. Screen radius scales linearly with real radius (`ringRadiusPx()`) — `MAX_RING_R` sets the size of whichever radius is *largest*, so a single radius still renders exactly as before. Every ring/skyline is drawn identically (plain black, via the shared `.ring`/`.skyline` classes, no per-ring styling) — radius is what tells them apart, made explicit by a small `Nkm` label sitting `LABEL_OFFSET` px directly under each ring's own line at bearing 0 (12 o'clock). Only the outermost ring gets the N/E/S/W compass letters and the bearing-0 start marker, since those would otherwise repeat identically at every radius.
- **Centre marker**: a small filled ellipse at dead centre marks the observer's own ground position. Built the same way as the rings themselves — `groundPoint()` sampled around a small fixed radius (`CENTRE_R`), then `isoProject()` — so it comes out as the same isometric ellipse shape/orientation as every ring, rather than a plain screen-space circle that would look tilted relative to everything else in the scene.

| Constant | Default | Description |
|----------|---------|-------------|
| `LON_DEFAULT` / `LAT_DEFAULT` | −1.6 / 55.0 | Centre point, overridable via `?lon=`/`?lat=` in the URL |
| `RADII_KM_DEFAULT` | `[15]` | Search radii in kilometres, overridable via `?radii=5,10,15` (or the single-value `?radius=`) |
| `DIRECTIONS_DEFAULT` | 360 | Bearings sampled, overridable via `?directions=` |
| `PX_PER_M` | 0.5 | Vertical scale (see above) |
| `MAX_RING_R` | 230 | Screen radius (SVG user units) of the largest ring drawn |
| `LABEL_OFFSET` | 12 | How far below each ring's own north-point line its `Nkm` label sits, SVG user units |
| `CENTRE_R` | 6 | Ground-plane radius (same units as `MAX_RING_R`) of the filled centre marker |

The form (top-left) re-fetches and re-renders on submit — "Radii (km)" takes one value or a comma-separated list; the info bar (bottom-left) shows centre, radii, and bearing count — no elevation-range readout, since that would mean scanning every sample on every load just to display a number nothing else here depends on.
