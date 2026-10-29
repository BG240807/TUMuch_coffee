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
const BUILDING = { w: 16, d: 12, floors: 4, rot: 0, roofType: 'standard' }; // default building spec
const getBuildingSpec = () => {
  if (!window.__app) window.__app = {};
  if (!window.__app.buildingSpec) window.__app.buildingSpec = { ...BUILDING };
  return window.__app.buildingSpec;
};
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

let geo = { lines: new Grid(), areas: new Grid(), names: new Grid(), houses: new Grid(), trees: new Grid(), roads: new Grid() };
let geoDirty = true;
const lineList = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);
const polyList = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

function rebuildGeo() {
  if (!map.getSource('openmaptiles') || map.getZoom() < 13) return;
  const g = { lines: new Grid(), areas: new Grid(), names: new Grid(), houses: new Grid(), trees: geo.trees, roads: new Grid() };
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
      if (p.class === 'path' && ['pedestrian', 'footway'].includes(p.subclass)) addArea(f, 'square', 'square'); // not platforms
      continue;
    }
    if (p.class === 'service' && p.service === 'parking_aisle') continue;
    const half = ROAD_HALF[p.class] ?? RAIL_HALF[p.class];
    if (!half) continue;
    const isCarRoad = !!ROAD_HALF[p.class];
    for (const line of lineList(f.geometry)) {
      addLine(line, half, RAIL_HALF[p.class] ? 'railway' : 'road');
      if (isCarRoad) {
        const m = line.map(toM);
        let len = 0;
        for (let i = 0; i < m.length - 1; i++) len += distM(m[i], m[i + 1]);
        const roadItem = {
          m,
          coords: line,
          half,
          class: p.class,
          lengthM: len,
          feature: f
        };
        for (let i = 0; i < m.length - 1; i++) {
          g.roads.add(roadItem, bboxOf([m[i], m[i + 1]], half + 8));
        }
      }
    }
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

function roadAt(p) {
  ensureGeo();
  let best = null, bd = Infinity;
  for (const r of geo.roads.near(bboxOf([p], 25))) {
    for (let i = 0; i < r.m.length - 1; i++) {
      const d = segDist(p, r.m[i], r.m[i + 1]);
      if (d < r.half + 8 && d < bd) {
        bd = d;
        best = r;
      }
    }
  }
  if (!best) return null;
  let name = null;
  for (const pt of [best.m[Math.floor(best.m.length / 2)], best.m[0], best.m[best.m.length - 1]]) {
    name = streetName(pt);
    if (name) break;
  }
  const matched = [best];
  if (name) {
    const seen = new Set([best]);
    for (const r of geo.roads.near(bboxOf([p], 600))) {
      if (seen.has(r)) continue;
      let rName = null;
      for (const pt of [r.m[Math.floor(r.m.length / 2)], r.m[0], r.m[r.m.length - 1]]) {
        rName = streetName(pt);
        if (rName) break;
      }
      if (rName === name) {
        seen.add(r);
        matched.push(r);
      }
    }
  }
  let totalLen = 0;
  for (const r of matched) totalLen += r.lengthM;
  return {
    primary: best,
    matched,
    name,
    half: best.half,
    totalLen: Math.round(totalLen)
  };
}

