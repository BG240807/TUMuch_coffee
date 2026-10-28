// placement.js — where trees and buildings may go, a live green/red preview, and a "Green area" drawing tool.
// Rules are checked against real map geometry (roads, rails, water, parks from the base map's vector tiles,
// our building footprints, the cadastre trees and the objects placed so far), in metres, so they behave the
// same at any zoom or tilt. index.html only exposes window.__app and asks window.placement.allow().
const MLAT = 111320;                       // metres per degree latitude
const TREE_GAP = 4;                        // m between new trees
const CADASTRE_GAP = 3;                    // m to an existing (cadastre) tree
const BUILDING = { w: 14, d: 10 };         // footprint of a placed building (matches makeBuilding in index.html)
const AREA_SPACING = 9;                    // m between trees in a green area
const AREA_MAX_TREES = 600;
// Half width in metres of what counts as "the road" (carriageway). Footways, paths, cycleways, tracks and
// parking aisles are not listed, so trees and green areas may go there.
const ROAD_HALF = { motorway: 12, trunk: 10, primary: 8, secondary: 7, tertiary: 6, minor: 4, service: 3, busway: 4 };
const RAIL_HALF = { rail: 3, transit: 2.5 };
const WATERWAY_HALF = 3;
const GREEN_LANDCOVER = new Set(['wood', 'grass']);
const STORE_KEY = 'heilbronn3d-green-areas';
const CELL = 40;                           // m, spatial grid for the map geometry

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
  for (const f of src('transportation')) {
    const p = f.properties;
    if (p.brunnel === 'tunnel') continue;                       // underground
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
  const addArea = (f, kind) => {
    for (const poly of polyList(f.geometry)) {
      const m = poly.map((r) => r.map(toM));
      g.areas.add({ poly: m, kind }, bboxOf(m[0]));
    }
  };
  for (const f of src('water')) addArea(f, 'water');
  for (const f of src('park')) addArea(f, 'park');
  for (const f of src('landcover')) if (GREEN_LANDCOVER.has(f.properties.class)) addArea(f, f.properties.class === 'wood' ? 'forest' : 'park');
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
  return null;
}
// a point inside a footprint (vertex average, or a point between it and a corner)
function footprintPoint(poly) {
  const r = poly[0], n = r.length - 1;
  const c = [r.slice(0, n).reduce((s, p) => s + p[0], 0) / n, r.slice(0, n).reduce((s, p) => s + p[1], 0) / n];
  if (inPoly(c, poly)) return c;
  return r.slice(0, n).map((v) => [(v[0] + c[0]) / 2, (v[1] + c[1]) / 2]).find((q) => inPoly(q, poly)) || r[0];
}
// what a green area would do: demolish buildings whose middle is inside, replace placed objects, plant trees
function areaPlan(ring) {
  const poly = [ring];
  const houses = geo.houses.near(bboxOf(ring)).filter((h) => !app.isDeleted(h.b) && inPoly(footprintPoint(h.poly), poly));
  const objs = app.placed.filter((o) => inPoly(toM([o.lng, o.lat]), poly));
  const demolish = new Set(houses.map((h) => h.poly));
  const spots = [];
  const [x0, y0, x1, y1] = bboxOf(ring);
  for (let y = y0 + AREA_SPACING / 2; y < y1 && spots.length < AREA_MAX_TREES; y += AREA_SPACING) {
    for (let x = x0 + AREA_SPACING / 2; x < x1 && spots.length < AREA_MAX_TREES; x += AREA_SPACING) {
      // a little jitter so it doesn't look like a plantation
      const p = [x + (Math.random() - 0.5) * AREA_SPACING * 0.4, y + (Math.random() - 0.5) * AREA_SPACING * 0.4];
      if (!inPoly(p, poly) || lineAt(p, 1) || areaAt(p, 'water') || cadastreNear(p, CADASTRE_GAP)) continue;
      const h = houseAt(p);
      if (h && !demolish.has(h.poly)) continue; // a building that stays (only partly inside)
      spots.push(p);
    }
  }
  return { houses, objs, spots, m2: areaM2(ring) };
}

