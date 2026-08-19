import express from "express";
import { PNG } from "pngjs";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(process.cwd(), "data");
const CACHE_DIR = path.join(process.cwd(), "cache");
const TILE_SIZE = 256;
const ELEV_MIN = -500;
const ELEV_MAX = 8500;
const ELEV_RANGE = ELEV_MAX - ELEV_MIN;

app.use(express.static(path.join(process.cwd(), "p5js")));
app.use(express.json());

// Disk cache for generated SVGs, keyed by every parameter that affects the
// output. Lets a slow contour render be computed once (e.g. while warming the
// cache for a demo area) and reused on every later request without touching
// the elevation data or the marching-squares/smoothing pipeline again.
function cachePath(category, parts) {
  const key = crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 20);
  return path.join(CACHE_DIR, category, `${key}.svg`);
}

function readCache(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeCache(filePath, svg) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, svg);
  } catch (err) {
    console.error("Cache write failed:", err);
  }
}

// --- HGT file reading ---
// .hgt files are a flat row-major grid of big-endian signed Int16.
// Resolution is inferred from file size: 1201×1201 (SRTM3) or 3601×3601 (SRTM1).
// Origin is parsed from the filename (SW corner of the 1°×1° tile).

// Derives a tile's sample spacing from its file size alone (1201x1201 for
// SRTM3, 3601x3601 for SRTM1 - 2 bytes/sample), without reading its
// elevation data.
function tilePixelDeg(filePath) {
  const { size: byteLength } = fs.statSync(filePath);
  const gridSize = Math.round(Math.sqrt(byteLength / 2));
  return 1 / (gridSize - 1);
}

// Parses the 1x1-degree bounds a tile covers from its filename alone (e.g.
// N51W001.hgt -> 51-52N, 1-0W), without reading the file's elevation data.
function parseTileBounds(filePath) {
  const name = path.basename(filePath, ".hgt");
  const swLat = (name[0] === "N" ? 1 : -1) * parseInt(name.slice(1, 3));
  const swLon = (name[3] === "E" ? 1 : -1) * parseInt(name.slice(4, 7));
  return {
    minLon: swLon,
    maxLon: swLon + 1,
    minLat: swLat,
    maxLat: swLat + 1, // north edge
  };
}

function openHGT(filePath) {
  const data = fs.readFileSync(filePath);
  const size = Math.round(Math.sqrt(data.length / 2)); // 1201 or 3601
  const pixelDeg = 1 / (size - 1);
  return { data, size, pixelDeg, ...parseTileBounds(filePath) };
}

function readHGTRegion(hgt, tx1, ty1, w, h) {
  const { data, size } = hgt;
  const out = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const val = data.readInt16BE(((ty1 + row) * size + (tx1 + col)) * 2);
      out[row * w + col] = val <= -32768 ? NaN : val;
    }
  }
  return out;
}

// --- SRTM tile name helpers ---

function lonLatToTileName(lon, lat) {
  const latStr = (lat >= 0 ? "N" : "S") + String(Math.abs(Math.floor(lat))).padStart(2, "0");
  const lonStr = (lon >= 0 ? "E" : "W") + String(Math.abs(Math.floor(lon))).padStart(3, "0");
  return `${latStr}${lonStr}.hgt`;
}

function getTileNamesForBounds(minLon, minLat, maxLon, maxLat) {
  const tiles = [];
  for (let lat = Math.floor(minLat); lat <= Math.floor(maxLat); lat++) {
    for (let lon = Math.floor(minLon); lon <= Math.floor(maxLon); lon++) {
      tiles.push(lonLatToTileName(lon, lat));
    }
  }
  return tiles;
}

// Load each overlapping HGT tile's relevant region into a cache keyed by tile name
function loadSRTMCache(viewMinLon, viewMinLat, viewMaxLon, viewMaxLat) {
  const cache = new Map();
  for (const name of getTileNamesForBounds(viewMinLon, viewMinLat, viewMaxLon, viewMaxLat)) {
    const filePath = path.join(DATA_DIR, name);
    if (!fs.existsSync(filePath)) continue;

    const hgt = openHGT(filePath);
    const { minLon, maxLon, minLat, maxLat, pixelDeg, size } = hgt;

    const oMinLon = Math.max(viewMinLon, minLon);
    const oMaxLon = Math.min(viewMaxLon, maxLon);
    const oMinLat = Math.max(viewMinLat, minLat);
    const oMaxLat = Math.min(viewMaxLat, maxLat);
    if (oMinLon >= oMaxLon || oMinLat >= oMaxLat) continue;

    // Padded by 1px so sampleCache's bilinear lookup always has a neighbour to
    // interpolate against, even for points right at the requested view's edge.
    const tx1 = Math.max(0, Math.floor((oMinLon - minLon) / pixelDeg) - 1);
    const tx2 = Math.min(size, Math.ceil((oMaxLon - minLon) / pixelDeg) + 1);
    const ty1 = Math.max(0, Math.floor((maxLat - oMaxLat) / pixelDeg) - 1);
    const ty2 = Math.min(size, Math.ceil((maxLat - oMinLat) / pixelDeg) + 1);

    const readWidth  = tx2 - tx1;
    const readHeight = ty2 - ty1;
    if (readWidth <= 0 || readHeight <= 0) continue;

    cache.set(name, {
      data:       readHGTRegion(hgt, tx1, ty1, readWidth, readHeight),
      readWidth,
      readHeight,
      originLon:  minLon + tx1 * pixelDeg, // west edge of read region
      originLat:  maxLat - ty1 * pixelDeg, // north edge of read region
      pixelDeg,
    });
  }
  return cache;
}

// Bilinear interpolation between the 4 nearest samples, so values vary smoothly
// even when querying at a finer resolution than SRTM's native ~30-90m grid
// (otherwise nearest-neighbour lookups produce blocky, axis-aligned contours).
function sampleCache(cache, lon, lat) {
  const c = cache.get(lonLatToTileName(lon, lat));
  if (!c) return NaN;

  const fx = (lon - c.originLon) / c.pixelDeg;
  const fy = (c.originLat - lat) / c.pixelDeg;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;

  const at = (x, y) => (x < 0 || x >= c.readWidth || y < 0 || y >= c.readHeight) ? NaN : c.data[y * c.readWidth + x];
  const v00 = at(x0, y0), v10 = at(x0 + 1, y0), v01 = at(x0, y0 + 1), v11 = at(x0 + 1, y0 + 1);
  if (isNaN(v00) || isNaN(v10) || isNaN(v01) || isNaN(v11)) return at(Math.round(fx), Math.round(fy));

  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

// --- Slippy tile math (Web Mercator) ---

function tileToNWCorner(x, y, z) {
  const n = Math.pow(2, z);
  return {
    lon: (x / n) * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI),
  };
}