function computeStreetTreeSpots(matchedRoads, spacing = 12) {
  const spots = [];
  for (const r of matchedRoads) {
    const m = r.m;
    const half = Math.max(3, r.half || 6);
    for (let i = 0; i < m.length - 1; i++) {
      const a = m[i], b = m[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const segLen = Math.hypot(dx, dy);
      if (segLen < 8) continue;
      const nx = -dy / segLen, ny = dx / segLen;
      const numSteps = Math.max(1, Math.floor(segLen / spacing));
      for (let s = 0.5; s < numSteps; s++) {
        const cx = a[0] + (s / numSteps) * dx;
        const cy = a[1] + (s / numSteps) * dy;
        const leftSpot = [cx + nx * (half + 0.5), cy + ny * (half + 0.5)];
        const rightSpot = [cx - nx * (half + 0.5), cy - ny * (half + 0.5)];
        for (const sp of [leftSpot, rightSpot]) {
          if (areaAt(sp, 'water') || houseAt(sp) || cadastreNear(sp, 3.5)) continue;
          if (spots.some((existing) => distM(existing, sp) < 6)) continue;
          spots.push(sp);
        }
      }
    }
  }
  return spots;
}

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
    const spec = getBuildingSpec();
    const w = spec.w || 16, d = spec.d || 12, rot = spec.rot || 0;
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const hw = w / 2, hd = d / 2;
    const localPts = [[0, 0], [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, -hd], [0, hd], [-hw, 0], [hw, 0]];
    const pts = localPts.map(([dx, dy]) => [
      p[0] + dx * cos - dy * sin,
      p[1] + dx * sin + dy * cos
    ]);
    for (const q of pts) {
      if (areaAt(q, 'water')) return 'in water';
      const l = lineAt(q, 1);
      if (l) return lineReason(l, q, 'on');
      if (houseAt(q)) return 'overlaps a building';
      if (areaAt(q, 'park') || areaAt(q, 'forest')) return 'in a park or forest';
    }
    if (placedNear(p, 'building', Math.hypot(w, d) * 0.9 + 2)) return 'too close to a new building';
    if (placedNear(p, 'tree', Math.min(w, d) / 2 + 2)) return 'on a new tree';
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
const trees = (n) => `${n} tree${n === 1 ? '' : 's'}`;
const planText = (plan) => {
  const parts = [`${Math.round(plan.m2).toLocaleString('en')} m²`, trees(plan.spots.length)];
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
  const spec = getBuildingSpec();
  const rot = spec.rot || 0;
  const layout = spec.layout || 'single';
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rotPt = ([dx, dy]) => [
    p[0] + dx * cos - dy * sin,
    p[1] + dx * sin + dy * cos
  ];

  if (layout === 'L-wing') {
    const W = spec.w || 16, D = spec.d || 12;
    const T = Math.max(5, Math.round(Math.min(W, D) * 0.45));
    const corners = [
      [-W / 2, -D / 2],
      [W / 2, -D / 2],
      [W / 2, -D / 2 + T],
      [-W / 2 + T, -D / 2 + T],
      [-W / 2 + T, D / 2],
      [-W / 2, D / 2],
      [-W / 2, -D / 2]
    ];
    return corners.map(rotPt);
  }

  if (layout === 'courtyard' || layout === 'eco-complex') {
    const W = Math.max(22, spec.w || 16), D = Math.max(18, spec.d || 12);
    const hw = W / 2, hd = D / 2;
    const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]];
    return corners.map(rotPt);
  }

  const w = spec.w || 16, d = spec.d || 12;
  const hw = w / 2, hd = d / 2;
  const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd]];
  return corners.map(rotPt);
}
// a see-through 3D tree or building at the cursor (same shapes as in index.html), green or red
let ghost3d = null;
function makeGhost3d() {
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x43a047, transparent: true, opacity: 0.5, depthWrite: false });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xefece6, transparent: true, opacity: 0.8, depthWrite: false });
  const tree = new THREE.Group();
  tree.add(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 4, 6).translate(0, 2, 0), wallMat),
    new THREE.Mesh(new THREE.IcosahedronGeometry(3, 1).scale(1, 1.2, 1).translate(0, 6, 0), wallMat));
  tree.scale.setScalar(1.2);
  const building = new THREE.Group();
  tree.visible = building.visible = false;
  app.scene.add(tree, building);
  return { tree, building, mat: wallMat, roofMat };
}
function showGhost(type, pt, reason, point) {
  map.getSource('placement-ghost').setData({ type: 'Feature', properties: { ok: !reason },
    geometry: { type: 'Polygon', coordinates: [ghostRing(type, toM(pt)).map(toLL)] } });
  ghost3d ??= makeGhost3d();
  const obj = ghost3d[type], other = ghost3d[type === 'tree' ? 'building' : 'tree'];
  if (type === 'building') {
    const spec = getBuildingSpec();
    const floors = spec.floors || 4, rot = spec.rot || 0;
    const layout = spec.layout || 'single';
    const roofType = layout === 'eco-complex' ? 'green' : (spec.roofType || 'standard');
    const h = floors * 3.2;
    const wallMat = ghost3d.mat, roofMat = ghost3d.roofMat;
    const bMats = [wallMat, wallMat, roofMat, wallMat, wallMat, wallMat];

    while (obj.children.length) obj.remove(obj.children[0]);

    if (layout === 'L-wing') {
      const W = spec.w || 16, D = spec.d || 12;
      const T = Math.max(5, Math.round(Math.min(W, D) * 0.45));
      const m1 = new THREE.Mesh(new THREE.BoxGeometry(W, h, T), bMats);
      m1.position.set(0, h / 2, -D / 2 + T / 2);
      const D2 = D - T;
      const m2 = new THREE.Mesh(new THREE.BoxGeometry(T, h, D2), bMats);
      m2.position.set(-W / 2 + T / 2, h / 2, T / 2);
      obj.add(m1, m2);
    } else if (layout === 'courtyard' || layout === 'eco-complex') {
      const W = Math.max(22, spec.w || 16), D = Math.max(18, spec.d || 12);
      const T = Math.max(5, Math.round(Math.min(W, D) * 0.28));
      const D_side = D - 2 * T;
      const mN = new THREE.Mesh(new THREE.BoxGeometry(W, h, T), bMats);
      mN.position.set(0, h / 2, -D / 2 + T / 2);
      const mS = new THREE.Mesh(new THREE.BoxGeometry(W, h, T), bMats);
      mS.position.set(0, h / 2, D / 2 - T / 2);
      const mW = new THREE.Mesh(new THREE.BoxGeometry(T, h, D_side), bMats);
      mW.position.set(-W / 2 + T / 2, h / 2, 0);
      const mE = new THREE.Mesh(new THREE.BoxGeometry(T, h, D_side), bMats);
      mE.position.set(W / 2 - T / 2, h / 2, 0);
      obj.add(mN, mS, mW, mE);

      if (layout === 'eco-complex') {
        const trunkGeom = new THREE.CylinderGeometry(0.2, 0.3, 3, 6);
        trunkGeom.translate(0, 1.5, 0);
        const folGeom = new THREE.IcosahedronGeometry(2.2, 1);
        folGeom.translate(0, 4.5, 0);
        const t1 = new THREE.Group();
        t1.add(new THREE.Mesh(trunkGeom, wallMat), new THREE.Mesh(folGeom, wallMat));
        t1.position.set(-Math.round((W - 2 * T) * 0.25), 0, 0);
        const t2 = new THREE.Group();
        t2.add(new THREE.Mesh(trunkGeom, wallMat), new THREE.Mesh(folGeom, wallMat));
        t2.position.set(Math.round((W - 2 * T) * 0.25), 0, 0);
        obj.add(t1, t2);
      }
    } else {
      const w = spec.w || 16, d = spec.d || 12;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bMats);
      m.position.set(0, h / 2, 0);
      obj.add(m);
    }

    obj.rotation.y = (rot * Math.PI) / 180;
    const roofColor = roofType === 'green' ? 0x2e7d32 : roofType === 'solar' ? 0x1565c0 : 0xefece6;
    ghost3d.roofMat.color.set(reason ? 0xe53935 : roofColor);
  }
  obj.position.copy(app.toScene(pt[0], pt[1], app.groundAt(pt[0], pt[1])));
  obj.visible = true;
  other.visible = false;
  ghost3d.mat.color.set(reason ? 0xe53935 : 0x43a047);
  map.triggerRepaint();
  setTip(reason ? `✗ Not here: ${reason}` : type === 'tree' ? '✓ Plant tree here' : '✓ Build here', !reason, point);
}
function hideGhost() {
  map.getSource('placement-ghost')?.setData(EMPTY);
  if (ghost3d?.tree.visible || ghost3d?.building.visible) { ghost3d.tree.visible = ghost3d.building.visible = false; map.triggerRepaint(); }
  setTip(null);
  lastCursorLL = null;
  lastCursorPoint = null;
}
const activeTool = () => document.querySelector('#ui button.active')?.id;
const placeType = () => ({ btnTree: 'tree', btnBuilding: 'building' })[activeTool()];
function say(html) { info.innerHTML = html; info.style.display = html ? 'block' : 'none'; }

