// placement.js — where trees and buildings may go, a live green/red preview, and the "Green area" tool.
// Rules are checked against real map geometry (roads, rails, water, parks from the base map's vector tiles,
// our building footprints, the cadastre trees and the objects placed so far), in metres, so they behave the
// same at any zoom or tilt. index.html only exposes window.__app and asks window.placement.allow().
//
// Green area: hover a space (square, lawn, playground, or the city block between the surrounding roads) and
// click to turn it green; hold Shift (or press "Draw shape") to draw corners by hand instead. Before anything
// changes you see ghost trees, the buildings that would be demolished in red, and the numbers.
import * as THREE from 'three';

const MLAT = 111320;                       // metres per degree latitude
const TREE_GAP = 4;                        // m between new trees
const CADASTRE_GAP = 3;                    // m to an existing (cadastre) tree
const BUILDING = { w: 14, d: 10 };         // footprint of a placed building (matches makeBuilding in index.html)
const AREA_SPACING = 9;                    // m between trees in a green area
const AREA_MAX_TREES = 600;
const AREA_MAX_M2 = 30000;                 // largest space the wand selects
// Half width in metres of what counts as "the road" (carriageway). Footways, paths, cycleways, tracks and
// parking aisles are not listed, so trees and green areas may go there.
const ROAD_HALF = { motorway: 12, trunk: 10, primary: 8, secondary: 7, tertiary: 6, minor: 4, service: 3, busway: 4 };
const RAIL_HALF = { rail: 3, transit: 2.5 };
const WATERWAY_HALF = 3;
const GREEN_LANDCOVER = new Set(['wood', 'grass']);
const SPACE_LANDUSE = new Set(['pitch', 'playground', 'garages', 'bus_station']); // open spaces the wand may pick
const STORE_KEY = 'heilbronn3d-green-areas';
const CELL = 40;                           // m, spatial grid for the map geometry
const FLOOD = { cell: 3, half: 150 };      // m, raster used to find the block around the cursor

let app, map, origin, mLng;
const toM = ([lng, lat]) => [(lng - origin[0]) * mLng, (lat - origin[1]) * MLAT];
const toLL = ([x, y]) => [origin[0] + x / mLng, origin[1] + y / MLAT];
const distM = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------- small geometry helpers (metres) ----------
function pointInRing(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (pt, poly) => pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h));
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
const segSegDist = (a, b, c, d) => (segsCross(a, b, c, d) ? 0
  : Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b)));
function areaM2(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(s / 2);
}
const centroid = (ring) => [ring.slice(0, -1).reduce((s, p) => s + p[0], 0) / (ring.length - 1),
  ring.slice(0, -1).reduce((s, p) => s + p[1], 0) / (ring.length - 1)];
// Douglas-Peucker on an open polyline
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > max) { max = d; idx = i; } }
  if (max <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

// ---------- spatial grid over the map geometry ----------
class Grid {
  constructor() { this.cells = new Map(); this.items = []; }
  add(item, [x0, y0, x1, y1]) {
    const id = this.items.push(item) - 1;
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        const k = `${i},${j}`;
        if (!this.cells.has(k)) this.cells.set(k, []);
        this.cells.get(k).push(id);
      }
  }
  near([x0, y0, x1, y1]) {
    const ids = new Set();
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
      for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++)
        for (const id of this.cells.get(`${i},${j}`) || []) ids.add(id);
    return [...ids].map((id) => this.items[id]);
  }
}
const bboxOf = (pts, pad = 0) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
};

let geo = { lines: new Grid(), areas: new Grid(), names: new Grid(), houses: new Grid(), trees: new Grid() };
let geoDirty = true;
const lineList = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);
const polyList = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