// ---------- UI: preview under the mouse ----------
const EMPTY = { type: 'FeatureCollection', features: [] };
let tip, info, btn;
function setTip(text, ok, point) {
  if (!text) { tip.style.display = 'none'; return; }
  tip.style.display = 'block';
  tip.style.left = `${point.x + 14}px`;
  tip.style.top = `${point.y - 34}px`; // above the cursor; the climate layer's tooltip sits below it
  tip.className = ok ? 'ok' : 'no';
  tip.textContent = text;
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
let drawing = null;   // corners in metres while drawing
let cursorM = null;   // mouse position in metres while drawing
let pending = null;   // { ring, plan } waiting for OK
let areas = [];       // [{ ring (lng/lat), m2, demolished: [[lng,lat]], removed: [{type,lng,lat}], trees: [[lng,lat]] }]

function draftRing() {
  const pts = cursorM ? [...drawing, cursorM] : drawing;
  return pts.length >= 3 ? [...pts, pts[0]] : null;
}
// redraws the areas and the drawing; returns the reason the drawing is not allowed (or null)
function drawState() {
  const features = areas.map((a) => ({ type: 'Feature', properties: { state: 'done' }, geometry: { type: 'Polygon', coordinates: [a.ring] } }));
  let bad = null;
  if (drawing || pending) {
    const ring = pending ? pending.ring : draftRing();
    const pts = drawing ? (cursorM ? [...drawing, cursorM] : drawing) : [];
    if (ring) bad = checkArea(ring);
    else if (pts.length === 2) bad = checkArea([pts[0], pts[1], pts[0]]);
    const state = pending ? 'pending' : bad ? 'bad' : 'ok';
    if (ring) features.push({ type: 'Feature', properties: { state }, geometry: { type: 'Polygon', coordinates: [ring.map(toLL)] } });
    else if (pts.length >= 2) features.push({ type: 'Feature', properties: { state }, geometry: { type: 'LineString', coordinates: pts.map(toLL) } });
    for (const p of drawing || []) features.push({ type: 'Feature', properties: { state }, geometry: { type: 'Point', coordinates: toLL(p) } });
  }
  map.getSource('green-areas').setData({ type: 'FeatureCollection', features });
  return bad;
}
function startArea() {
  if (document.getElementById('btnTree')?.disabled) return; // e.g. "Original" view of the scenario comparison
  document.getElementById('btnNav').click();              // index.html stops placing single objects
  document.querySelectorAll('#ui button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  ensureGeo();
  drawing = [];
  cursorM = null;
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  say('<b>Green area</b>: click the corners, then click the first corner or press Enter. Esc cancels, Backspace removes a corner. ' +
    'Buildings inside are demolished; the area may not cross a road, railway or water.');
}
function stopArea() {
  drawing = null;
  cursorM = null;
  pending = null;
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = '';
  btn.classList.remove('active');
  setTip(null);
  // always leave a normal tool active (the scenario comparison restores "the previous tool")
  if (!document.querySelector('#ui button.active')) document.getElementById('btnNav').click();
  drawState();
}
function finishArea() {
  if (!drawing || drawing.length < 3) { say('<b>Green area</b>: add at least 3 corners.'); return; }
  cursorM = null;
  const ring = [...drawing, drawing[0]];
  const bad = checkArea(ring);
  if (bad) {
    drawState();
    say(`<b>Green area</b>: ✗ not possible, the area ${bad}. Move the corners off it (Backspace removes the last corner).`);
    return;
  }
  const plan = areaPlan(ring);
  pending = { ring, plan };
  drawing = null;
  setTip(null);
  drawState();
  const parts = [`<b>Green area</b> ${Math.round(plan.m2).toLocaleString('en')} m²: plant ${plan.spots.length} trees`];
  if (plan.houses.length) parts.push(`demolish ${plan.houses.length} building${plan.houses.length > 1 ? 's' : ''}`);
  if (plan.objs.length) parts.push(`replace ${plan.objs.length} placed object${plan.objs.length > 1 ? 's' : ''}`);
  say(`${parts.join(', ')}? <button id="pl-ok">OK</button><button id="pl-cancel">Cancel</button>`);
  document.getElementById('pl-ok').onclick = applyArea;
  document.getElementById('pl-cancel').onclick = () => { stopArea(); say(''); };
}
function applyArea() {
  const { ring, plan } = pending;
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
  for (const p of plan.spots) {
    const [lng, lat] = toLL(p);
    app.addObject('tree', lng, lat);
    area.trees.push([lng, lat]);
  }
  areas.push(area);
  app.refreshBuildings();
  geoDirty = true;
  stopArea();
  app.updateCount();
  app.saveSession();
  saveAreas();
  say(`<b>Green area</b>: ${Math.round(area.m2).toLocaleString('en')} m² · ${area.trees.length} trees planted` +
    (area.demolished.length ? ` · ${area.demolished.length} buildings demolished` : '') +
    ' <button id="pl-undo-area">Undo area</button>');
  document.getElementById('pl-undo-area').onclick = undoArea;
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
  drawState();
  app.updateCount();
  app.saveSession();
  saveAreas();
  say(areas.length ? '<button id="pl-undo-area">Undo previous area</button>' : '');
  document.getElementById('pl-undo-area')?.addEventListener('click', undoArea);
}
function saveAreas() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(areas)); } catch { /* ignore */ } }
function loadAreas() {
  try { areas = (JSON.parse(sessionStorage.getItem(STORE_KEY)) || []).filter((a) => a.trees); } catch { areas = []; }
}