// ---------- Building interactive controls pill & live adjustment ----------
let lastCursorLL = null;
let lastCursorPoint = null;

const LAYOUTS = ['single', 'L-wing', 'courtyard', 'eco-complex'];
function cycleBuildingLayout() {
  const spec = getBuildingSpec();
  const current = spec.layout || 'single';
  const idx = LAYOUTS.indexOf(current);
  const next = LAYOUTS[(idx + 1) % LAYOUTS.length];
  spec.layout = next;
  if (next === 'eco-complex') spec.roofType = 'green';
  if (window.__app) window.__app.buildingSpec = spec;
  updateBuildingPill();
  refreshGhostBuilding();
}

function cycleRoofType() {
  const spec = getBuildingSpec();
  const next = spec.roofType === 'standard' ? 'green' : spec.roofType === 'green' ? 'solar' : 'standard';
  spec.roofType = next;
  if (window.__app) window.__app.buildingSpec = spec;
  updateBuildingPill();
  refreshGhostBuilding();
}

function updateBuildingPill() {
  if (placeType() !== 'building' || tool || brush) return;
  const spec = getBuildingSpec();
  const layout = spec.layout || 'single';
  const layoutLabels = {
    'single': '🏛️ Single (C)',
    'L-wing': '🏢 L-wing (C)',
    'courtyard': '🏬 Courtyard (C)',
    'eco-complex': '🌿 Eco-complex (C)'
  };
  const layoutBadge = layoutLabels[layout] || '🏛️ Single (C)';
  const roof = spec.roofType || 'standard';
  const roofBadge = roof === 'green' ? '🌱 Green roof' : roof === 'solar' ? '☀️ Solar roof' : '🏢 Standard roof';
  const html = `🏢 <b>${spec.w}×${spec.d} m · ${spec.floors} fl · ${spec.rot}°</b> ` +
    `<button id="bld-layout" title="Cycle layout (single → L-wing → courtyard → eco-complex, shortcut: C)">${layoutBadge}</button> ` +
    `<button id="bld-roof" title="Cycle roof type (standard → green → solar, shortcut: G)">${roofBadge} (G)</button> ` +
    `<button id="bld-rot" title="Rotate 15° (shortcut: R or [ / ])">↻ Rotate (R)</button> ` +
    `<span style="margin-left:3px;font-size:11px;color:#64748b">W</span><button id="bld-w-dec" title="Narrower">−</button><button id="bld-w-inc" title="Wider">+</button> ` +
    `<span style="margin-left:3px;font-size:11px;color:#64748b">D</span><button id="bld-d-dec" title="Shorter">−</button><button id="bld-d-inc" title="Deeper">+</button> ` +
    `<span style="margin-left:3px;font-size:11px;color:#64748b">Floors</span><button id="bld-fl-dec" title="Fewer floors (−)">−</button><button id="bld-fl-inc" title="More floors (+)">+</button>`;
  say(html);

  document.getElementById('bld-layout')?.addEventListener('click', cycleBuildingLayout);
  document.getElementById('bld-roof')?.addEventListener('click', cycleRoofType);
  document.getElementById('bld-rot')?.addEventListener('click', () => adjustBuilding({ rot: 15 }));
  document.getElementById('bld-w-dec')?.addEventListener('click', () => adjustBuilding({ dw: -2 }));
  document.getElementById('bld-w-inc')?.addEventListener('click', () => adjustBuilding({ dw: 2 }));
  document.getElementById('bld-d-dec')?.addEventListener('click', () => adjustBuilding({ dd: -2 }));
  document.getElementById('bld-d-inc')?.addEventListener('click', () => adjustBuilding({ dd: 2 }));
  document.getElementById('bld-fl-dec')?.addEventListener('click', () => adjustBuilding({ dfl: -1 }));
  document.getElementById('bld-fl-inc')?.addEventListener('click', () => adjustBuilding({ dfl: 1 }));
}