function rebuildGeo() {
  if (!map.getSource('openmaptiles') || map.getZoom() < 13) return;
  const g = { lines: new Grid(), areas: new Grid(), names: new Grid(), houses: new Grid(), trees: geo.trees };
  const src = (sourceLayer) => map.querySourceFeatures('openmaptiles', { sourceLayer });
  const addLine = (coords, half, kind) => {
    const m = coords.map(toM);
    for (let i = 0; i < m.length - 1; i++) g.lines.add({ a: m[i], b: m[i + 1], half, kind }, bboxOf([m[i], m[i + 1]], half));
  };
  const addArea = (f, kind, name) => {
    for (const poly of polyList(f.geometry)) {
      const m = poly.map((r) => r.map(toM));
      g.areas.add({ poly: m, kind, name, m2: areaM2(m[0]) }, bboxOf(m[0]));
    }
  };
  for (const f of src('transportation')) {
    const p = f.properties;
    if (p.brunnel === 'tunnel') continue;                       // underground
    if (f.geometry.type.includes('Polygon')) {                  // pedestrian squares are drawn as areas
      if (p.class === 'path' || p.subclass === 'pedestrian') addArea(f, 'square', 'square');
      continue;
    }
    if (p.class === 'service' && p.service === 'parking_aisle') continue;
    const half = ROAD_HALF[p.class] ?? RAIL_HALF[p.class];
    if (!half) continue;
    for (const line of lineList(f.geometry)) addLine(line, half, RAIL_HALF[p.class] ? 'railway' : 'road');
  }
  for (const f of src('transportation_name')) {
    if (!f.properties.name) continue;
    for (const line of lineList(f.geometry)) {
      const m = line.map(toM);
      for (let i = 0; i < m.length - 1; i++) g.names.add({ a: m[i], b: m[i + 1], name: f.properties.name }, bboxOf([m[i], m[i + 1]], 10));
    }
  }
  for (const f of src('waterway')) for (const line of lineList(f.geometry)) addLine(line, WATERWAY_HALF, 'water');
  for (const f of src('water')) addArea(f, 'water');
  for (const f of src('park')) addArea(f, 'park', f.properties.name || 'park');
  for (const f of src('landcover')) if (GREEN_LANDCOVER.has(f.properties.class)) addArea(f, f.properties.class === 'wood' ? 'forest' : 'park', f.properties.class);
  for (const f of src('landuse')) if (SPACE_LANDUSE.has(f.properties.class)) addArea(f, 'space', f.properties.class.replace('_', ' '));
  for (const b of app.buildings.values()) {
    const m = b.poly.map((r) => r.map(toM));
    g.houses.add({ b, poly: m }, bboxOf(m[0]));
  }
  geo = g;
  geoDirty = false;
}
function ensureGeo() { if (geoDirty) rebuildGeo(); }

const streetName = (p) => {
  let best = null, bd = 25;
  for (const n of geo.names.near(bboxOf([p], 25))) { const d = segDist(p, n.a, n.b); if (d < bd) { bd = d; best = n.name; } }
  return best;
};
const lineReason = (l, p, verb) => {
  if (l.kind === 'railway') return `${verb} a railway`;
  if (l.kind === 'water') return verb === 'on' ? 'in water' : `${verb} water`;
  return `${verb} ${streetName(p) || 'a road'}`;
};
// a line feature (road/rail/waterway) within its half width (+pad) of point p
function lineAt(p, pad = 0) {
  for (const l of geo.lines.near(bboxOf([p], pad))) if (segDist(p, l.a, l.b) < l.half + pad) return l;
  return null;
}
function areaAt(p, kind) {
  return geo.areas.near(bboxOf([p])).find((a) => a.kind === kind && inPoly(p, a.poly)) || null;
}
function houseAt(p) {
  return geo.houses.near(bboxOf([p])).find((h) => !app.isDeleted(h.b) && inPoly(p, h.poly)) || null;
}
const placedNear = (p, type, m) => app.placed.some((o) => o.type === type && distM(p, toM([o.lng, o.lat])) < m);
const cadastreNear = (p, m) => geo.trees.near(bboxOf([p], m)).some((t) => distM(p, t) < m);

// ---------- rules for single objects ----------
// Returns null if allowed, otherwise a short reason. pt is [lng, lat].
function check(type, pt) {
  ensureGeo();
  const p = toM(pt);
  if (type === 'tree') {
    if (areaAt(p, 'water')) return 'in water';
    const l = lineAt(p);
    if (l) return lineReason(l, p, 'on');
    if (houseAt(p)) return 'inside a building';
    if (placedNear(p, 'building', 9)) return 'inside a new building';
    if (placedNear(p, 'tree', TREE_GAP)) return 'too close to another tree';
    if (cadastreNear(p, CADASTRE_GAP)) return 'there is already a tree';
    return null;
  }
  if (type === 'building') {
    const hw = BUILDING.w / 2, hd = BUILDING.d / 2;
    const pts = [[0, 0], [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, -hd], [0, hd], [-hw, 0], [hw, 0]]
      .map(([dx, dy]) => [p[0] + dx, p[1] + dy]);
    for (const q of pts) {
      if (areaAt(q, 'water')) return 'in water';
      const l = lineAt(q, 1);
      if (l) return lineReason(l, q, 'on');
      if (houseAt(q)) return 'overlaps a building';
      if (areaAt(q, 'park') || areaAt(q, 'forest')) return 'in a park or forest';
    }
    if (placedNear(p, 'building', Math.hypot(BUILDING.w, BUILDING.d) + 2)) return 'too close to a new building';
    if (placedNear(p, 'tree', 9)) return 'on a new tree';
    return null;
  }
  return null;
}

// ---------- rules for a green area (ring in metres, closed) ----------
// Not allowed if any edge or the inside touches a car road, a railway or water. Returns a reason or null.
function checkArea(ring) {
  const bb = bboxOf(ring, 15);
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    for (const l of geo.lines.near(bboxOf([a, b], 15)))
      if (segSegDist(a, b, l.a, l.b) < l.half) return lineReason(l, l.a, 'crosses');
  }
  const poly = [ring];
  for (const l of geo.lines.near(bb)) if (inPoly(l.a, poly) || inPoly(l.b, poly)) return lineReason(l, l.a, 'contains');
  for (const w of geo.areas.near(bb)) {
    if (w.kind !== 'water') continue;
    if (ring.some((p) => inPoly(p, w.poly)) || w.poly[0].some((p) => inPoly(p, poly))) return 'touches water';
    for (let i = 0; i < ring.length - 1; i++)
      for (let j = 0; j < w.poly[0].length - 1; j++)
        if (segsCross(ring[i], ring[i + 1], w.poly[0][j], w.poly[0][j + 1])) return 'touches water';
  }
  if (areaM2(ring) > AREA_MAX_M2) return `is too big (max ${AREA_MAX_M2.toLocaleString('en')} m²)`;
  return null;
}