function tileBounds(x, y, z) {
  const nw = tileToNWCorner(x, y, z);
  const se = tileToNWCorner(x + 1, y + 1, z);
  return { minLon: nw.lon, maxLon: se.lon, minLat: se.lat, maxLat: nw.lat };
}

function pixelToLonLat(px, py, tileX, tileY, z) {
  const n = Math.pow(2, z);
  const lon = ((tileX + px / TILE_SIZE) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + py / TILE_SIZE)) / n))) * (180 / Math.PI);
  return { lon, lat };
}

// --- Convert km radius to degree offsets ---

function kmToDegreeOffsets(lat, radiusKm) {
  return {
    latOffset: radiusKm / 111.32,
    lonOffset: radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180)),
  };
}

// --- Contour generation ---

// Round a raw interval up to a "nice" 1/2/5 * 10^n step.
function niceInterval(raw) {
  if (raw <= 0) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / Math.pow(10, exponent);
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * Math.pow(10, exponent);
}

// Default contour interval, keyed by zoom only (not by any one tile's local relief) —
// every tile at a given z picks the same levels, so lines land on the same elevation
// bands and connect across tile edges instead of each tile inventing its own steps.
//
// Bands are anchored to the real OS leisure map series, converted from published
// scale to slippy-map zoom via the standard ground-resolution formula
// (metresPerPixel = 156543 * cos(lat) / 2^z, at the equator; scale denominator
// assumes a 0.28mm pixel). That puts OS Landranger (1:50,000, 10m interval) at
// z≈13.45 and OS Explorer (1:25,000, 5m interval) at z≈14.45 — the two real
// anchor points below. Zooms outside that range extrapolate the same roughly
// 2x-per-zoom progression OS itself uses between its published scales.
const ZOOM_INTERVALS = [
  [9, 100],   // wider than 1:1,000,000 — coarser than any OS leisure product
  [11, 50],   // ~1:250,000
  [12, 20],   // ~1:100,000
  [14, 10],   // ~1:50,000  — OS Landranger interval
  [16, 5],    // ~1:25,000  — OS Explorer interval (lowland)
  [18, 2],    // ~1:10,000  — finer than any OS leisure map; extrapolated
];

function intervalForZoom(z) {
  for (const [maxZoom, interval] of ZOOM_INTERVALS) {
    if (z <= maxZoom) return interval;
  }
  return 1; // ~1:5,000 and closer — survey/LIDAR-grade resolution territory
}

// Writes one elevation sample into a PNG's RGBA buffer at byte offset `idx`.
// Both encodings use the same fixed -500m..8500m range as everywhere else in
// this file, so tiles/images stay visually/decodably consistent with each
// other regardless of any one area's local min/max.
//
// raw=true: 16-bit precision split across the R and G channels
// (`R << 8 | G`) — decode with `(v16 / 65535) * 9000 - 500`. Needed by
// consumers that reconstruct exact elevation, e.g. the isometric viewer.
// raw=false (default): a single-channel greyscale byte — a plain, pleasant
// image to look at directly, at the cost of only 8-bit precision.
function writeElevationPixel(data, idx, val, raw) {
  if (isNaN(val)) {
    data[idx + 3] = 0;
    return;
  }
  if (raw) {
    const v16 = Math.max(0, Math.min(65535, Math.round(((val - ELEV_MIN) / ELEV_RANGE) * 65535)));
    data[idx]     = (v16 >> 8) & 0xff;
    data[idx + 1] = v16 & 0xff;
    data[idx + 2] = 0;
  } else {
    const g = Math.max(0, Math.min(255, Math.round(((val - ELEV_MIN) / ELEV_RANGE) * 255)));
    data[idx] = g; data[idx + 1] = g; data[idx + 2] = g;
  }
  data[idx + 3] = 255;
}

// Marching squares: returns line segments (in grid cell units) where `grid` crosses `level`.
// Cells touching a NaN sample are skipped (no data).
function marchingSquares(grid, w, h, level) {
  const segments = [];
  const lerp = (a, b) => (level - a) / (b - a);

  for (let row = 0; row < h - 1; row++) {
    for (let col = 0; col < w - 1; col++) {
      const tl = grid[row * w + col];
      const tr = grid[row * w + col + 1];
      const bl = grid[(row + 1) * w + col];
      const br = grid[(row + 1) * w + col + 1];
      if (isNaN(tl) || isNaN(tr) || isNaN(bl) || isNaN(br)) continue;

      const idx = (tl > level ? 8 : 0) | (tr > level ? 4 : 0) | (br > level ? 2 : 0) | (bl > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;

      const top    = { x: col + lerp(tl, tr), y: row };
      const right  = { x: col + 1, y: row + lerp(tr, br) };
      const bottom = { x: col + lerp(bl, br), y: row + 1 };
      const left   = { x: col, y: row + lerp(tl, bl) };

      // Ambiguous saddle cases (5, 10) resolved with a fixed diagonal choice.
      const cases = {
        1: [[left, bottom]],
        2: [[bottom, right]],
        3: [[left, right]],
        4: [[top, right]],
        5: [[left, top], [bottom, right]],
        6: [[top, bottom]],
        7: [[left, top]],
        8: [[top, left]],
        9: [[top, bottom]],
        10: [[top, right], [left, bottom]],
        11: [[top, right]],
        12: [[left, right]],
        13: [[bottom, right]],
        14: [[left, bottom]],
      };

      for (const [a, b] of cases[idx]) segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }
  return segments;
}

// 3x3 box blur over the sampled elevation grid, ignoring NaN (no-data) neighbours.
// Real elevation data — especially dense urban terrain — has sharp, grid-aligned
// jumps between adjacent samples; contouring it raw produces blocky, near-90°
// turns no amount of polyline smoothing removes, since the underlying field
// itself is blocky. Blurring it first gives marching squares a softer field to
// trace, on top of the polyline smoothing in smoothPathD.
function blurGrid(src, w, h, passes) {
  let grid = src;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(w * h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const r = row + dy, c = col + dx;
            if (r < 0 || r >= h || c < 0 || c >= w) continue;
            const v = grid[r * w + c];
            if (isNaN(v)) continue;
            sum += v;
            count++;
          }
        }
        out[row * w + col] = count > 0 ? sum / count : NaN;
      }
    }
    grid = out;
  }
  return grid;
}