function updateSelectionPill(sel) {
  if (tool || brush) return;
  const isSelectMode = activeTool() === 'btnSelect' || document.getElementById('btnSelect')?.classList.contains('active');
  if (!isSelectMode) return;

  const bs = !sel ? [] : Array.isArray(sel) ? sel : sel.buildings ? sel.buildings : (sel.feature || sel.poly) ? [sel] : [];
  const plBuildings = sel?.placed ? sel.placed.filter(p => p.type === 'building') : [];
  const count = bs.length + plBuildings.length;

  if (count > 0) {
    const label = count === 1 ? '1 building' : `${count} buildings`;
    say(`🏢 <b>${label}</b> ` +
      `<button id="sel-green" title="Add green roof">🌱 Green roof</button> ` +
      `<button id="sel-solar" title="Add solar roof">☀️ Solar roof</button> ` +
      `<button id="sel-demolish" title="Demolish selected (Del)">🗑 Demolish</button>`);
    document.getElementById('sel-green')?.addEventListener('click', () => window.__app?.retrofitSelected?.('green'));
    document.getElementById('sel-solar')?.addEventListener('click', () => window.__app?.retrofitSelected?.('solar'));
    document.getElementById('sel-demolish')?.addEventListener('click', () => window.__app?.deleteSelected?.());
  } else {
    say('');
  }
}

function adjustBuilding({ rot = 0, dw = 0, dd = 0, dfl = 0 }) {
  const spec = getBuildingSpec();
  if (rot) spec.rot = ((spec.rot + rot) % 360 + 360) % 360;
  if (dw) spec.w = Math.max(8, Math.min(40, spec.w + dw));
  if (dd) spec.d = Math.max(8, Math.min(40, spec.d + dd));
  if (dfl) spec.floors = Math.max(1, Math.min(15, spec.floors + dfl));
  if (window.__app) window.__app.buildingSpec = spec;
  updateBuildingPill();
  refreshGhostBuilding();
}