// ---------- setup ----------
const CSS = `
#pl-tip{position:fixed;z-index:5;pointer-events:none;display:none;padding:4px 8px;border-radius:6px;
 font:12px/1.3 system-ui,-apple-system,sans-serif;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);white-space:nowrap}
#pl-tip.ok{background:rgba(46,125,50,.92)} #pl-tip.no{background:rgba(183,28,28,.92)}
#pl-info{position:absolute;left:50%;bottom:170px;transform:translateX(-50%);z-index:3;display:none;max-width:min(560px,calc(100vw - 40px));
 padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.94);box-shadow:0 2px 10px rgba(0,0,0,.18);
 font:12px/1.45 system-ui,-apple-system,sans-serif;color:#1f2933}
#pl-info button{margin-left:6px;font:12px system-ui,sans-serif;border:1px solid rgba(0,0,0,.2);background:#fff;border-radius:6px;padding:2px 10px;cursor:pointer}
#pl-info #pl-ok{background:#2e7d32;border-color:#2e7d32;color:#fff}`;

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
    title: 'Draw an area: buildings inside are demolished and trees planted' });
  document.getElementById('btnBuilding').after(btn);
  btn.addEventListener('click', () => (drawing || pending ? (stopArea(), say('')) : startArea()));
  // any other tool cancels drawing
  document.querySelectorAll('#ui button').forEach((b) => b !== btn && b.addEventListener('click', () => {
    if (drawing || pending) { stopArea(); say(''); }
  }));

  map.addSource('green-areas', { type: 'geojson', data: EMPTY });
  const colour = ['match', ['get', 'state'], 'bad', '#c62828', 'pending', '#f9a825', '#2e7d32'];
  map.addLayer({ id: 'green-areas-fill', type: 'fill', source: 'green-areas', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['match', ['get', 'state'], 'done', '#7cc576', colour],
      'fill-opacity': ['match', ['get', 'state'], 'done', 0.45, 0.3] } }, 'buildings-own');
  map.addLayer({ id: 'green-areas-line', type: 'line', source: 'green-areas', filter: ['!=', ['geometry-type'], 'Point'],
    paint: { 'line-color': colour, 'line-width': ['match', ['get', 'state'], 'done', 1.5, 3], 'line-dasharray': [2, 1] } }, 'buildings-own');
  map.addLayer({ id: 'green-areas-corners', type: 'circle', source: 'green-areas', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-width': 2, 'circle-stroke-color': colour } });
  map.addSource('placement-ghost', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'placement-ghost', type: 'fill', source: 'placement-ghost',
    paint: { 'fill-color': ['case', ['get', 'ok'], '#2e7d32', '#c62828'], 'fill-opacity': 0.55 } }, 'buildings-own');

  loadAreas();
  // the map geometry changes as tiles load, the view moves or buildings are deleted
  map.on('sourcedata', (e) => { if (e.sourceId === 'openmaptiles' && e.isSourceLoaded) geoDirty = true; });
  map.on('moveend', () => { geoDirty = true; });
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
    if (!queued) requestAnimationFrame(() => {
      const ev = queued; queued = null;
      const pt = [ev.lngLat.lng, ev.lngLat.lat];
      if (drawing) {
        ensureGeo();
        cursorM = toM(pt);
        const bad = drawState();
        const closing = drawing.length >= 3 && distM(cursorM, drawing[0]) < 6;
        setTip(bad ? `✗ Area ${bad}` : closing ? '✓ Click to finish' : drawing.length ? '✓ Click to add a corner' : 'Click the first corner', !bad, ev.point);
        return;
      }
      const type = placeType();
      if (!type) return hideGhost();
      showGhost(type, pt, check(type, pt), ev.point);
    });
    queued = e;
  });
  map.getCanvas().addEventListener('mouseleave', () => { hideGhost(); if (drawing) { cursorM = null; drawState(); } });
  map.on('click', (e) => {
    if (!drawing) return;
    const p = toM([e.lngLat.lng, e.lngLat.lat]);
    if (drawing.length >= 3 && distM(p, drawing[0]) < 6) return finishArea();
    drawing.push(p);
    drawState();
  });
  window.addEventListener('keydown', (e) => {
    if (pending && e.key === 'Escape') { stopArea(); say(''); return; }
    if (!drawing) return;
    if (e.key === 'Enter') { e.preventDefault(); finishArea(); }
    if (e.key === 'Escape') { stopArea(); say(''); }
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