// ---------- the space under the cursor ("magic wand") ----------
// 1) the smallest square / lawn / playground polygon under the cursor, else
// 2) the city block: everything reachable from the cursor without crossing a road, rail or water.
function spaceAt(p) {
  if (areaAt(p, 'water')) return { reason: 'water' };
  const l = lineAt(p);
  if (l) return { reason: lineReason(l, p, 'on') };
  const polys = geo.areas.near(bboxOf([p]))
    .filter((a) => ['square', 'park', 'space'].includes(a.kind) && a.m2 <= AREA_MAX_M2 && inPoly(p, a.poly))
    .sort((a, b) => a.m2 - b.m2);
  for (const a of polys) {
    const ring = a.poly[0];
    if (!checkArea(ring)) return { ring, label: a.kind === 'square' ? 'square' : a.name || a.kind };
  }
  return blockAt(p);
}
function blockAt(p) {
  const { cell, half } = FLOOD;
  const n = Math.round((2 * half) / cell);
  const x0 = p[0] - half, y0 = p[1] - half;
  const free = new Int8Array(n * n).fill(-1);        // -1 unknown, 0 blocked, 1 free
  const isFree = (i, j) => {
    const k = j * n + i;
    if (free[k] < 0) {
      const q = [x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell];
      free[k] = lineAt(q) || areaAt(q, 'water') ? 0 : 1;
    }
    return free[k] === 1;
  };
  const si = Math.floor(n / 2), sj = Math.floor(n / 2);
  const inside = new Uint8Array(n * n);
  const queue = [si + sj * n];
  inside[queue[0]] = 1;
  let count = 0, open = false;
  while (queue.length) {
    const k = queue.pop();
    count++;
    if (count * cell * cell > AREA_MAX_M2) return { reason: `the space is too big (max ${AREA_MAX_M2.toLocaleString('en')} m²)` };
    const i = k % n, j = (k - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= n || b >= n) { open = true; continue; }
      const kk = b * n + a;
      if (!inside[kk] && isFree(a, b)) { inside[kk] = 1; queue.push(kk); }
    }
  }
  if (open) return { reason: 'the space is too big or not enclosed by roads' };
  // outline of the cells: chain the cell edges that border the outside into a ring
  const next = new Map();
  const key = (i, j) => `${i},${j}`;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (!inside[j * n + i]) continue;
    const out = (a, b) => a < 0 || b < 0 || a >= n || b >= n || !inside[b * n + a];
    if (out(i, j - 1)) next.set(key(i, j), [i + 1, j]);         // bottom edge, left to right
    if (out(i + 1, j)) next.set(key(i + 1, j), [i + 1, j + 1]); // right edge, upwards
    if (out(i, j + 1)) next.set(key(i + 1, j + 1), [i, j + 1]); // top edge, right to left
    if (out(i - 1, j)) next.set(key(i, j + 1), [i, j]);         // left edge, downwards
  }
  let start = null;
  for (const k of next.keys()) { const [i, j] = k.split(',').map(Number); if (!start || j < start[1] || (j === start[1] && i < start[0])) start = [i, j]; }
  const loop = [start];
  let cur = next.get(key(...start)), guard = 0;
  while (cur && (cur[0] !== start[0] || cur[1] !== start[1]) && guard++ < 20000) { loop.push(cur); cur = next.get(key(...cur)); }
  const pts = loop.map(([i, j]) => [x0 + i * cell, y0 + j * cell]);
  const ring = simplify([...pts, pts[0]], cell * 0.8);
  if (ring.length < 4) return { reason: 'the space is too small' };
  return { ring, label: 'block' };
}