function refreshGhostBuilding() {
  if (placeType() === 'building' && lastCursorLL && lastCursorPoint) {
    showGhost('building', lastCursorLL, check('building', lastCursorLL), lastCursorPoint);
  }
}

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
  map.getSource('carfree-hover')?.setData(EMPTY);
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = '';
  btn.classList.remove('active');
  btnCarFree?.classList.remove('active');
  setTip(null);
  // always leave a normal tool active (the scenario comparison restores "the previous tool")
  if (!document.querySelector('#ui button.active')) document.getElementById('btnNav').click();
  drawState();
  drawCarFreeState();
  if (placeType() === 'building') updateBuildingPill(); else say('');
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
    say(`${what}demolish ${plan.houses.length} building${plan.houses.length > 1 ? 's' : ''} and plant ${trees(plan.spots.length)}? ` +
      '<button id="pl-ok">Demolish & plant</button>' +
      `<button id="pl-keep">Keep buildings (${trees(keep.spots.length)})</button><button id="pl-cancel">Cancel</button>`);
    document.getElementById('pl-keep').onclick = () => applyArea(keep);
    document.getElementById('pl-keep').onmouseenter = () => showPreview(keep, null);
    document.getElementById('pl-ok').onmouseenter = () => showPreview(plan, null);
  } else {
    say(`${what}plant ${trees(plan.spots.length)}? <button id="pl-ok">Plant</button><button id="pl-cancel">Cancel</button>`);
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
function floatText(targetM, text) {
  if (!map || !targetM) return;
  let pt;
  if (Array.isArray(targetM) && typeof targetM[0] === 'number') {
    pt = targetM;
  } else if (Array.isArray(targetM) && targetM.length > 2 && Array.isArray(targetM[0])) {
    pt = centroid(targetM);
  } else if (Array.isArray(targetM) && targetM.length > 0 && Array.isArray(targetM[0])) {
    pt = targetM[0];
  } else {
    return;
  }
  const p = map.project(toLL(pt));
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
    floatText(ring, `+${trees(objs.length)}${plan.houses.length ? ` · −${plan.houses.length} buildings` : ''}${cool}`);
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
function resetAreas() {
  areas = [];
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  if (map?.getSource('green-areas')) map.getSource('green-areas').setData(EMPTY);
  if (tool) { stopTool(); say(''); }
  if (brush) stopBrush();
}

// ---------- car-free street tool ----------
let btnCarFree;

function startCarFreeTool() {
  if (document.getElementById('btnTree')?.disabled) return;
  document.getElementById('btnNav').click();
  document.querySelectorAll('#ui button').forEach((b) => b.classList.remove('active'));
  btnCarFree?.classList.add('active');
  ensureGeo();
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  tool = 'carfree';
  drawing = [];
  hover = null;
  clearPreview();
  say('🚲 <b>Car-free street</b>: hover a car road and click to turn it into a green pedestrian/bike street with trees along both edges.');
  drawCarFreeState();
}

function drawCarFreeState() {
  const items = window.__app?.carFreeLines || [];
  const features = [];
  for (const item of items) {
    for (const coords of (item.lines || [])) {
      features.push({
        type: 'Feature',
        properties: { name: item.name, lengthM: item.lengthM },
        geometry: { type: 'LineString', coordinates: coords }
      });
    }
  }
  map.getSource('carfree-lines')?.setData({ type: 'FeatureCollection', features });
}

function applyCarFreeStreet(rd) {
  if (!window.__app.carFreeLines) window.__app.carFreeLines = [];
  const spots = computeStreetTreeSpots(rd.matched);
  const plantedTrees = [];
  for (const p of spots) {
    const [lng, lat] = toLL(p);
    const obj = app.addObject('tree', lng, lat);
    plantedTrees.push({ obj, lng, lat });
  }
  growIn(plantedTrees.map((t) => t.obj));

  const carFreeItem = {
    id: 'cf_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    name: rd.name || 'Car-free street',
    lengthM: rd.totalLen,
    lines: rd.matched.map((r) => r.coords),
    trees: plantedTrees.map((t) => [t.lng, t.lat])
  };
  window.__app.carFreeLines.push(carFreeItem);

  if (!window.__app.history) window.__app.history = [];
  window.__app.history.push({
    kind: 'carfree',
    item: carFreeItem,
    trees: plantedTrees
  });

  drawCarFreeState();
  clearPreview();
  map.getSource('carfree-hover')?.setData(EMPTY);
  app.updateCount();
  app.saveSession();

  floatText(rd.primary.m[0], `🚲 ${rd.name || 'Street'} car-free · +${plantedTrees.length} trees · ${rd.totalLen} m`);
  say(`🚲 <b>Car-free street</b>: ${rd.name || 'Street'} (${rd.totalLen} m, ${plantedTrees.length} trees planted). ` +
    '<button id="pl-undo-carfree">Undo</button><button id="pl-done">Done</button>');
  document.getElementById('pl-undo-carfree').onclick = () => undoCarFree(carFreeItem);
  document.getElementById('pl-done').onclick = () => { stopTool(); say(''); };
}

function undoCarFree(targetItem) {
  const list = window.__app?.carFreeLines;
  if (!list || !list.length) return;
  const item = targetItem || list.pop();
  if (targetItem) {
    const idx = list.indexOf(targetItem);
    if (idx >= 0) list.splice(idx, 1);
  }
  if (item && item.trees) {
    for (const pt of item.trees) {
      const idx = app.placed.findIndex((p) => p.type === 'tree' && distM(toM([p.lng, p.lat]), toM(pt)) < 2);
      if (idx >= 0) {
        app.scene.remove(app.placed[idx].obj);
        app.placed.splice(idx, 1);
      }
    }
  }
  drawCarFreeState();
  clearPreview();
  map.getSource('carfree-hover')?.setData(EMPTY);
  app.updateCount();
  app.saveSession();
  if (tool === 'carfree') {
    say('🚲 <b>Car-free street</b>: hover a car road and click to turn it into a green pedestrian/bike street with trees.');
  } else {
    say(list.length ? '<button id="pl-undo-carfree">Undo previous car-free street</button>' : '');
    document.getElementById('pl-undo-carfree')?.addEventListener('click', () => undoCarFree());
  }
}

// ---------- tree brush: hold the mouse down and paint trees ----------
const BRUSH = { min: 5, max: 40, gap: 7, tries: 6 }; // m; gap between brushed trees; spots tried per mouse move
let brush = null;          // { r, painting, stroke: [placed entries], last, timer } while the brush is on
const strokes = [];        // undo stack, one entry per stroke
let brushBtn;
const brushHelp = () => `🖌️ <b>${brush.r} m</b>` +
  '<button id="pl-smaller" title="Smaller ([)">−</button><button id="pl-bigger" title="Larger (])">+</button>' +
  `${strokes.length ? '<button id="pl-undo-stroke" title="Undo last stroke">↩</button>' : ''}<button id="pl-brush-done" title="Done">✕</button>`;
function sayBrush() {
  say(brushHelp());
  document.getElementById('pl-smaller').onclick = () => resizeBrush(-5);
  document.getElementById('pl-bigger').onclick = () => resizeBrush(5);
  document.getElementById('pl-brush-done').onclick = stopBrush;
  const u = document.getElementById('pl-undo-stroke');
  if (u) u.onclick = undoStroke;
}
function resizeBrush(d) {
  brush.r = Math.min(BRUSH.max, Math.max(BRUSH.min, brush.r + d));
  if (cursorM) drawBrush(cursorM);
  sayBrush();
}
function drawBrush(p) {
  const ring = Array.from({ length: 41 }, (_, i) => [p[0] + brush.r * Math.cos((i / 40) * 2 * Math.PI), p[1] + brush.r * Math.sin((i / 40) * 2 * Math.PI)]);
  map.getSource('brush-cursor').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring.map(toLL) } });
}
function startBrush() {
  if (document.getElementById('btnTree')?.disabled) return;
  document.getElementById('btnNav').click();
  document.querySelectorAll('#ui button').forEach((b) => b.classList.remove('active'));
  brushBtn.classList.add('active');
  ensureGeo();
  brush = { r: 15, painting: false, stroke: [] };
  map.dragPan.disable();
  map.getCanvas().style.cursor = 'none';
  sayBrush();
}
function stopBrush() {
  if (!brush) return;
  endStroke();
  brush = null;
  map.dragPan.enable();
  map.getCanvas().style.cursor = '';
  brushBtn.classList.remove('active');
  map.getSource('brush-cursor').setData(EMPTY);
  if (!document.querySelector('#ui button.active')) document.getElementById('btnNav').click();
  if (placeType() === 'building') updateBuildingPill(); else say('');
}
function paintAt(p) {
  for (let i = 0; i < BRUSH.tries; i++) {
    const a = Math.random() * 2 * Math.PI, d = brush.r * Math.sqrt(Math.random());
    const q = [p[0] + d * Math.cos(a), p[1] + d * Math.sin(a)];
    const ll = toLL(q);
    if (check('tree', ll) || placedNear(q, 'tree', BRUSH.gap)) continue;
    const obj = app.addObject('tree', ll[0], ll[1]);
    brush.stroke.push(app.placed[app.placed.length - 1]);
    growIn([obj]);
  }
}
// paint along the way from the last painted spot, so fast strokes leave a trail
function paintTo(p) {
  const last = brush.last || p;
  const steps = Math.max(1, Math.ceil(distM(last, p) / (brush.r / 2)));
  for (let i = 1; i <= steps; i++) paintAt([last[0] + ((p[0] - last[0]) * i) / steps, last[1] + ((p[1] - last[1]) * i) / steps]);
  brush.last = p;
}
function startStroke(p) {
  brush.painting = true;
  brush.stroke = [];
  brush.last = p;
  paintAt(p);
  // holding the mouse still keeps filling the circle, like a spray can
  brush.timer = setInterval(() => { if (cursorM) paintAt(cursorM); }, 120);
}
function endStroke() {
  if (!brush?.painting) return;
  brush.painting = false;
  clearInterval(brush.timer);
  if (!brush.stroke.length) return;
  strokes.push(brush.stroke);
  if (cursorM) floatText([cursorM, cursorM], `+${trees(brush.stroke.length)}`);
  brush.stroke = [];
  app.updateCount();
  app.saveSession();
  sayBrush();
}
function undoStroke() {
  const st = strokes.pop();
  if (!st) return;
  for (const o of st) {
    const i = app.placed.indexOf(o);
    if (i >= 0) { app.scene.remove(o.obj); app.placed.splice(i, 1); }
  }
  app.updateCount();
  app.saveSession();
  if (brush) sayBrush();
}

