// Isometric skyline viewer — fetches /skyline.svg, recovers the real
// bearing/height samples from its rendered polyline (the endpoint only
// returns SVG, not raw JSON, so this is the same "decode the server's own
// rendered output" approach sketch.js already uses for elevation tiles),
// then re-projects them as one or more concentric rings in isometric view
// instead of an unrolled strip. No p5.js dependency, despite living
// alongside the sketches that do.

const LON_DEFAULT = -1.6;
const LAT_DEFAULT = 55.0;
const RADII_KM_DEFAULT = [15];
const DIRECTIONS_DEFAULT = 360;

// Ground-plane render constants
const MAX_RING_R = 230;               // screen radius of the *largest* requested ring, SVG
                                       // user units - smaller radii scale down proportionally
                                       // (see ringRadiusPx()), so multiple radii nest correctly
const KX = Math.cos(Math.PI / 6);     // true isometric ground-line angle (30deg)
const KY = Math.sin(Math.PI / 6);
const PX_PER_M = 0.5;                 // vertical legibility scale — no real horizontal
                                       // distance axis here to tie a "true scale" to
const RING_SAMPLES = 144;
const PAD = 24;
const LABEL_OFFSET = 12;              // how far below each ring's own north (bearing-0) point
                                       // its "Nkm" label sits, SVG user units
const CENTRE_R = 6;                   // ground-plane radius of the filled centre marker (the
                                       // observer's own position) - same units as MAX_RING_R

// Isometric projection rotates a true ground-plane circle into a screen
// ellipse. Bearing 0 (north) only lands at the ellipse's screen-top vertex
// if the ground angle is offset by -45deg first — see the derivation notes
// in the main README's Skyline profile section.
function groundPoint(bearingDeg, ringR) {
  const t = ((bearingDeg - 45) * Math.PI) / 180;
  return { dx: ringR * Math.sin(t), dy: -ringR * Math.cos(t) };
}

function isoProject(dx, dy, z) {
  return { x: (dx - dy) * KX, y: (dx + dy) * KY - z };
}

function parseSkylineSVG(svgText, radiusKm) {
  const widthMatch = svgText.match(/<svg[^>]*\swidth="([\d.]+)"/);
  const pointsMatch = svgText.match(/points="([^"]+)"/);
  if (!widthMatch || !pointsMatch) throw new Error("Couldn't parse /skyline.svg response");

  const width = parseFloat(widthMatch[1]);
  const scale = width / (radiusKm * 1000); // px per metre, matches the server's own formula
  const pts = pointsMatch[1].trim().split(" ").map(p => {
    const [x, y] = p.split(",").map(Number);
    return { x, y };
  });

  const n = pts.length - 1; // drop the duplicated closing point (bearing 360 === bearing 0)
  const data = new Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = { bearing: (i / n) * 360, heightM: -pts[i].y / scale };
  }
  return data;
}

// ringRadiusPx() maps a real radius in km to a screen radius, linearly, so several radii drawn
// together nest as true-to-scale concentric rings rather than all landing on the same circle -
// the largest of the requested radii always renders at MAX_RING_R, exactly matching the old
// single-radius behaviour when there's only one.
function ringRadiusPx(radiusKm, maxRadiusKm) {
  return MAX_RING_R * (radiusKm / maxRadiusKm);
}