// Marching squares emits one independent segment per grid cell, so neighbouring
// cells on the same contour line each draw their own short straight stroke —
// that's the source of the faceted, right-angled look. Two adjacent cells'
// shared edge crossing is computed from the same pair of corner values in both
// cells, so it lands at the exact same point; chain segments into polylines (or
// closed loops) by joining on those shared endpoints so each contour line can be
// drawn — and smoothed — as a single path.
function chainSegments(segments) {
  const keyOf = (x, y) => `${x.toFixed(4)},${y.toFixed(4)}`;
  const adjacency = new Map();
  const addAdj = (x, y, point, segIndex) => {
    const k = keyOf(x, y);
    if (!adjacency.has(k)) adjacency.set(k, []);
    adjacency.get(k).push({ point, segIndex });
  };
  segments.forEach((s, i) => {
    addAdj(s.x1, s.y1, { x: s.x2, y: s.y2 }, i);
    addAdj(s.x2, s.y2, { x: s.x1, y: s.y1 }, i);
  });

  const used = new Set();
  const chains = [];

  const nextUnused = (point) => {
    for (const c of adjacency.get(keyOf(point.x, point.y)) || []) {
      if (!used.has(c.segIndex)) return c;
    }
    return null;
  };

  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const chain = [{ x: segments[i].x1, y: segments[i].y1 }, { x: segments[i].x2, y: segments[i].y2 }];
    let closed = false;

    let next;
    while ((next = nextUnused(chain[chain.length - 1]))) {
      used.add(next.segIndex);
      const p = next.point;
      if (chain.length > 2 && Math.abs(p.x - chain[0].x) < 1e-4 && Math.abs(p.y - chain[0].y) < 1e-4) {
        closed = true;
        break;
      }
      chain.push(p);
    }

    if (!closed) {
      let prev;
      while ((prev = nextUnused(chain[0]))) {
        used.add(prev.segIndex);
        chain.unshift(prev.point);
      }
    }

    chains.push({ points: chain, closed });
  }
  return chains;
}

// Chaikin corner-cutting: each iteration replaces every edge with two points at
// 1/4 and 3/4 along it, pulling the line away from each original vertex. A
// single pass (as a Bezier through midpoints) only softens the joint between
// two edges; this actually erodes the sharp turns themselves, which is what's
// needed where marching squares traces a flat plateau (e.g. sea-level cells)
// and produces long grid-aligned, near-90° runs.
function chaikinSmooth(points, closed, iterations) {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    const n = pts.length;
    const out = closed ? [] : [pts[0]];
    const limit = closed ? n : n - 1;
    for (let i = 0; i < limit; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % n];
      out.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
      out.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    if (!closed) out.push(pts[n - 1]);
    pts = out;
  }
  return pts;
}

// Perpendicular distance from p to the line through a-b (0 if a===b).
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Douglas-Peucker simplification. Blurring the elevation field rounds real
// terrain, but some of the staircase look comes from genuinely rectilinear
// features (piers, building footprints) baked into the DEM at the raster's
// native resolution — no amount of blur fixes that, it just fights the data.
// Dropping points that deviate less than `tolerance` from the line they sit
// near removes the small staircase teeth while leaving real shape intact, so
// the later Chaikin pass has fewer, longer edges to round into curves.
function simplifyOpen(points, tolerance) {
  if (points.length < 3) return points;
  const a = points[0], b = points[points.length - 1];
  let maxDist = -1, idx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > tolerance) {
    const left = simplifyOpen(points.slice(0, idx + 1), tolerance);
    const right = simplifyOpen(points.slice(idx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function simplifyChain(points, closed, tolerance) {
  if (points.length < 3) return points;
  if (!closed) return simplifyOpen(points, tolerance);
  const simplified = simplifyOpen(points.concat([points[0]]), tolerance);
  if (simplified.length > 2) simplified.pop();
  return simplified;
}

// Below this on-screen span (px), a chain that simplifies down to just its
// two endpoints isn't a legible contour line - "M a L b" (or "...Z" if
// chainSegments happened to mark it closed) draws one bare straight
// stroke, no smoothing to soften it, typically from noise in the source
// DEM at the sampled resolution. Checked *after* simplifyChain rather than
// on the raw point count: Douglas-Peucker can collapse a longer but
// still-tiny, nearly-straight run down to 2 points, so checking the raw
// chain first would miss those. A real small feature (a tiny hilltop, a
// shallow depression) has actual curvature, not just noise along a line,
// so simplification leaves it with more than 2 points and it stays
// legitimate regardless of its physical size.
//
// Excludes chains touching the sampled grid's edge: those are genuinely
// short because marching squares had no neighbouring cell to continue
// into, not because the underlying contour is actually that short - the
// real line carries on past the edge of what was requested.
const MIN_CHAIN_PX = 15;
const GRID_EDGE_MARGIN = 1.5;

function nearGridEdge(p, gridSize) {
  return p.x < GRID_EDGE_MARGIN || p.x > gridSize - 1 - GRID_EDGE_MARGIN ||
         p.y < GRID_EDGE_MARGIN || p.y > gridSize - 1 - GRID_EDGE_MARGIN;
}

// Render a chained contour as a single smoothed path.
function smoothPathD(points, closed, scale, gridSize) {
  if (points.length < 2) return null;
  const simplified = simplifyChain(points, closed, 1.2);
  if (simplified.length === 2 && !nearGridEdge(simplified[0], gridSize) && !nearGridEdge(simplified[1], gridSize)) {
    const dx = (simplified[1].x - simplified[0].x) * scale;
    const dy = (simplified[1].y - simplified[0].y) * scale;
    if (Math.hypot(dx, dy) < MIN_CHAIN_PX) return null;
  }
  const smoothed = simplified.length > 2 ? chaikinSmooth(simplified, closed, 4) : simplified;
  const pts = smoothed.map(p => ({ x: p.x * scale, y: p.y * scale }));
  const fmt = p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

  let d = `M${fmt(pts[0])} `;
  for (let i = 1; i < pts.length; i++) d += `L${fmt(pts[i])} `;
  if (closed) d += "Z";
  return d;
}

// --- Routes ---

app.get("/info", (req, res) => {
  const names = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".hgt"));
  if (names.length === 0) return res.status(404).json({ error: "No data" });

  const files = names.map(name => ({
    name,
    pixelDeg: tilePixelDeg(path.join(DATA_DIR, name)),
    region: parseTileBounds(name),
  }));

  res.json({ files });
});

app.get("/heightmap", (req, res) => {
  const lon     = parseFloat(req.query.lon);
  const lat     = parseFloat(req.query.lat);
  const radiusKm = parseFloat(req.query.radius)  || 1;
  const samples  = Math.min(256, Math.max(2, parseInt(req.query.samples) || 64));

  if (isNaN(lon) || isNaN(lat)) return res.status(400).send("Invalid lon/lat");

  const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);
  const cache = loadSRTMCache(lon - lonOffset, lat - latOffset, lon + lonOffset, lat + latOffset);
  if (cache.size === 0) return res.status(404).send("No elevation data available");

  const data = new Array(samples * samples);
  for (let row = 0; row < samples; row++) {
    for (let col = 0; col < samples; col++) {
      const sLon = (lon - lonOffset) + (col / (samples - 1)) * lonOffset * 2;
      const sLat = (lat + latOffset) - (row / (samples - 1)) * latOffset * 2;
      const val  = sampleCache(cache, sLon, sLat);
      data[row * samples + col] = isNaN(val) ? 0 : val;
    }
  }

  res.json({ samples, data });
});