// ---------- mouse ----------
function onMove(ev) {
  const pt = [ev.lngLat.lng, ev.lngLat.lat];
  cursorM = toM(pt);
  lastCursorLL = pt;
  lastCursorPoint = ev.point;
  if (brush) {
    drawBrush(cursorM);
    if (brush.painting) paintTo(cursorM);
    return setTip(brush.painting ? `+${trees(brush.stroke.length)}` : 'Hold the mouse down to paint trees', true, ev.point);
  }
  if (tool && !pending) {
    if (tool === 'carfree') {
      ensureGeo();
      const rd = roadAt(cursorM);
      if (!rd) {
        clearPreview();
        map.getSource('carfree-hover')?.setData(EMPTY);
        return setTip('✗ Hover a car road to convert', false, ev.point);
      }
      const already = (window.__app?.carFreeLines || []).some((cf) =>
        cf.name && rd.name ? cf.name === rd.name : cf.lines?.some((ln) => distM(ln[0], rd.primary.coords[0]) < 10)
      );
      if (already) {
        clearPreview();
        map.getSource('carfree-hover')?.setData(EMPTY);
        return setTip(`✓ Already car-free: ${rd.name || 'street'}`, true, ev.point);
      }
      const features = rd.matched.map((r) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.coords }
      }));
      map.getSource('carfree-hover')?.setData({ type: 'FeatureCollection', features });
      const spots = computeStreetTreeSpots(rd.matched);
      showPreview({ spots, houses: [] }, `cf_${rd.name || ''}_${rd.totalLen}`);
      return setTip(`🚲 Make ${rd.name || 'street'} car-free (${rd.totalLen} m) · click to convert`, true, ev.point);
    }
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
  if (type === 'building' && !tool && !brush && (!info.innerHTML || info.style.display === 'none')) {
    updateBuildingPill();
  }
  showGhost(type, pt, check(type, pt), ev.point);
}
function onClick(e) {
  if (!tool || pending) return;
  const p = toM([e.lngLat.lng, e.lngLat.lat]);
  if (tool === 'carfree') {
    ensureGeo();
    const rd = roadAt(p);
    if (!rd) return;
    const already = (window.__app?.carFreeLines || []).some((cf) =>
      cf.name && rd.name ? cf.name === rd.name : cf.lines?.some((ln) => distM(ln[0], rd.primary.coords[0]) < 10)
    );
    if (already) {
      say(`🚲 <b>Car-free street</b>: ${rd.name || 'street'} is already car-free.`);
      return;
    }
    applyCarFreeStreet(rd);
    return;
  }
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
#pl-info{position:absolute;left:50%;top:56px;transform:translateX(-50%);z-index:3;display:none;max-width:min(680px,calc(100vw - 40px));
 padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
 border:1px solid rgba(15,23,42,.1);box-shadow:0 4px 16px rgba(15,23,42,.14);
 font:500 12px/1.4 system-ui,-apple-system,sans-serif;color:#1f2933;white-space:nowrap}
#pl-info button{margin:0 0 0 5px;font:500 11.5px system-ui,sans-serif;border:1px solid rgba(15,23,42,.16);background:#fff;border-radius:999px;padding:2px 8px;cursor:pointer}
#pl-info button:hover{background:rgba(15,23,42,.06)}
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

  brushBtn = Object.assign(document.createElement('button'), { id: 'btnTreeBrush', textContent: '🖌️ Tree brush',
    title: 'Tree brush (5) — Hold the mouse down and paint trees' });
  document.getElementById('btnTree').after(brushBtn);
  brushBtn.addEventListener('click', () => (brush ? stopBrush() : startBrush()));
  btn = Object.assign(document.createElement('button'), { id: 'btnGreenArea', textContent: '🌳 Green area',
    title: 'Green area (6) — Turn a square, lawn or block green: buildings inside are demolished and trees planted' });
  brushBtn.after(btn);
  btn.addEventListener('click', () => (tool ? (stopTool(), say('')) : startTool()));

  btnCarFree = Object.assign(document.createElement('button'), {
    id: 'btnCarFree',
    textContent: '🚲 Car-free street',
    title: 'Car-free street (8) — Convert a car road into a green pedestrian and bike street with street trees along both edges'
  });
  const btnBld = document.getElementById('btnBuilding');
  if (btnBld) btnBld.after(btnCarFree);
  else document.getElementById('ui')?.appendChild(btnCarFree);
  btnCarFree.addEventListener('click', () => (tool === 'carfree' ? (stopTool(), say('')) : startCarFreeTool()));

  // any other tool ends the green area tool / the brush / carfree tool
  document.getElementById('ui')?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b !== btn && b !== btnCarFree && tool) { stopTool(); }
    if (b !== brushBtn && brush) { stopBrush(); }
    setTimeout(() => {
      if (placeType() === 'building' && !tool && !brush) {
        updateBuildingPill();
        refreshGhostBuilding();
      } else if ((activeTool() === 'btnSelect' || document.getElementById('btnSelect')?.classList.contains('active')) && !tool && !brush) {
        updateSelectionPill(window.__app?.selected || null);
      } else if (!tool && !brush) {
        say('');
      }
    }, 10);
  });
  window.addEventListener('selection-changed', (e) => updateSelectionPill(e.detail));
  const ui = document.getElementById('ui');
  if (ui) new ResizeObserver(() => { info.style.top = `${ui.offsetTop + ui.offsetHeight + 8}px`; }).observe(ui);

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
    paint: { 'fill-color': ['case', ['get', 'ok'], '#2e7d32', '#c62828'], 'fill-opacity': 0.35 } }, 'buildings-own');
  // buildings a green area would demolish (red), and the ones sinking away after applying
  const height = ['+', ['coalesce', ['get', 'render_height'], 8], 0.4];
  const base = ['coalesce', ['get', 'render_min_height'], 0];
  map.addSource('demolish-preview', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'demolish-preview', type: 'fill-extrusion', source: 'demolish-preview',
    paint: { 'fill-extrusion-color': '#e53935', 'fill-extrusion-height': height, 'fill-extrusion-base': base, 'fill-extrusion-opacity': 0.85 } });
  map.addSource('demolish-anim', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'demolish-anim', type: 'fill-extrusion', source: 'demolish-anim',
    paint: { 'fill-extrusion-color': '#e8e4dc', 'fill-extrusion-height': height, 'fill-extrusion-base': base, 'fill-extrusion-opacity': 0.9 } });
  map.addSource('brush-cursor', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'brush-cursor', type: 'line', source: 'brush-cursor', paint: { 'line-color': '#2e7d32', 'line-width': 2.5 } });

  map.addSource('carfree-hover', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'carfree-hover',
    type: 'line',
    source: 'carfree-hover',
    paint: {
      'line-color': '#2e7d32',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 8, 17, 16],
      'line-opacity': 0.6,
      'line-dasharray': [2, 1]
    }
  }, 'buildings-own');

  map.addSource('carfree-lines', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'carfree-lines-casing',
    type: 'line',
    source: 'carfree-lines',
    paint: {
      'line-color': '#1b5e20',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 20],
      'line-opacity': 0.85
    }
  }, 'buildings-own');

  map.addLayer({
    id: 'carfree-lines-fill',
    type: 'line',
    source: 'carfree-lines',
    paint: {
      'line-color': '#4caf50',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 7, 17, 15],
      'line-opacity': 0.9
    }
  }, 'buildings-own');

  map.addLayer({
    id: 'carfree-lines-center',
    type: 'line',
    source: 'carfree-lines',
    paint: {
      'line-color': '#e8f5e9',
      'line-width': 2,
      'line-dasharray': [3, 2]
    }
  }, 'buildings-own');

  setupGhosts();

  loadAreas();
  // the map geometry changes as tiles load, the view moves or buildings are deleted
  map.on('sourcedata', (e) => { if (e.sourceId === 'openmaptiles' && e.isSourceLoaded) geoDirty = true; });
  map.on('moveend', () => { geoDirty = true; hover = null; });
  window.addEventListener('scene-changed', () => { geoDirty = true; drawCarFreeState(); });
  map.on('idle', () => { if (geoDirty) rebuildGeo(); });
  fetch('trees.json').then((r) => r.json()).then((rows) => {
    const g = new Grid();
    for (const r of rows) { const p = toM([r[0], r[1]]); g.add(p, bboxOf([p])); }
    geo.trees = g;
  }).catch(() => {});
  drawState();
  drawCarFreeState();
  if (placeType() === 'building') updateBuildingPill();

  // mouse feedback, at most once per frame
  let queued = null;
  map.on('mousemove', (e) => {
    if (!queued) requestAnimationFrame(() => { const ev = queued; queued = null; onMove(ev); });
    queued = e;
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    hideGhost();
    if (brush) { endStroke(); map.getSource('brush-cursor').setData(EMPTY); }
    if (tool && !pending) { cursorM = null; hover = null; clearPreview(); drawState(); }
  });
  map.on('click', onClick);
  map.on('mousedown', (e) => {
    if (!brush || e.originalEvent.button !== 0) return;
    cursorM = toM([e.lngLat.lng, e.lngLat.lat]);
    startStroke(cursorM);
  });
  window.addEventListener('mouseup', endStroke);
  window.addEventListener('keydown', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (placeType() === 'building' && !tool && !brush) {
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        cycleBuildingLayout();
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        cycleRoofType();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        adjustBuilding({ rot: e.shiftKey ? -15 : 15 });
        return;
      }
      if (e.key === '[') {
        e.preventDefault();
        adjustBuilding({ rot: -15 });
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        adjustBuilding({ rot: 15 });
        return;
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        adjustBuilding({ dfl: 1 });
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        adjustBuilding({ dfl: -1 });
        return;
      }
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        adjustBuilding({ dw: e.shiftKey ? -2 : 2 });
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        adjustBuilding({ dd: e.shiftKey ? -2 : 2 });
        return;
      }
    }

    if (brush) {
      if (e.key === '[') resizeBrush(-5);
      if (e.key === ']') resizeBrush(5);
      if (e.key === 'Escape') stopBrush();
      return;
    }
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
    for (const id of ['green-areas-fill', 'green-areas-line', 'green-areas-corners', 'carfree-lines-fill', 'carfree-lines-casing', 'carfree-lines-center', 'carfree-hover'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', original ? 'none' : 'visible');
    btn.disabled = brushBtn.disabled = !!document.getElementById('btnTree')?.disabled;
    if (btnCarFree) btnCarFree.disabled = !!document.getElementById('btnTree')?.disabled;
    if (brushBtn.disabled && brush) stopBrush();
    const ids = map.getStyle().layers.map((l) => l.id);
    if (ids.includes('climate-overlay') && ids.indexOf('climate-overlay') > ids.indexOf('green-areas-fill'))
      for (const id of ['green-areas-fill', 'green-areas-line', 'placement-ghost', 'carfree-lines-fill', 'carfree-lines-casing', 'carfree-lines-center']) map.moveLayer(id, 'buildings-own');
  }, 250);
}

