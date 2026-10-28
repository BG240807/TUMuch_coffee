// placement.js — where trees and buildings may go, a live green/red preview, and a "Green area" tool.
// Rules use the map data we already have: road/rail/water layers of the base map, our building
// footprints (window.__app.buildings) and the objects placed so far. Self-contained: index.html only
// exposes window.__app and asks window.placement.allow() before placing.
const MLAT = 111320;                       // metres per degree latitude
const TREE_GAP = 4;                        // m between placed trees
const BUILDING = { w: 14, d: 10, gap: 4 }; // footprint of a placed building (matches makeBuilding) + spacing
const AREA_SPACING = 9;                    // m between trees in a green area
const AREA_MAX_TREES = 400;
const ROAD_LAYERS = ['highway_minor', 'highway_major_casing', 'highway_major_inner', 'highway_major_subtle',
  'highway_motorway_casing', 'highway_motorway_inner', 'highway_motorway_subtle', 'highway_motorway_bridge_casing',
  'highway_motorway_bridge_inner', 'tunnel_motorway_casing', 'tunnel_motorway_inner', 'road_area_pier'];
const RAIL_LAYERS = ['railway', 'railway_dashline', 'railway_transit', 'railway_transit_dashline', 'railway_service', 'railway_service_dashline'];
const WATER_LAYERS = ['water', 'waterway'];
const GREEN_LAYERS = ['park', 'landcover_wood', 'landcover_grass'];
const STORE_KEY = 'heilbronn3d-green-areas';

let app, map;
const mLng = () => MLAT * Math.cos((map.getCenter().lat * Math.PI) / 180);
const dist = (a, b) => Math.hypot((a[0] - b[0]) * mLng(), (a[1] - b[1]) * MLAT);
const offset = ([lng, lat], dx, dy) => [lng + dx / mLng(), lat + dy / MLAT];

function pointInRing(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (pt, poly) => pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h));

// ---------- rules ----------
const existing = (ids) => ids.filter((id) => map.getLayer(id));
function layerHit(lngLat, ids) {
  const p = map.project(lngLat);
  return map.queryRenderedFeatures([[p.x - 1, p.y - 1], [p.x + 1, p.y + 1]], { layers: existing(ids) }).length > 0;
}
function inBuilding(pt) {
  for (const b of app.buildings.values()) {
    const [x0, y0, x1, y1] = b.bbox;
    if (pt[0] < x0 || pt[0] > x1 || pt[1] < y0 || pt[1] > y1) continue;
    if (inPoly(pt, b.poly) && !app.isDeleted(b)) return true;
  }
  return false;
}
const near = (pt, type, m) => app.placed.some((p) => p.type === type && dist(pt, [p.lng, p.lat]) < m);
const buildingCorners = (pt) => [[0, 0], [-7, -5], [7, -5], [7, 5], [-7, 5], [0, -5], [0, 5], [-7, 0], [7, 0]]
  .map(([dx, dy]) => offset(pt, dx * BUILDING.w / 14, dy * BUILDING.d / 10));

// Returns null if allowed, otherwise a short reason.
function check(type, pt) {
  if (type === 'tree') {
    if (layerHit(pt, WATER_LAYERS)) return 'in water';
    if (layerHit(pt, RAIL_LAYERS)) return 'on a railway';
    if (layerHit(pt, ROAD_LAYERS)) return 'on a road';
    if (inBuilding(pt)) return 'inside a building';
    if (near(pt, 'building', 9)) return 'inside a new building';
    if (near(pt, 'tree', TREE_GAP)) return 'too close to another tree';
    return null;
  }
  if (type === 'building') {
    const corners = buildingCorners(pt);
    if (corners.some((c) => layerHit(c, WATER_LAYERS))) return 'in water';
    if (corners.some((c) => layerHit(c, RAIL_LAYERS))) return 'on a railway';
    if (corners.some((c) => layerHit(c, ROAD_LAYERS))) return 'on a road';
    if (corners.some(inBuilding)) return 'overlaps a building';
    if (corners.some((c) => layerHit(c, GREEN_LAYERS))) return 'in a park or forest';
    if (near(pt, 'building', Math.hypot(BUILDING.w, BUILDING.d) + BUILDING.gap)) return 'too close to a new building';
    if (near(pt, 'tree', 8)) return 'on a new tree';
    return null;
  }
  return null;
}