// ---------- what a green area would do ----------
// footprint point of a building (vertex average, or a point between it and a corner)
function footprintPoint(poly) {
  const r = poly[0], n = r.length - 1;
  const c = [r.slice(0, n).reduce((s, p) => s + p[0], 0) / n, r.slice(0, n).reduce((s, p) => s + p[1], 0) / n];
  if (inPoly(c, poly)) return c;
  return r.slice(0, n).map((v) => [(v[0] + c[0]) / 2, (v[1] + c[1]) / 2]).find((q) => inPoly(q, poly)) || r[0];
}
// demolish = false keeps the buildings and only plants on free ground
function areaPlan(ring, demolish = true) {
  const poly = [ring];
  const houses = demolish ? geo.houses.near(bboxOf(ring)).filter((h) => !app.isDeleted(h.b) && inPoly(footprintPoint(h.poly), poly)) : [];
  const objs = app.placed.filter((o) => inPoly(toM([o.lng, o.lat]), poly) && (demolish || o.type === 'tree'));
  const gone = new Set(houses.map((h) => h.poly));
  const spots = [];
  const [x0, y0, x1, y1] = bboxOf(ring);
  let seed = 1; // the same space always gets the same trees, so the preview matches the result
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let y = y0 + AREA_SPACING / 2; y < y1 && spots.length < AREA_MAX_TREES; y += AREA_SPACING) {
    for (let x = x0 + AREA_SPACING / 2; x < x1 && spots.length < AREA_MAX_TREES; x += AREA_SPACING) {
      const p = [x + rnd() * AREA_SPACING * 0.4, y + rnd() * AREA_SPACING * 0.4];
      if (!inPoly(p, poly) || lineAt(p, 1) || areaAt(p, 'water') || cadastreNear(p, CADASTRE_GAP)) continue;
      const h = houseAt(p);
      if (h && !gone.has(h.poly)) continue; // a building that stays
      if (!demolish && app.placed.some((o) => o.type === 'building' && distM(p, toM([o.lng, o.lat])) < 9)) continue;
      spots.push(p);
    }
  }
  return { houses, objs: demolish ? objs : [], spots, m2: areaM2(ring), demolish };
}

// ---------- preview: ghost trees and buildings to demolish ----------
const EMPTY = { type: 'FeatureCollection', features: [] };
let ghosts;  // THREE.InstancedMesh of see-through trees
function setupGhosts() {
  const geom = new THREE.ConeGeometry(3, 9, 7).translate(0, 5.5, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0x43a047, transparent: true, opacity: 0.45, depthWrite: false });
  ghosts = new THREE.InstancedMesh(geom, mat, AREA_MAX_TREES);
  ghosts.count = 0;
  ghosts.frustumCulled = false;
  app.scene.add(ghosts);
}
let previewKey = null;
function showPreview(plan, key) {
  if (key && key === previewKey) return;
  previewKey = key;
  const m = new THREE.Matrix4();
  plan.spots.forEach((p, i) => {
    const [lng, lat] = toLL(p);
    const v = app.toScene(lng, lat, app.groundAt(lng, lat));
    ghosts.setMatrixAt(i, m.makeTranslation(v.x, v.y, v.z));
  });
  ghosts.count = plan.spots.length;
  ghosts.instanceMatrix.needsUpdate = true;
  map.getSource('demolish-preview').setData({ type: 'FeatureCollection', features: plan.houses.map((h) => h.b.feature) });
  map.triggerRepaint();
}
function clearPreview() {
  if (!ghosts) return;
  previewKey = null;
  ghosts.count = 0;
  map.getSource('demolish-preview')?.setData(EMPTY);
  map.triggerRepaint();
}
const planText = (plan) => {
  const parts = [`${Math.round(plan.m2).toLocaleString('en')} m²`, `${plan.spots.length} trees`];
  if (plan.houses.length) parts.push(`${plan.houses.length} building${plan.houses.length > 1 ? 's' : ''} demolished`);
  return parts.join(' · ');
};

// ---------- UI helpers ----------
let tip, info, btn;
function setTip(text, ok, point) {
  if (!text) { tip.style.display = 'none'; return; }
  tip.style.display = 'block';
  tip.className = ok ? 'ok' : 'no';
  tip.textContent = text;
  // next to the cursor, above it (the climate layer's tooltip sits below), flipped left near the right edge
  const right = point.x + 14 + tip.offsetWidth > window.innerWidth - 8;
  tip.style.left = `${right ? point.x - 14 - tip.offsetWidth : point.x + 14}px`;
  tip.style.top = `${point.y - 34}px`;
}
function ghostRing(type, p) {
  if (type === 'tree') return Array.from({ length: 21 }, (_, i) => [p[0] + 3 * Math.cos((i / 20) * 2 * Math.PI), p[1] + 3 * Math.sin((i / 20) * 2 * Math.PI)]);
  const hw = BUILDING.w / 2, hd = BUILDING.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]].map(([dx, dy]) => [p[0] + dx, p[1] + dy]);
}
function showGhost(type, pt, reason, point) {
  map.getSource('placement-ghost').setData({ type: 'Feature', properties: { ok: !reason },
    geometry: { type: 'Polygon', coordinates: [ghostRing(type, toM(pt)).map(toLL)] } });
  setTip(reason ? `✗ Not here: ${reason}` : type === 'tree' ? '✓ Plant tree here' : '✓ Build here', !reason, point);
}
function hideGhost() { map.getSource('placement-ghost')?.setData(EMPTY); setTip(null); }
const activeTool = () => document.querySelector('#ui button.active')?.id;
const placeType = () => ({ btnTree: 'tree', btnBuilding: 'building' })[activeTool()];
function say(html) { info.innerHTML = html; info.style.display = html ? 'block' : 'none'; }