app.get("/contours.svg", (req, res) => {
  try {
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    const radiusKm = parseFloat(req.query.radius) || 5;
    const samples = Math.min(400, Math.max(8, parseInt(req.query.resolution) || 100));
    const size = Math.min(2000, Math.max(64, parseInt(req.query.size) || 800));
    if (isNaN(lon) || isNaN(lat)) return res.status(400).send("Invalid lon/lat");

    const cacheFile = cachePath("contours", { lon, lat, radiusKm, samples, size, interval: req.query.interval || "auto" });
    const cached = readCache(cacheFile);
    if (cached) return res.type("image/svg+xml").send(cached);

    const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);
    const cache = loadSRTMCache(lon - lonOffset, lat - latOffset, lon + lonOffset, lat + latOffset);
    if (cache.size === 0) return res.status(404).send("No elevation data available");

    let grid = new Float32Array(samples * samples);
    for (let row = 0; row < samples; row++) {
      for (let col = 0; col < samples; col++) {
        const sLon = (lon - lonOffset) + (col / (samples - 1)) * lonOffset * 2;
        const sLat = (lat + latOffset) - (row / (samples - 1)) * latOffset * 2;
        grid[row * samples + col] = sampleCache(cache, sLon, sLat);
      }
    }
    grid = blurGrid(grid, samples, samples, 3);

    let min = Infinity, max = -Infinity;
    for (const v of grid) {
      if (!isNaN(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    if (min === Infinity) return res.status(404).send("No elevation data available for this area");

    const interval = parseFloat(req.query.interval) || niceInterval((max - min) / 12);
    const scale = size / (samples - 1);

    let body = "";
    for (let level = Math.ceil(min / interval) * interval; level < max; level += interval) {
      const segments = marchingSquares(grid, samples, samples, level);
      if (segments.length === 0) continue;
      for (const chain of chainSegments(segments)) {
        const d = smoothPathD(chain.points, chain.closed, scale, samples);
        if (d) body += `<path d="${d}"/>`;
      }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<g stroke="#000" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g>` +
      `</svg>`;

    writeCache(cacheFile, svg);
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.get("/contour-tiles/:z/:x/:y.svg", (req, res) => {
  try {
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);
    const y = parseInt(req.params.y);
    if (isNaN(z) || isNaN(x) || isNaN(y)) return res.status(400).send("Invalid tile coordinates");

    const samples = Math.min(256, Math.max(8, parseInt(req.query.resolution) || 128));

    const cacheFile = cachePath(`contour-tiles/${z}`, { x, y, resolution: samples, interval: req.query.interval || "auto" });
    const cached = readCache(cacheFile);
    if (cached) return res.type("image/svg+xml").send(cached);

    const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${TILE_SIZE}" viewBox="0 0 ${TILE_SIZE} ${TILE_SIZE}">`;
    const sendAndCache = svg => { writeCache(cacheFile, svg); res.type("image/svg+xml").send(svg); };

    // Sample a margin of extra grid cells beyond the tile's own edges (in
    // neighbouring tiles' territory) so the blur below has real data to draw on
    // right up to the tile boundary. Without this, each tile's edge would blur
    // against its own clipped average instead of the neighbour's actual values,
    // and the contours fixed earlier to stitch across tile edges would drift
    // apart again. 2 cells of margin covers 2 box-blur passes (radius 1 each).
    const blurPasses = 3;
    const margin = blurPasses;
    const paddedSamples = samples + margin * 2;
    const pixelAt = i => ((i - margin) / (samples - 1)) * TILE_SIZE;

    const nw = pixelToLonLat(pixelAt(0), pixelAt(0), x, y, z);
    const se = pixelToLonLat(pixelAt(paddedSamples - 1), pixelAt(paddedSamples - 1), x, y, z);
    const cache = loadSRTMCache(nw.lon, se.lat, se.lon, nw.lat);
    if (cache.size === 0) return sendAndCache(`${svgOpen}</svg>`);

    const paddedGrid = new Float32Array(paddedSamples * paddedSamples);
    for (let row = 0; row < paddedSamples; row++) {
      for (let col = 0; col < paddedSamples; col++) {
        const { lon, lat } = pixelToLonLat(pixelAt(col), pixelAt(row), x, y, z);
        paddedGrid[row * paddedSamples + col] = sampleCache(cache, lon, lat);
      }
    }
    const blurred = blurGrid(paddedGrid, paddedSamples, paddedSamples, blurPasses);

    const grid = new Float32Array(samples * samples);
    for (let row = 0; row < samples; row++) {
      for (let col = 0; col < samples; col++) {
        grid[row * samples + col] = blurred[(row + margin) * paddedSamples + (col + margin)];
      }
    }

    let min = Infinity, max = -Infinity;
    for (const v of grid) {
      if (!isNaN(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    if (min === Infinity) return sendAndCache(`${svgOpen}</svg>`);

    // OS Explorer actually uses 10m instead of 5m in mountainous regions (the
    // 5m lines would crowd together unreadably), but that's decided per published
    // map sheet — a fixed, pre-agreed boundary. Deciding it live per-tile from
    // each tile's own sampled relief would make neighbouring tiles disagree
    // whenever one straddles the steep/flat line, breaking the cross-tile
    // stitching above; deciding it from the whole source file's relief is too
    // coarse (e.g. SF's source file spans Mt. Tamalpais, so it'd flag flat
    // downtown SF as mountainous too). So it's left as an explicit override via
    // ?interval= rather than guessed automatically.
    const interval = parseFloat(req.query.interval) || intervalForZoom(z);
    const scale = TILE_SIZE / (samples - 1);

    let body = "";
    for (let level = Math.ceil(min / interval) * interval; level <= max; level += interval) {
      const segments = marchingSquares(grid, samples, samples, level);
      if (segments.length === 0) continue;
      for (const chain of chainSegments(segments)) {
        const d = smoothPathD(chain.points, chain.closed, scale, samples);
        if (d) body += `<path d="${d}"/>`;
      }
    }

    sendAndCache(`${svgOpen}<g stroke="#000" stroke-width="1" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.get("/tiles/:z/:x/:y.png", (req, res) => {
  try {
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);
    const y = parseInt(req.params.y);
    if (isNaN(z) || isNaN(x) || isNaN(y)) return res.status(400).send("Invalid tile coordinates");

    const raw = req.query.raw === "true" || req.query.raw === "1";

    const { minLon, maxLon, minLat, maxLat } = tileBounds(x, y, z);
    const cache = loadSRTMCache(minLon, minLat, maxLon, maxLat);
    const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });

    if (cache.size === 0) {
      png.data.fill(0); // fully transparent
      res.setHeader("Content-Type", "image/png");
      return png.pack().pipe(res);
    }

    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const { lon, lat } = pixelToLonLat(px + 0.5, py + 0.5, x, y, z);
        const val = sampleCache(cache, lon, lat);
        const idx = (py * TILE_SIZE + px) * 4;
        writeElevationPixel(png.data, idx, val, raw);
      }
    }

    res.setHeader("Content-Type", "image/png");
    png.pack().pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.get("/terrain", (req, res) => {
  try {
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    const radiusKm = parseFloat(req.query.radius);
    if (isNaN(lon) || isNaN(lat) || isNaN(radiusKm)) return res.status(400).send("Invalid lon/lat/radius");

    const resolution = req.query.resolution !== undefined
      ? Math.min(2000, Math.max(8, parseInt(req.query.resolution)))
      : null;
    const raw = req.query.raw === "true" || req.query.raw === "1";

    const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);
    const minLon = lon - lonOffset;
    const maxLon = lon + lonOffset;
    const minLat = lat - latOffset;
    const maxLat = lat + latOffset;

    let outWidth, outHeight, outputRaster;

    if (resolution) {
      // Resampled path: bilinear-sample a resolution x resolution grid, same
      // approach as /heightmap, trading exact native pixels for a fixed output size.
      const cache = loadSRTMCache(minLon, minLat, maxLon, maxLat);
      if (cache.size === 0) return res.status(404).send("No elevation data available for this area");

      outWidth = outHeight = resolution;
      outputRaster = new Float32Array(resolution * resolution);
      for (let row = 0; row < resolution; row++) {
        for (let col = 0; col < resolution; col++) {
          const sLon = minLon + (col / (resolution - 1)) * (maxLon - minLon);
          const sLat = maxLat - (row / (resolution - 1)) * (maxLat - minLat);
          outputRaster[row * resolution + col] = sampleCache(cache, sLon, sLat);
        }
      }
      if (!outputRaster.some(v => !isNaN(v))) return res.status(404).send("No elevation data available for this area");
    } else {
      // Full native-resolution path: exact per-pixel HGT samples, no interpolation.
      const tileNames = getTileNamesForBounds(minLon, minLat, maxLon, maxLat);
      console.log("Requested .hgt tile filenames:", tileNames);

      const available = tileNames
        .map(name => path.join(DATA_DIR, name))
        .filter(fp => fs.existsSync(fp));

      if (available.length === 0) {
        console.warn("No .hgt files found for tiles:", tileNames);
        return res.status(404).send("No local data available for this location");
      }

      const { pixelDeg } = openHGT(available[0]);
      outWidth  = Math.ceil((maxLon - minLon) / pixelDeg);
      outHeight = Math.ceil((maxLat - minLat) / pixelDeg);
      if (outWidth <= 0 || outHeight <= 0) return res.status(400).send("Requested area is out of bounds");

      outputRaster = new Float32Array(outWidth * outHeight).fill(NaN);

      for (const filePath of available) {
        const hgt = openHGT(filePath);
        const { minLon: tMinLon, maxLon: tMaxLon, minLat: tMinLat, maxLat: tMaxLat, size } = hgt;

        const oMinLon = Math.max(minLon, tMinLon);
        const oMaxLon = Math.min(maxLon, tMaxLon);
        const oMinLat = Math.max(minLat, tMinLat);
        const oMaxLat = Math.min(maxLat, tMaxLat);
        if (oMinLon >= oMaxLon || oMinLat >= oMaxLat) continue;

        const tx1 = Math.max(0, Math.floor((oMinLon - tMinLon) / pixelDeg));
        const tx2 = Math.min(size, Math.ceil((oMaxLon - tMinLon) / pixelDeg));
        const ty1 = Math.max(0, Math.floor((tMaxLat - oMaxLat) / pixelDeg));
        const ty2 = Math.min(size, Math.ceil((tMaxLat - oMinLat) / pixelDeg));

        const rw = tx2 - tx1;
        const rh = ty2 - ty1;
        if (rw <= 0 || rh <= 0) continue;

        const region = readHGTRegion(hgt, tx1, ty1, rw, rh);
        const readOriginLon = tMinLon + tx1 * pixelDeg;
        const readOriginLat = tMaxLat - ty1 * pixelDeg;
        const outOffX = Math.round((readOriginLon - minLon) / pixelDeg);
        const outOffY = Math.round((maxLat - readOriginLat) / pixelDeg);

        for (let row = 0; row < rh; row++) {
          for (let col = 0; col < rw; col++) {
            const outX = outOffX + col;
            const outY = outOffY + row;
            if (outX >= 0 && outX < outWidth && outY >= 0 && outY < outHeight) {
              outputRaster[outY * outWidth + outX] = region[row * rw + col];
            }
          }
        }
      }

      if (!outputRaster.some(v => !isNaN(v))) return res.status(404).send("No elevation data available for this area");
    }

    // Same fixed-range encoding as /tiles (raw or greyscale), so a /terrain
    // image and a /tiles mosaic of the same area agree with each other.
    const png = new PNG({ width: outWidth, height: outHeight });
    for (let i = 0; i < outputRaster.length; i++) {
      writeElevationPixel(png.data, i * 4, outputRaster[i], raw);
    }

    res.setHeader("Content-Type", "image/png");
    png.pack().pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// --- Line-of-sight / viewshed ---

const EARTH_RADIUS_KM = 6371;

// Standard spherical "destination point given distance and bearing" formula —
// more accurate across all bearings and latitudes than scaling lon/lat by
// fixed per-km degree offsets (which distorts as bearing departs from
// east/west), needed here since we sample in every direction around a point.
function destinationPoint(lon, lat, bearingDeg, distanceKm) {
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;

  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );

  return { lon: (lambda2 * 180) / Math.PI, lat: (phi2 * 180) / Math.PI };
}

// Drop (metres) of the line of sight below a straight chord over distance d,
// due to Earth's curvature. Scaling the radius by 7/6 is the standard
// approximation for atmospheric refraction bending the ray slightly back
// toward the surface, extending the geometric horizon by about 15%.
function curvatureDropM(distanceKm, refraction) {
  const effectiveRadiusKm = refraction ? EARTH_RADIUS_KM * (7 / 6) : EARTH_RADIUS_KM;
  const dM = distanceKm * 1000;
  return (dM * dM) / (2 * effectiveRadiusKm * 1000);
}

// Elevation in metres at (lon, lat), or sea level (0) if there's no data —
// e.g. open sea beyond the loaded tiles — so a sightline crossing open water
// gets a sensible curvature-limited result instead of an undefined gap.
function elevationOrSeaLevel(cache, lon, lat) {
  const v = sampleCache(cache, lon, lat);
  return isNaN(v) ? 0 : v;
}

// The line-of-sight elevation angle (radians) from an observer to a point at
// `elevAtPoint` metres, `distanceKm` away, accounting for Earth's curvature
// and optionally refraction.
function lineOfSightAngleAtElevation(observerElev, elevAtPoint, distanceKm, refraction) {
  const drop = curvatureDropM(distanceKm, refraction);
  return Math.atan2(elevAtPoint - observerElev - drop, distanceKm * 1000);
}

// Same, but for a point given as bearing+distance from the observer rather
// than an explicit elevation — samples the real terrain there (ground level
// + targetHeight) rather than an absolute altitude. Shared by /viewshed
// (scanning outward to find the furthest point whose angle clears everything
// closer) and /visibility (checking each intermediate point along a path to
// a specific target) — both are the same underlying line-of-sight test,
// just asking a different question of it.
function lineOfSightAngle(cache, lon, lat, observerElev, bearingDeg, distanceKm, targetHeight, refraction) {
  const { lon: tLon, lat: tLat } = destinationPoint(lon, lat, bearingDeg, distanceKm);
  const elev = elevationOrSeaLevel(cache, tLon, tLat) + targetHeight;
  return lineOfSightAngleAtElevation(observerElev, elev, distanceKm, refraction);
}

// Haversine great-circle distance (km) between two lon/lat points.
function haversineDistanceKm(lon0, lat0, lon1, lat1) {
  const phi1 = (lat0 * Math.PI) / 180;
  const phi2 = (lat1 * Math.PI) / 180;
  const dPhi = ((lat1 - lat0) * Math.PI) / 180;
  const dLambda = ((lon1 - lon0) * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

// Initial bearing (degrees, 0-360) for the great-circle path from point 0 to point 1.
function initialBearing(lon0, lat0, lon1, lat1) {
  const phi1 = (lat0 * Math.PI) / 180;
  const phi2 = (lat1 * Math.PI) / 180;
  const dLambda = ((lon1 - lon0) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

app.get("/viewshed", (req, res) => {
  try {
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    if (isNaN(lon) || isNaN(lat)) return res.status(400).send("Invalid lon/lat");

    const radiusKm = Math.min(200, Math.max(0.5, parseFloat(req.query.radius) || 30));
    const directions = Math.min(720, Math.max(8, parseInt(req.query.directions) || 360));
    const steps = Math.min(2000, Math.max(8, parseInt(req.query.steps) || 256));
    const observerHeight = parseFloat(req.query.observerHeight) || 1.7;
    const targetHeight = parseFloat(req.query.targetHeight) || 0;
    const refraction = req.query.refraction !== "false" && req.query.refraction !== "0";

    const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);
    const cache = loadSRTMCache(lon - lonOffset, lat - latOffset, lon + lonOffset, lat + latOffset);
    if (cache.size === 0) return res.status(404).send("No elevation data available");

    const observerGroundElev = sampleCache(cache, lon, lat);
    if (isNaN(observerGroundElev)) return res.status(404).send("No elevation data at observer location");
    const observerElev = observerGroundElev + observerHeight;

    const stepKm = radiusKm / steps;
    const ring = [];

    for (let i = 0; i < directions; i++) {
      const bearing = (i * 360) / directions;
      let maxAngle = -Infinity;
      let furthest = destinationPoint(lon, lat, bearing, stepKm);

      for (let s = 1; s <= steps; s++) {
        const dKm = s * stepKm;
        const angle = lineOfSightAngle(cache, lon, lat, observerElev, bearing, dKm, targetHeight, refraction);
        if (angle > maxAngle) {
          maxAngle = angle;
          furthest = destinationPoint(lon, lat, bearing, dKm);
        }
      }

      ring.push([furthest.lon, furthest.lat]);
    }

    ring.push(ring[0]); // close the ring

    res.json({
      type: "Feature",
      properties: { lon, lat, radiusKm, directions, steps, observerHeight, targetHeight, refraction },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// Shared by the GET and POST /visibility handlers below — everything from
// loading the elevation cache onward, once lon/lat/targets/options have been
// parsed out of whichever request format was used. Returns either
// { error: { status, message } } or { body } (the JSON to send as-is).
function computeVisibility(lon, lat, targets, opts) {
  const { observerHeight, targetHeight, refraction, stepsPerKm } = opts;

  let minLon = lon, maxLon = lon, minLat = lat, maxLat = lat;
  for (const t of targets) {
    minLon = Math.min(minLon, t.lon); maxLon = Math.max(maxLon, t.lon);
    minLat = Math.min(minLat, t.lat); maxLat = Math.max(maxLat, t.lat);
  }
  const marginDeg = 0.02;
  const cache = loadSRTMCache(minLon - marginDeg, minLat - marginDeg, maxLon + marginDeg, maxLat + marginDeg);
  if (cache.size === 0) return { error: { status: 404, message: "No elevation data available" } };

  const observerGroundElev = sampleCache(cache, lon, lat);
  if (isNaN(observerGroundElev)) return { error: { status: 404, message: "No elevation data at observer location" } };
  const observerElev = observerGroundElev + observerHeight;

  const results = targets.map(t => {
    const distanceKm = haversineDistanceKm(lon, lat, t.lon, t.lat);
    const bearing = initialBearing(lon, lat, t.lon, t.lat);
    const steps = Math.max(1, Math.min(2000, Math.round(distanceKm * stepsPerKm)));
    const stepKm = distanceKm / steps;

    // Everything strictly between the observer and this target — the
    // target itself is visible only if its own angle clears all of these.
    let maxAngle = -Infinity;
    for (let s = 1; s < steps; s++) {
      const angle = lineOfSightAngle(cache, lon, lat, observerElev, bearing, s * stepKm, targetHeight, refraction);
      if (angle > maxAngle) maxAngle = angle;
    }

    const targetRawElev = sampleCache(cache, t.lon, t.lat);
    const targetAltitude = t.altitude !== undefined ? t.altitude : elevationOrSeaLevel(cache, t.lon, t.lat) + targetHeight;
    const targetAngle = lineOfSightAngleAtElevation(observerElev, targetAltitude, distanceKm, refraction);

    return {
      lon: t.lon,
      lat: t.lat,
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      visible: targetAngle >= maxAngle,
      groundElevation: isNaN(targetRawElev) ? null : targetRawElev,
      altitude: targetAltitude,
    };
  });

  return { body: { lon, lat, observerHeight, targetHeight, refraction, results } };
}

function visibilityOptsFrom(source) {
  return {
    observerHeight: parseFloat(source.observerHeight) || 1.7,
    targetHeight: parseFloat(source.targetHeight) || 0,
    refraction: source.refraction !== "false" && source.refraction !== false && source.refraction !== "0",
    // Samples per km along each observer→target path — distinct from
    // /viewshed's `steps` (a fixed count along a fixed radius) since here
    // each target is a different distance away.
    stepsPerKm: Math.min(50, Math.max(1, parseFloat(source.stepsPerKm) || 10)),
  };
}

function sendVisibilityResult(res, result) {
  if (result.error) return res.status(result.error.status).send(result.error.message);
  res.json(result.body);
}

// GET, with targets packed into the query string — fine for a handful of
// points, but a few hundred will overflow the server's request-header size
// limit (HTTP 431). Use POST with a JSON body for large target lists.
app.get("/visibility", (req, res) => {
  try {
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    if (isNaN(lon) || isNaN(lat)) return res.status(400).send("Invalid lon/lat");
    if (!req.query.targets) return res.status(400).send("Missing targets — lon,lat[,altitude] groups separated by |, e.g. targets=-2.70,56.22|-2.75,56.20,500");

    // Altitude is optional per target: lon,lat is ground level (the terrain's
    // own elevation, plus the global targetHeight offset); lon,lat,alt pins
    // that target to an absolute altitude instead (e.g. a drone at a known
    // height), ignoring both the sampled terrain and targetHeight.
    const targets = req.query.targets.split("|").map(triple => {
      const [tLon, tLat, tAlt] = triple.split(",").map(Number);
      return { lon: tLon, lat: tLat, altitude: triple.split(",").length > 2 ? tAlt : undefined };
    });
    if (targets.length === 0 || targets.some(t => isNaN(t.lon) || isNaN(t.lat) || (t.altitude !== undefined && isNaN(t.altitude)))) {
      return res.status(400).send("Invalid target in list");
    }

    sendVisibilityResult(res, computeVisibility(lon, lat, targets, visibilityOptsFrom(req.query)));
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// POST, with targets as a JSON array — for large target lists (the GET form
// hits HTTP 431 well before a few hundred points).
app.post("/visibility", (req, res) => {
  try {
    const { lon, lat, targets: rawTargets } = req.body || {};
    if (typeof lon !== "number" || typeof lat !== "number" || isNaN(lon) || isNaN(lat)) {
      return res.status(400).send("Invalid lon/lat");
    }
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      return res.status(400).send("Missing targets — an array of [lon, lat] or [lon, lat, altitude]");
    }

    const targets = rawTargets.map(t => ({ lon: t[0], lat: t[1], altitude: t.length > 2 ? t[2] : undefined }));
    if (targets.some(t => isNaN(t.lon) || isNaN(t.lat) || (t.altitude !== undefined && isNaN(t.altitude)))) {
      return res.status(400).send("Invalid target in list");
    }

    sendVisibilityResult(res, computeVisibility(lon, lat, targets, visibilityOptsFrom(req.body)));
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// The sagitta (metres) — the height an arc rises above its chord — of the
// curved surface above the straight chord between two points, at distance
// `d` km from the first. Zero at both ends, maximum at the midpoint. A chord
// between two points on a sphere lies inside the sphere, so the true surface
// between them sits above it by this amount (the same "Earth gets in the
// way" effect used in line-of-sight/RF path calculations) — added to
// elevation, not subtracted.
//
// Exact, not the small-angle d1*d2/(2R) approximation: place both points and
// the sample point on a circle of radius R, and rotate so the chord is
// vertical (equidistant in x from centre) — the sample's perpendicular
// distance from that chord is then just the difference in its x-coordinate,
// R*cos(phi), from the chord's, R*cos(halfAngle), where phi is the sample's
// angle from the arc's midpoint. Reduces to d1*d2/(2R) for small halfAngle
// (Taylor-expand cos), but stays accurate at any distance, including a
// meaningful fraction of Earth's circumference where the small-angle version
// measurably drifts.
function chordSagittaM(d, totalKm) {
  const halfAngle = totalKm / (2 * EARTH_RADIUS_KM);
  const phi = d / EARTH_RADIUS_KM - halfAngle;
  return EARTH_RADIUS_KM * (Math.cos(phi) - Math.cos(halfAngle)) * 1000;
}

app.get("/line.svg", (req, res) => {
  try {
    const lon1 = parseFloat(req.query.lon1);
    const lat1 = parseFloat(req.query.lat1);
    const lon2 = parseFloat(req.query.lon2);
    const lat2 = parseFloat(req.query.lat2);
    if ([lon1, lat1, lon2, lat2].some(isNaN)) return res.status(400).send("Invalid lon1/lat1/lon2/lat2");

    const curved = req.query.curved !== "false" && req.query.curved !== "0";
    const width = Math.min(2000, Math.max(100, parseInt(req.query.width) || 800));
    const heightScale = Math.min(100000, Math.max(0.001, parseFloat(req.query.heightScale) || 1));
    // Samples per km, not a flat total, so resolution stays independent of
    // any one path's length — a 20km and a 2000km path both get sampled at
    // the same density, rather than a fixed total sample count getting
    // diluted over longer paths (the same reasoning as /visibility's
    // stepsPerKm, for the same reason: paths here are arbitrary lengths).
    const samplesPerKm = Math.min(50, Math.max(0.01, parseFloat(req.query.samplesPerKm) || 10));

    const totalKm = haversineDistanceKm(lon1, lat1, lon2, lat2);
    const bearing = initialBearing(lon1, lat1, lon2, lat2);
    const samples = Math.max(8, Math.min(2000, Math.round(totalKm * samplesPerKm) || 200));

    const marginDeg = 0.02;
    const cache = loadSRTMCache(
      Math.min(lon1, lon2) - marginDeg, Math.min(lat1, lat2) - marginDeg,
      Math.max(lon1, lon2) + marginDeg, Math.max(lat1, lat2) + marginDeg
    );

    // True to scale by default: one metres-per-pixel factor, derived from
    // width/distance, applies to the horizontal axis and (unscaled) to sea
    // level's curved position — the geometric fact of where the curve puts
    // sea level isn't something heightScale should be allowed to distort.
    // heightScale only stretches how tall real terrain relief is drawn above
    // that sea-level baseline, e.g. to make subtle hills visible without
    // exaggerating the curvature itself. Missing data (e.g. no .hgt tile
    // loaded for part of the path) falls back to sea level rather than
    // leaving a gap in the profile.
    const scale = width / (totalKm * 1000 || 1); // px per metre, horizontal
    const yScale = scale * heightScale; // px per metre, vertical — terrain relief only

    // y here means "higher is bigger" (the opposite of SVG's own coordinate
    // system, where higher is smaller) — flipped once below, after the full
    // range is known, so the artboard can be cropped tightly around the
    // resulting line instead of placed somewhere inside a fixed canvas.
    const rawPoints = new Array(samples);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < samples; i++) {
      const d = (i / (samples - 1)) * totalKm;
      const { lon, lat } = destinationPoint(lon1, lat1, bearing, d);
      const elev = elevationOrSeaLevel(cache, lon, lat);
      const seaLevelPx = curved ? chordSagittaM(d, totalKm) * scale : 0; // always true to scale
      const y = seaLevelPx + elev * yScale;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      rawPoints[i] = { x: d * 1000 * scale, y };
    }

    const strokeWidth = 1.5;
    const pad = strokeWidth / 2; // so the stroke itself isn't clipped at the crop edge
    const viewMinY = -maxY - pad;
    const viewHeight = (maxY - minY) + strokeWidth;

    const points = rawPoints.map(p => `${p.x.toFixed(1)},${(-p.y).toFixed(1)}`).join(" ");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${viewHeight.toFixed(1)}" viewBox="0 ${viewMinY.toFixed(1)} ${width} ${viewHeight.toFixed(1)}">` +
      `<polyline points="${points}" fill="none" stroke="#000" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;

    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.get("/skyline.svg", (req, res) => {
  try {
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    if (isNaN(lon) || isNaN(lat)) return res.status(400).send("Invalid lon/lat");

    // The circle can be given directly as a radius, or (echoing /line.svg's
    // lon2/lat2) as a second point that should sit on its edge — radius is
    // then just the distance from the centre out to that point.
    let radiusKm;
    if (req.query.radius !== undefined) {
      radiusKm = parseFloat(req.query.radius);
    } else if (req.query.lon2 !== undefined && req.query.lat2 !== undefined) {
      const lon2 = parseFloat(req.query.lon2);
      const lat2 = parseFloat(req.query.lat2);
      if (isNaN(lon2) || isNaN(lat2)) return res.status(400).send("Invalid lon2/lat2");
      radiusKm = haversineDistanceKm(lon, lat, lon2, lat2);
    } else {
      return res.status(400).send("Provide either radius or lon2/lat2");
    }
    if (isNaN(radiusKm)) return res.status(400).send("Invalid radius");
    radiusKm = Math.min(200, Math.max(0.5, radiusKm));

    const directions = Math.min(720, Math.max(8, parseInt(req.query.directions) || 360));
    const steps = Math.min(2000, Math.max(8, parseInt(req.query.steps) || 256));
    const observerHeight = parseFloat(req.query.observerHeight) || 1.7;
    const targetHeight = parseFloat(req.query.targetHeight) || 0;
    const refraction = req.query.refraction !== "false" && req.query.refraction !== "0";
    const width = Math.min(2000, Math.max(100, parseInt(req.query.width) || 800));
    const heightScale = Math.min(100000, Math.max(0.001, parseFloat(req.query.heightScale) || 1));

    const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);
    const cache = loadSRTMCache(lon - lonOffset, lat - latOffset, lon + lonOffset, lat + latOffset);
    if (cache.size === 0) return res.status(404).send("No elevation data available");

    const observerGroundElev = sampleCache(cache, lon, lat);
    if (isNaN(observerGroundElev)) return res.status(404).send("No elevation data at observer location");
    const observerElev = observerGroundElev + observerHeight;

    // The x-axis here is bearing, not distance, so there's no natural
    // horizontal metres-per-pixel to inherit a vertical scale from the way
    // /line.svg does. Instead the vertical scale ties to the px-per-metre a
    // /line.svg path of length `radius` would use, purely so heightScale=1
    // still means "true to life proportions" here too.
    const scale = width / (radiusKm * 1000);
    const yScale = scale * heightScale;
    const stepKm = radiusKm / steps;

    // i === directions repeats bearing 0 — the same value as i === 0, drawn
    // at the opposite edge of the strip, so the line joins seamlessly if
    // tiled side by side or wrapped into a loop.
    const rawPoints = new Array(directions + 1);
    let minY = Infinity, maxY = -Infinity;

    for (let i = 0; i <= directions; i++) {
      const bearing = (i % directions) * (360 / directions);

      // Same outward march as /viewshed: track the point with the
      // steepest line-of-sight angle seen so far along this bearing, so a
      // closer hill correctly hides whatever is behind it. heightM is that
      // angle's numerator — the apparent height above eye level, curvature
      // and refraction already folded in — rather than the raw elevation,
      // so the plotted skyline is what's actually visible.
      let maxAngle = -Infinity;
      let heightM = 0;
      for (let s = 1; s <= steps; s++) {
        const dKm = s * stepKm;
        const { lon: tLon, lat: tLat } = destinationPoint(lon, lat, bearing, dKm);
        const elev = elevationOrSeaLevel(cache, tLon, tLat) + targetHeight;
        const h = elev - observerElev - curvatureDropM(dKm, refraction);
        const angle = Math.atan2(h, dKm * 1000);
        if (angle > maxAngle) {
          maxAngle = angle;
          heightM = h;
        }
      }

      const y = heightM * yScale;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      rawPoints[i] = { x: (i / directions) * width, y };
    }

    const strokeWidth = 1.5;
    const pad = strokeWidth / 2;
    const viewMinY = -maxY - pad;
    const viewHeight = (maxY - minY) + strokeWidth;

    const points = rawPoints.map(p => `${p.x.toFixed(1)},${(-p.y).toFixed(1)}`).join(" ");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${viewHeight.toFixed(1)}" viewBox="0 ${viewMinY.toFixed(1)} ${width} ${viewHeight.toFixed(1)}">` +
      `<polyline points="${points}" fill="none" stroke="#000" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;

    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