// ---------- preview under the mouse ----------
const EMPTY = { type: 'FeatureCollection', features: [] };
let tip;
function circle(pt, r, n = 20) {
  const ring = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; ring.push(offset(pt, r * Math.cos(a), r * Math.sin(a))); }
  return ring;
}
const rect = (pt) => [[-7, -5], [7, -5], [7, 5], [-7, 5], [-7, -5]].map(([dx, dy]) => offset(pt, dx, dy));
function showGhost(type, pt, reason, point) {
  const ring = type === 'tree' ? circle(pt, 3) : rect(pt);
  map.getSource('placement-ghost').setData({ type: 'Feature', properties: { ok: !reason },
    geometry: { type: 'Polygon', coordinates: [ring] } });
  tip.style.display = 'block';
  tip.style.left = `${point.x + 14}px`;
  tip.style.top = `${point.y - 34}px`; // above the cursor; the climate layer's tooltip sits below it
  tip.className = reason ? 'no' : 'ok';
  tip.textContent = reason ? `✗ Not here: ${reason}` : type === 'tree' ? '✓ Plant tree here' : '✓ Build here';
}
function hideGhost() {
  map.getSource('placement-ghost')?.setData(EMPTY);
  if (tip) tip.style.display = 'none';
}
const activeTool = () => document.querySelector('#ui button.active')?.id;
const placeType = () => ({ btnTree: 'tree', btnBuilding: 'building' })[activeTool()];

// ---------- green area tool ----------
let drawing = null;         // [[lng, lat], ...] while drawing
let areas = [];             // [{ ring, objs: [placed entries] , m2 }]
let btn, info;

function areaM2(ring) {
  let a = 0;
  const o = ring[0];
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = (ring[i][0] - o[0]) * mLng(), y1 = (ring[i][1] - o[1]) * MLAT;
    const x2 = (ring[i + 1][0] - o[0]) * mLng(), y2 = (ring[i + 1][1] - o[1]) * MLAT;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}
function drawState() {
  const features = areas.map((a) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [a.ring] } }));
  if (drawing && drawing.length) {
    const ring = [...drawing, drawing[0]];
    features.push({ type: 'Feature', properties: { draft: true },
      geometry: drawing.length > 2 ? { type: 'Polygon', coordinates: [ring] } : { type: 'LineString', coordinates: ring } });
  }
  map.getSource('green-areas').setData({ type: 'FeatureCollection', features });
}
function say(html) { info.innerHTML = html; info.style.display = html ? 'block' : 'none'; }

function startArea() {
  if (document.getElementById('btnTree')?.disabled) return; // e.g. "Original" view of the scenario comparison
  document.getElementById('btnNav').click();              // index.html stops placing single objects
  document.querySelectorAll('#ui button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  drawing = [];
  map.doubleClickZoom.disable();
  map.getCanvas().style.cursor = 'crosshair';
  say('<b>Green area</b>: click the corners of the area. Click the first corner or press Enter to finish, Esc to cancel.');
}
function stopArea() {
  drawing = null;
  map.doubleClickZoom.enable();
  map.getCanvas().style.cursor = '';
  btn.classList.remove('active');
  drawState();
}
function finishArea() {
  if (!drawing || drawing.length < 3) { say('Add at least 3 corners.'); return; }
  const ring = [...drawing, drawing[0]];
  const poly = [ring];
  // grid of candidate spots with a little jitter so it doesn't look like a plantation
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = AREA_SPACING / mLng(), sy = AREA_SPACING / MLAT;
  const objs = [];
  let skipped = 0;
  for (let y = y0 + sy / 2; y < y1 && objs.length < AREA_MAX_TREES; y += sy) {
    for (let x = x0 + sx / 2; x < x1 && objs.length < AREA_MAX_TREES; x += sx) {
      const pt = [x + (Math.random() - 0.5) * sx * 0.4, y + (Math.random() - 0.5) * sy * 0.4];
      if (!inPoly(pt, poly)) continue;
      if (check('tree', pt)) { skipped++; continue; }
      app.addObject('tree', pt[0], pt[1]);
      objs.push(app.placed[app.placed.length - 1]);
    }
  }
  const m2 = areaM2(ring);
  areas.push({ ring, objs, m2 });
  stopArea();
  app.updateCount();
  app.saveSession();
  saveAreas();
  say(`<b>Green area</b>: ${Math.round(m2).toLocaleString('en')} m² · ${objs.length} trees planted` +
    (skipped ? ` · ${skipped} spots skipped (road, water, building or existing tree)` : '') +
    ' <button id="pl-undo-area">Undo area</button>');
  document.getElementById('pl-undo-area').onclick = undoArea;
}
function undoArea() {
  const a = areas.pop();
  if (!a) return;
  for (const o of a.objs) {
    const i = app.placed.indexOf(o);
    if (i >= 0) { app.scene.remove(o.obj); app.placed.splice(i, 1); }
  }
  drawState();
  app.updateCount();
  app.saveSession();
  saveAreas();
  say('');
}

// Areas are remembered like the placed trees (the trees themselves are restored by index.html).
function saveAreas() {
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(areas.map((a) => ({ ring: a.ring, m2: a.m2 })))); } catch { /* ignore */ }
}
function loadAreas() {
  try { areas = (JSON.parse(sessionStorage.getItem(STORE_KEY)) || []).map((a) => ({ ...a, objs: [] })); } catch { areas = []; }
}