// rings: [{ radiusKm, data }, ...], ascending by radiusKm. Each gets its own ring + skyline
// polyline at a proportionally-scaled screen radius (see ringRadiusPx above) and a small label
// directly under its own line at bearing 0 (12 o'clock); only the outermost ring gets compass
// letters and a "start" (bearing-0) marker, since those would otherwise repeat at every radius.
// Every ring/skyline is drawn identically (plain black, via the shared .ring/.skyline classes,
// no per-ring styling) - radius alone (plus the label) is what tells them apart.
function buildIsometricSVG(rings) {
  const maxRadiusKm = Math.max(...rings.map(r => r.radiusKm));
  const outerRadiusKm = rings[rings.length - 1].radiusKm;
  const outerRingR = ringRadiusPx(outerRadiusKm, maxRadiusKm);

  // One pass building every point in original (unshifted) coordinates - the bounding box (and
  // so the translation every point needs) isn't known until all of them exist, so formatting
  // to a "points" string happens in a second, purely-textual pass below, not here.
  const built = rings.map(({ radiusKm, data }) => {
    const ringR = ringRadiusPx(radiusKm, maxRadiusKm);

    const linePts = data.map(({ bearing, heightM }) => {
      const { dx, dy } = groundPoint(bearing, ringR);
      return isoProject(dx, dy, heightM * PX_PER_M);
    });
    linePts.push(linePts[0]); // close the loop exactly

    const ringPts = [];
    for (let s = 0; s <= RING_SAMPLES; s++) {
      const { dx, dy } = groundPoint((s / RING_SAMPLES) * 360, ringR);
      ringPts.push(isoProject(dx, dy, 0));
    }

    // linePts[0] is the line's own bearing-0 (north) point - the label sits just below that
    // exact spot, so it always reads as "this ring's distance", not a generic outward tick.
    const northLinePt = linePts[0];
    const labelPt = { x: northLinePt.x, y: northLinePt.y + LABEL_OFFSET };

    return { radiusKm, linePts, ringPts, labelPt };
  });

  const compass = [["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([label, bearing]) => {
    const { dx, dy } = groundPoint(bearing, outerRingR);
    return { label, ...isoProject(dx * 1.12, dy * 1.12, 0) };
  });

  const outerData = rings[rings.length - 1].data;
  const { dx: sdx, dy: sdy } = groundPoint(0, outerRingR);
  const start = isoProject(sdx, sdy, outerData[0].heightM * PX_PER_M);

  // The observer's own position, ground level, dead centre - built the same way as the rings
  // themselves (groundPoint sampled around a circle, then isoProject), just at a small fixed
  // radius, so it comes out as the same isometric ellipse shape/orientation as every ring,
  // rather than a screen-space circle that would look tilted relative to everything else here.
  const centrePts = [];
  for (let s = 0; s <= RING_SAMPLES; s++) {
    const { dx, dy } = groundPoint((s / RING_SAMPLES) * 360, CENTRE_R);
    centrePts.push(isoProject(dx, dy, 0));
  }

  const all = built.flatMap(b => [...b.linePts, ...b.ringPts, b.labelPt]).concat(compass, [start], centrePts);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of all) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  minX -= PAD; maxX += PAD; minY -= PAD; maxY += PAD;
  const vbW = maxX - minX, vbH = maxY - minY;
  const fmt = p => `${(p.x - minX).toFixed(1)},${(p.y - minY).toFixed(1)}`;

  const ringEls = built.map(b =>
    `<polyline class="ring" points="${b.ringPts.map(fmt).join(" ")}" />`
  ).join("");

  const skylineEls = built.map(b =>
    `<polyline class="skyline" points="${b.linePts.map(fmt).join(" ")}" />`
  ).join("");

  const labelEls = built.map(b =>
    `<text class="radius-label" x="${(b.labelPt.x - minX).toFixed(1)}" y="${(b.labelPt.y - minY).toFixed(1)}">${b.radiusKm}km</text>`
  ).join("");

  const compassEls = compass.map(c =>
    `<text class="compass" x="${(c.x - minX).toFixed(1)}" y="${(c.y - minY).toFixed(1)}">${c.label}</text>`
  ).join("");

  const centreEl = `<polygon class="centre" points="${centrePts.map(fmt).join(" ")}" />`;

  return `<svg viewBox="0 0 ${vbW.toFixed(1)} ${vbH.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">` +
    ringEls +
    skylineEls +
    compassEls +
    labelEls +
    centreEl +
    `<circle class="start" cx="${(start.x - minX).toFixed(1)}" cy="${(start.y - minY).toFixed(1)}" r="3.5" />` +
    `</svg>`;
}

async function fetchSkylineRing(lon, lat, radiusKm, directions) {
  const url = `/skyline.svg?lon=${lon}&lat=${lat}&radius=${radiusKm}&directions=${directions}&heightScale=1&width=800`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Server returned ${res.status} for radius=${radiusKm}`);
  return { radiusKm, data: parseSkylineSVG(await res.text(), radiusKm) };
}

async function loadSkyline(lon, lat, radiiKm, directions) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "loading…";

  try {
    const sorted = [...radiiKm].sort((a, b) => a - b);
    const rings = await Promise.all(sorted.map(r => fetchSkylineRing(lon, lat, r, directions)));
    document.getElementById("stage").innerHTML = buildIsometricSVG(rings);

    document.getElementById("centre-info").textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
    document.getElementById("radius-info").textContent = sorted.map(r => `${r}km`).join(", ");
    document.getElementById("bearings-info").textContent = `${directions} bearings`;
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

function parseRadii(text) {
  return text.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0);
}

function goToLocation(event) {
  event.preventDefault();
  const lon = parseFloat(document.getElementById("lon-input").value);
  const lat = parseFloat(document.getElementById("lat-input").value);
  const radiiKm = parseRadii(document.getElementById("radius-input").value);
  const directions = parseInt(document.getElementById("directions-input").value);
  if ([lon, lat, directions].some(isNaN) || radiiKm.length === 0) return;
  loadSkyline(lon, lat, radiiKm, directions);
}

(function init() {
  const params = new URLSearchParams(window.location.search);
  const lon = parseFloat(params.get("lon")) || LON_DEFAULT;
  const lat = parseFloat(params.get("lat")) || LAT_DEFAULT;
  const radiiParam = params.get("radii") || params.get("radius");
  const radiiKm = radiiParam ? parseRadii(radiiParam) : RADII_KM_DEFAULT;
  const directions = parseInt(params.get("directions")) || DIRECTIONS_DEFAULT;

  document.getElementById("lon-input").value = lon;
  document.getElementById("lat-input").value = lat;
  document.getElementById("radius-input").value = radiiKm.join(", ");
  document.getElementById("directions-input").value = directions;

  loadSkyline(lon, lat, radiiKm, directions);
})();