// ---------- green area tool ----------
let tool = null;      // null | 'wand' | 'draw'
let drawing = [];     // corners in metres (draw mode)
let cursorM = null;   // mouse position in metres
let hover = null;     // wand: { ring, label, plan } or { reason }
let pending = null;   // { ring, label } waiting for OK
let areas = [];       // [{ ring (lng/lat), m2, demolished: [[lng,lat]], removed: [{type,lng,lat}], trees: [[lng,lat]] }]

const HELP = {
  wand: '<b>Green area</b>: hover a square, lawn or block and click to turn it green. Hold <b>Shift</b> to draw corners yourself. ' +
    '<button id="pl-mode">✏️ Draw shape</button>',
  draw: '<b>Green area</b> (draw): click the corners, then click the first corner or press Enter. Backspace removes a corner, Esc cancels. ' +
    '<button id="pl-mode">🪄 Pick a space</button>'
};
function setMode(mode) {
  tool = mode;
  drawing = [];
  hover = null;
  clearPreview();
  say(HELP[mode]);
  document.getElementById('pl-mode').onclick = () => setMode(tool === 'wand' ? 'draw' : 'wand');
  drawState();
}
function draftRing() {
  const pts = cursorM ? [...drawing, cursorM] : drawing;
  return pts.length >= 3 ? [...pts, pts[0]] : null;
}
// redraws the finished areas and the current outline; returns the reason the outline is not allowed (or null)
function drawState() {
  const features = areas.map((a) => ({ type: 'Feature', properties: { state: 'done' }, geometry: { type: 'Polygon', coordinates: [a.ring] } }));
  let bad = null, ring = null;
  if (pending) ring = pending.ring;
  else if (tool === 'wand' && hover?.ring) ring = hover.ring;
  else if (tool === 'draw') ring = draftRing();
  if (tool === 'draw' && !pending) {
    const pts = cursorM ? [...drawing, cursorM] : drawing;
    if (ring) bad = checkArea(ring);
    else if (pts.length === 2) bad = checkArea([pts[0], pts[1], pts[0]]);
    if (!ring && pts.length >= 2) features.push({ type: 'Feature', properties: { state: bad ? 'bad' : 'ok' }, geometry: { type: 'LineString', coordinates: pts.map(toLL) } });
    for (const p of drawing) features.push({ type: 'Feature', properties: { state: bad ? 'bad' : 'ok' }, geometry: { type: 'Point', coordinates: toLL(p) } });
  }
  if (ring) features.push({ type: 'Feature', properties: { state: pending ? 'pending' : bad ? 'bad' : 'ok' }, geometry: { type: 'Polygon', coordinates: [ring.map(toLL)] } });
  map.getSource('green-areas').setData({ type: 'FeatureCollection', features });
  return bad;
}
function startTool() {
  if (document.getElementById('btnTree')?.disabled) return; // e.g. "Original" view of the scenario comparison
  document.getElementById('btnNav').click();              // index.html stops placing single objects
  document.querySelectorAll('#ui button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  ensureGeo();
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  setMode('wand');
}
function stopTool() {
  tool = null;
  drawing = [];
  cursorM = null;
  hover = null;
  pending = null;
  clearPreview();
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = '';
  btn.classList.remove('active');
  setTip(null);
  // always leave a normal tool active (the scenario comparison restores "the previous tool")
  if (!document.querySelector('#ui button.active')) document.getElementById('btnNav').click();
  drawState();
}
// ask before changing anything; offers keeping the buildings when there are any
function propose(ring, label) {
  const plan = areaPlan(ring, true);
  if (!plan.spots.length && !plan.houses.length) { say('<b>Green area</b>: no free ground there.'); return; }
  pending = { ring, label };
  setTip(null);
  showPreview(plan, null);
  drawState();
  const what = `<b>Green area</b> (${label}, ${Math.round(plan.m2).toLocaleString('en')} m²): `;
  if (plan.houses.length) {
    const keep = areaPlan(ring, false);
    say(`${what}demolish ${plan.houses.length} building${plan.houses.length > 1 ? 's' : ''} and plant ${plan.spots.length} trees? ` +
      '<button id="pl-ok">Demolish & plant</button>' +
      `<button id="pl-keep">Keep buildings (${keep.spots.length} trees)</button><button id="pl-cancel">Cancel</button>`);
    document.getElementById('pl-keep').onclick = () => applyArea(keep);
    document.getElementById('pl-keep').onmouseenter = () => showPreview(keep, null);
    document.getElementById('pl-ok').onmouseenter = () => showPreview(plan, null);
  } else {
    say(`${what}plant ${plan.spots.length} trees? <button id="pl-ok">Plant</button><button id="pl-cancel">Cancel</button>`);
  }
  document.getElementById('pl-ok').onclick = () => applyArea(plan);
  document.getElementById('pl-cancel').onclick = () => { pending = null; clearPreview(); setMode(tool || 'wand'); };
}
function finishDrawing() {
  if (drawing.length < 3) { say('<b>Green area</b>: add at least 3 corners.'); return; }
  cursorM = null;
  const ring = [...drawing, drawing[0]];
  const bad = checkArea(ring);
  if (bad) {
    drawState();
    say(`<b>Green area</b>: ✗ not possible, the area ${bad}. Move the corners off it (Backspace removes the last corner).`);
    return;
  }
  drawing = [];
  propose(ring, 'drawn');
}

// ---------- applying, with a little animation ----------
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
function growIn(objs) {
  const t0 = performance.now();
  const items = objs.map((o, i) => ({ o, s: o.scale.x, delay: Math.min(i * 12, 500) }));
  for (const it of items) it.o.scale.setScalar(0.001);
  (function frame(now) {
    let busy = false;
    for (const it of items) {
      const t = Math.min(1, Math.max(0, (now - t0 - it.delay) / 400));
      it.o.scale.setScalar(Math.max(0.001, it.s * easeOutBack(t)));
      if (t < 1) busy = true;
    }
    map.triggerRepaint();
    if (busy) requestAnimationFrame(frame);
  })(t0);
}
function sinkOut(features) {
  if (!features.length) return;
  const src = map.getSource('demolish-anim');
  src.setData({ type: 'FeatureCollection', features });
  const t0 = performance.now();
  (function frame(now) {
    const t = Math.min(1, (now - t0) / 600);
    map.setPaintProperty('demolish-anim', 'fill-extrusion-height', ['*', ['coalesce', ['get', 'render_height'], 8], 1 - t]);
    map.setPaintProperty('demolish-anim', 'fill-extrusion-opacity', 0.9 * (1 - t * 0.6));
    if (t < 1) requestAnimationFrame(frame); else src.setData(EMPTY);
  })(t0);
}
function floatText(ringM, text) {
  const p = map.project(toLL(centroid(ringM)));
  const el = Object.assign(document.createElement('div'), { className: 'pl-float', textContent: text });
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}
// the climate layer's panel shows the biggest cooling of all edits; read it once it has updated
function climatePeak() {
  const row = [...document.querySelectorAll('#cl-edits div')].find((d) => d.textContent.startsWith('Temperature'));
  const m = row?.textContent.match(/peak ([+-]?\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
function applyArea(plan) {
  const { ring } = pending;
  const area = { ring: ring.map(toLL), m2: plan.m2, demolished: [], removed: [], trees: [] };
  for (const h of plan.houses) {
    const pt = toLL(footprintPoint(h.poly));
    app.deleted.push(pt);
    area.demolished.push(pt);
  }
  for (const o of plan.objs) {
    const i = app.placed.indexOf(o);
    if (i < 0) continue;
    app.scene.remove(o.obj);
    app.placed.splice(i, 1);
    area.removed.push({ type: o.type, lng: o.lng, lat: o.lat });
  }
  const objs = plan.spots.map((p) => {
    const [lng, lat] = toLL(p);
    area.trees.push([lng, lat]);
    return app.addObject('tree', lng, lat);
  });
  sinkOut(plan.houses.map((h) => h.b.feature));
  growIn(objs);
  areas.push(area);
  app.refreshBuildings();
  geoDirty = true;
  pending = null;
  clearPreview();
  const mode = tool;
  app.updateCount();
  app.saveSession();
  saveAreas();
  const before = climatePeak();
  setTimeout(() => {
    const peak = climatePeak();
    const cool = peak != null && peak !== before && peak < 0 ? ` · up to −${Math.abs(peak).toFixed(1)} °C` : '';
    floatText(ring, `+${objs.length} trees${plan.houses.length ? ` · −${plan.houses.length} buildings` : ''}${cool}`);
  }, 450);
  setMode(mode || 'wand');  // stay in the tool: hover the next space
  say(`<b>Green area</b>: ${planText({ ...plan, spots: objs })}. Hover the next space, or <button id="pl-undo-area">Undo area</button>` +
    '<button id="pl-done">Done</button>');
  document.getElementById('pl-undo-area').onclick = undoArea;
  document.getElementById('pl-done').onclick = () => { stopTool(); say(''); };
}
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
function undoArea() {
  const a = areas.pop();
  if (!a) return;
  for (const t of a.trees) {
    const i = app.placed.findIndex((o) => o.type === 'tree' && same([o.lng, o.lat], t));
    if (i >= 0) { app.scene.remove(app.placed[i].obj); app.placed.splice(i, 1); }
  }
  for (const pt of a.demolished) {
    const i = app.deleted.findIndex((d) => same(d, pt));
    if (i >= 0) app.deleted.splice(i, 1);
  }
  for (const o of a.removed) app.addObject(o.type, o.lng, o.lat);
  app.refreshBuildings();
  geoDirty = true;
  hover = null;
  clearPreview();
  drawState();
  app.updateCount();
  app.saveSession();
  saveAreas();
  if (tool) { say(HELP[tool]); document.getElementById('pl-mode').onclick = () => setMode(tool === 'wand' ? 'draw' : 'wand'); }
  else say(areas.length ? '<button id="pl-undo-area">Undo previous area</button>' : '');
  document.getElementById('pl-undo-area')?.addEventListener('click', undoArea);
}
function saveAreas() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(areas)); } catch { /* ignore */ } }
function loadAreas() {
  try { areas = (JSON.parse(sessionStorage.getItem(STORE_KEY)) || []).filter((a) => a.trees); } catch { areas = []; }
}

// ---------- mouse ----------
function onMove(ev) {
  const pt = [ev.lngLat.lng, ev.lngLat.lat];
  cursorM = toM(pt);
  if (tool && !pending) {
    ensureGeo();
    if (tool === 'draw' || ev.originalEvent?.shiftKey) {
      if (tool === 'wand') { hover = null; clearPreview(); }
      const bad = tool === 'draw' ? drawState() : null;
      const closing = drawing.length >= 3 && distM(cursorM, drawing[0]) < 6;
      if (tool === 'wand') { drawState(); return setTip('Shift: click to start drawing corners', true, ev.point); }
      return setTip(bad ? `✗ Area ${bad}` : closing ? '✓ Click to finish' : drawing.length ? '✓ Click to add a corner' : 'Click the first corner', !bad, ev.point);
    }
    // wand: keep the current space while the cursor stays inside it
    if (!(hover?.ring && inPoly(cursorM, [hover.ring]))) {
      hover = spaceAt(cursorM);
      if (hover.ring) {
        hover.plan = areaPlan(hover.ring, true);
        showPreview(hover.plan, hover.ring.length + ':' + hover.ring[0].join(','));
      } else clearPreview();
      drawState();
    }
    return hover.ring
      ? setTip(`${hover.label}: ${planText(hover.plan)} · click to apply`, true, ev.point)
      : setTip(`✗ ${hover.reason}`, false, ev.point);
  }
  const type = placeType();
  if (!type) return hideGhost();
  showGhost(type, pt, check(type, pt), ev.point);
}
function onClick(e) {
  if (!tool || pending) return;
  const p = toM([e.lngLat.lng, e.lngLat.lat]);
  if (tool === 'wand' && e.originalEvent?.shiftKey) { setMode('draw'); }
  if (tool === 'draw') {
    if (drawing.length >= 3 && distM(p, drawing[0]) < 6) return finishDrawing();
    drawing.push(p);
    drawState();
    return;
  }
  ensureGeo();
  const s = spaceAt(p);
  if (s.ring) propose(s.ring, s.label);
  else say(`<b>Green area</b>: ✗ ${s.reason}. Hold Shift to draw the shape yourself.`);
}

// ---------- setup ----------
const CSS = `
#pl-tip{position:fixed;z-index:5;pointer-events:none;display:none;padding:4px 8px;border-radius:6px;
 font:12px/1.3 system-ui,-apple-system,sans-serif;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap}
#pl-tip.ok{background:rgba(46,125,50,.92)} #pl-tip.no{background:rgba(183,28,28,.92)}
#pl-info{position:absolute;left:50%;bottom:170px;transform:translateX(-50%);z-index:3;display:none;max-width:min(600px,calc(100vw - 40px));
 padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.94);box-shadow:0 2px 10px rgba(0,0,0,.18);
 font:12px/1.5 system-ui,-apple-system,sans-serif;color:#1f2933}
#pl-info button{margin:2px 0 2px 6px;font:12px system-ui,sans-serif;border:1px solid rgba(0,0,0,.2);background:#fff;border-radius:6px;padding:2px 10px;cursor:pointer}
#pl-info #pl-ok{background:#2e7d32;border-color:#2e7d32;color:#fff}
.pl-float{position:fixed;z-index:6;pointer-events:none;transform:translate(-50%,-50%);padding:6px 12px;border-radius:14px;
 background:rgba(46,125,50,.95);color:#fff;font:600 14px system-ui,-apple-system,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);
 animation:pl-rise 2.2s ease-out forwards}
@keyframes pl-rise{0%{opacity:0;margin-top:10px}12%{opacity:1;margin-top:0}70%{opacity:1}100%{opacity:0;margin-top:-50px}}`;

function init() {
  app = window.__app;
  map = app.map;
  const c = map.getCenter();
  origin = [c.lng, c.lat];
  mLng = MLAT * Math.cos((c.lat * Math.PI) / 180);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  tip = Object.assign(document.createElement('div'), { id: 'pl-tip' });
  info = Object.assign(document.createElement('div'), { id: 'pl-info' });
  document.body.append(tip, info);

  btn = Object.assign(document.createElement('button'), { id: 'btnGreenArea', textContent: '🌳 Green area',
    title: 'Turn a square, lawn or block green: buildings inside are demolished and trees planted' });
  document.getElementById('btnBuilding').after(btn);
  btn.addEventListener('click', () => (tool ? (stopTool(), say('')) : startTool()));
  // any other tool ends the green area tool
  document.querySelectorAll('#ui button').forEach((b) => b !== btn && b.addEventListener('click', () => {
    if (tool) { stopTool(); say(''); }
  }));

  map.addSource('green-areas', { type: 'geojson', data: EMPTY });
  const colour = ['match', ['get', 'state'], 'bad', '#c62828', 'pending', '#f9a825', '#2e7d32'];
  map.addLayer({ id: 'green-areas-fill', type: 'fill', source: 'green-areas', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['match', ['get', 'state'], 'done', '#7cc576', colour],
      'fill-opacity': ['match', ['get', 'state'], 'done', 0.45, 0.3] } }, 'buildings-own');
  // the dashed outline is only for the area being chosen; finished areas are just the green fill
  map.addLayer({ id: 'green-areas-line', type: 'line', source: 'green-areas',
    filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'state'], 'done']],
    paint: { 'line-color': colour, 'line-width': 3, 'line-dasharray': [2, 1] } }, 'buildings-own');
  map.addLayer({ id: 'green-areas-corners', type: 'circle', source: 'green-areas', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-width': 2, 'circle-stroke-color': colour } });
  map.addSource('placement-ghost', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'placement-ghost', type: 'fill', source: 'placement-ghost',
    paint: { 'fill-color': ['case', ['get', 'ok'], '#2e7d32', '#c62828'], 'fill-opacity': 0.55 } }, 'buildings-own');
  // buildings a green area would demolish (red), and the ones sinking away after applying
  const height = ['+', ['coalesce', ['get', 'render_height'], 8], 0.4];
  const base = ['coalesce', ['get', 'render_min_height'], 0];
  map.addSource('demolish-preview', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'demolish-preview', type: 'fill-extrusion', source: 'demolish-preview',
    paint: { 'fill-extrusion-color': '#e53935', 'fill-extrusion-height': height, 'fill-extrusion-base': base, 'fill-extrusion-opacity': 0.85 } });
  map.addSource('demolish-anim', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'demolish-anim', type: 'fill-extrusion', source: 'demolish-anim',
    paint: { 'fill-extrusion-color': '#e8e4dc', 'fill-extrusion-height': height, 'fill-extrusion-base': base, 'fill-extrusion-opacity': 0.9 } });
  setupGhosts();

  loadAreas();
  // the map geometry changes as tiles load, the view moves or buildings are deleted
  map.on('sourcedata', (e) => { if (e.sourceId === 'openmaptiles' && e.isSourceLoaded) geoDirty = true; });
  map.on('moveend', () => { geoDirty = true; hover = null; });
  window.addEventListener('scene-changed', () => { geoDirty = true; });
  map.on('idle', () => { if (geoDirty) rebuildGeo(); });
  fetch('trees.json').then((r) => r.json()).then((rows) => {
    const g = new Grid();
    for (const r of rows) { const p = toM([r[0], r[1]]); g.add(p, bboxOf([p])); }
    geo.trees = g;
  }).catch(() => {});
  drawState();

  // mouse feedback, at most once per frame
  let queued = null;
  map.on('mousemove', (e) => {
    if (!queued) requestAnimationFrame(() => { const ev = queued; queued = null; onMove(ev); });
    queued = e;
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    hideGhost();
    if (tool && !pending) { cursorM = null; hover = null; clearPreview(); drawState(); }
  });
  map.on('click', onClick);
  window.addEventListener('keydown', (e) => {
    if (!tool) return;
    if (e.key === 'Escape') {
      if (pending) { pending = null; clearPreview(); setMode(tool); } else { stopTool(); say(''); }
      return;
    }
    if (tool !== 'draw' || pending) return;
    if (e.key === 'Enter') { e.preventDefault(); finishDrawing(); }
    if (e.key === 'Backspace') { e.preventDefault(); drawing.pop(); drawState(); }
  });
  // "Original" view of the scenario comparison: hide the areas and pause the tool;
  // keep the area layers above the climate layer's colour overlay (it may be added after us)
  setInterval(() => {
    const original = document.querySelector('#comparison-card button[aria-pressed="true"]')?.textContent === 'Original';
    for (const id of ['green-areas-fill', 'green-areas-line', 'green-areas-corners'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', original ? 'none' : 'visible');
    btn.disabled = !!document.getElementById('btnTree')?.disabled;
    const ids = map.getStyle().layers.map((l) => l.id);
    if (ids.includes('climate-overlay') && ids.indexOf('climate-overlay') > ids.indexOf('green-areas-fill'))
      for (const id of ['green-areas-fill', 'green-areas-line', 'placement-ghost']) map.moveLayer(id, 'buildings-own');
  }, 250);
}

// Asked by index.html before placing a single tree or building. Shows the reason when refused.
window.placement = {
  spaceAt: (lngLat) => (ensureGeo(), spaceAt(toM(lngLat))), // for testing in the console
  allow(type, e) {
    if (!map) return true;
    const pt = [e.lngLat.lng, e.lngLat.lat];
    const reason = check(type, pt);
    if (reason) showGhost(type, pt, reason, e.point);
    return !reason;
  }
};

if (window.__app?.ready) init();
else window.addEventListener('app-ready', init, { once: true });