// ---------- setup ----------
const CSS = `
#pl-tip{position:fixed;z-index:5;pointer-events:none;display:none;padding:4px 8px;border-radius:6px;
 font:12px/1.3 system-ui,-apple-system,sans-serif;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)}
#pl-tip.ok{background:rgba(46,125,50,.92)} #pl-tip.no{background:rgba(183,28,28,.92)}
#pl-info{position:absolute;left:50%;bottom:170px;transform:translateX(-50%);z-index:3;display:none;max-width:min(520px,calc(100vw - 40px));
 padding:8px 12px;border-radius:10px;background:rgba(255,255,255,.92);box-shadow:0 2px 10px rgba(0,0,0,.18);
 font:12px/1.4 system-ui,-apple-system,sans-serif;color:#1f2933}
#pl-info button{margin-left:6px;font:12px system-ui,sans-serif;border:1px solid rgba(0,0,0,.2);background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer}`;

function init() {
  app = window.__app;
  map = app.map;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  tip = Object.assign(document.createElement('div'), { id: 'pl-tip' });
  info = Object.assign(document.createElement('div'), { id: 'pl-info' });
  document.body.append(tip, info);

  btn = Object.assign(document.createElement('button'), { id: 'btnGreenArea', textContent: '🌳 Green area', title: 'Draw an area and fill it with trees' });
  const after = document.getElementById('btnBuilding');
  after.after(btn);
  btn.addEventListener('click', () => (drawing ? stopArea() : startArea()));
  // any other tool cancels drawing
  document.querySelectorAll('#ui button').forEach((b) => b !== btn && b.addEventListener('click', () => { if (drawing) stopArea(); say(''); }));

  map.addSource('green-areas', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'green-areas-fill', type: 'fill', source: 'green-areas', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#7cc576', 'fill-opacity': ['case', ['has', 'draft'], 0.25, 0.45] } }, 'buildings-3d');
  map.addLayer({ id: 'green-areas-line', type: 'line', source: 'green-areas',
    paint: { 'line-color': '#2e7d32', 'line-width': 2, 'line-dasharray': [2, 1] } }, 'buildings-3d');
  map.addSource('placement-ghost', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'placement-ghost', type: 'fill', source: 'placement-ghost',
    paint: { 'fill-color': ['case', ['get', 'ok'], '#2e7d32', '#c62828'], 'fill-opacity': 0.55 } });

  loadAreas();
  drawState();

  map.on('mousemove', (e) => {
    const type = placeType();
    if (!type || drawing) return hideGhost();
    showGhost(type, [e.lngLat.lng, e.lngLat.lat], check(type, [e.lngLat.lng, e.lngLat.lat]), e.point);
  });
  map.getCanvas().addEventListener('mouseleave', hideGhost);
  map.on('click', (e) => {
    if (!drawing) return;
    const pt = [e.lngLat.lng, e.lngLat.lat];
    if (drawing.length >= 3 && dist(pt, drawing[0]) < 6) return finishArea();
    drawing.push(pt);
    drawState();
  });
  window.addEventListener('keydown', (e) => {
    if (!drawing) return;
    if (e.key === 'Enter') { e.preventDefault(); finishArea(); }
    if (e.key === 'Escape') { stopArea(); say(''); }
  });
  // hide the green areas in the "Original" view of the scenario comparison, and keep them above
  // the climate layer's colour overlay (it may be added after us)
  setInterval(() => {
    const ids = map.getStyle().layers.map((l) => l.id);
    if (ids.includes('climate-overlay') && ids.indexOf('climate-overlay') > ids.indexOf('green-areas-fill')) {
      map.moveLayer('green-areas-fill', 'buildings-own');
      map.moveLayer('green-areas-line', 'buildings-own');
    }
    const original = document.querySelector('#comparison-card button[aria-pressed="true"]')?.textContent === 'Original';
    if (map.getLayer('green-areas-fill')) {
      map.setLayoutProperty('green-areas-fill', 'visibility', original ? 'none' : 'visible');
      map.setLayoutProperty('green-areas-line', 'visibility', original ? 'none' : 'visible');
    }
    btn.disabled = !!document.getElementById('btnTree')?.disabled;
  }, 250);
}

// Asked by index.html before placing a single tree or building. Shows the reason when refused.
window.placement = {
  allow(type, e) {
    if (!map) return true;
    const reason = check(type, [e.lngLat.lng, e.lngLat.lat]);
    if (reason) showGhost(type, [e.lngLat.lng, e.lngLat.lat], reason, e.point);
    return !reason;
  }
};

if (window.__app?.ready) init();
else window.addEventListener('app-ready', init, { once: true });