// Asked by index.html before placing a single tree or building. Shows the reason when refused.
window.placement = {
  spaceAt: (lngLat) => (ensureGeo(), spaceAt(toM(Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat]))), // for testing in the console
  check: (type, pt) => (ensureGeo(), check(type, Array.isArray(pt) ? pt : [pt.lng, pt.lat])),
  roadAt: (lngLat) => (ensureGeo(), roadAt(toM(Array.isArray(lngLat) ? lngLat : [lngLat.lng, lngLat.lat]))),
  convertRoadCarFree: (rdOrName) => {
    ensureGeo();
    let rd = typeof rdOrName === 'object' && rdOrName !== null ? rdOrName : null;
    if (!rd && typeof rdOrName === 'string') {
      for (const r of geo.roads.items) {
        let name = null;
        for (const pt of [r.m[Math.floor(r.m.length / 2)], r.m[0], r.m[r.m.length - 1]]) {
          name = streetName(pt);
          if (name) break;
        }
        if (name && name.toLowerCase().includes(rdOrName.toLowerCase())) {
          rd = roadAt(r.m[0]);
          break;
        }
      }
    }
    if (rd) applyCarFreeStreet(rd);
    return rd;
  },
  undoCarFree,
  resetAreas,
  cycleBuildingLayout,
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
