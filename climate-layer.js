// climate-layer.js — local temperature / pollution / humidity layers + rain & snow for the Heilbronn map.
// Illustrative heuristic model: values come from land use (buildings, trees, parks, water, roads, elevation),
// not from measurements. City-wide base values come from Open-Meteo.
const N = 100;                 // grid cells per side
const HALF = 1000;             // metres from grid centre to edge
const CELL = (2 * HALF) / N;   // 20 m cells
const MLAT = 111320;           // metres per degree latitude
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);

const SCEN = {
  live: { T: 12, rh: 65, pm: 8, precip: 0 },
  heat: { T: 34, rh: 35, pm: 9, precip: 0 },
  snow: { T: -2, rh: 88, pm: 14, precip: 2.5 },
  rain: { T: 11, rh: 92, pm: 5, precip: 4 }
};
const KEY = { temp: 'T', pm: 'PM', rh: 'RH' };
const STOPS = {
  T: [[0, [49, 104, 189]], [.25, [120, 178, 222]], [.45, [255, 247, 200]], [.65, [255, 190, 80]], [.85, [230, 80, 40]], [1, [150, 0, 20]]],
  PM: [[0, [120, 200, 130]], [.3, [240, 225, 100]], [.55, [240, 150, 50]], [.8, [160, 30, 30]], [1, [10, 10, 10]]],
  RH: [[0, [247, 244, 235]], [.5, [150, 200, 230]], [1, [20, 70, 160]]]
};
const MIN_SPAN = { T: 3, PM: 4, RH: 10 };
const MIN_DELTA = { T: 0.02, PM: 0.05, RH: 0.1 };
const ROAD_W = { motorway: 1, trunk: 0.9, primary: 0.7, secondary: 0.5, tertiary: 0.35, minor: 0.12, service: 0.05 };

let app, map, g, S, U, F, R, trees = [];
let mode = 'temp', scen = 'live', deltaOnly = false, fxOn = true;

const CSS = `
#cl-panel{position:absolute;top:148px;right:54px;z-index:2;width:240px;padding:12px 14px;box-sizing:border-box;
 background:rgba(255,255,255,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-radius:14px;
 border:1px solid rgba(15,23,42,.08);box-shadow:0 4px 20px rgba(15,23,42,.12);font:12px/1.35 system-ui,-apple-system,sans-serif;color:#1f2a30}
#cl-panel .cl-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px}
#cl-panel button{font:500 12px system-ui,-apple-system,sans-serif;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.8);color:#1f2a30;border-radius:7px;padding:5px 8px;cursor:pointer;transition:background .15s,color .15s}
#cl-panel button:hover:not(.on){background:rgba(15,23,42,.05)}
#cl-panel button.on{background:#1f2a30;color:#fff;border-color:#1f2a30}
#cl-panel #cl-min{width:20px;height:20px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:5px}
#cl-panel .cl-modes{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px}
#cl-panel .cl-row{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;color:#475569;font-weight:500}
#cl-panel select{font:500 12px system-ui,-apple-system,sans-serif;padding:5px 7px;border-radius:7px;border:1px solid rgba(15,23,42,.15);background:#fff;color:#1f2a30}
#cl-panel .cl-chk{display:flex;gap:7px;align-items:center;margin:4px 0;color:#334155}
#cl-bar{height:8px;border-radius:999px;margin-top:8px;border:1px solid rgba(15,23,42,.1)}
#cl-panel .cl-bar-l{display:flex;justify-content:space-between;color:#64748b;font-size:10.5px;margin-top:3px}
#cl-edits{margin-top:8px;padding-top:8px;border-top:1px solid rgba(15,23,42,.08);font-size:11.5px;display:flex;flex-direction:column;gap:2px}
#cl-edits div{display:flex;justify-content:space-between;gap:6px}
#cl-panel .cl-note{margin-top:6px;color:#94a3b8;font-size:10.5px}
#cl-tip{position:fixed;z-index:4;pointer-events:none;display:none;background:rgba(15,23,42,.92);color:#fff;padding:6px 9px;border-radius:8px;font:12px/1.35 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.2)}
#cl-tip span{color:#ffd9a0}
#cl-fx{position:fixed;inset:0;z-index:0;pointer-events:none}
@media (max-width: 760px){#cl-panel{display:none}}
`;

/* ---------------- geometry helpers ---------------- */
const idx = (lng, lat) => {
  const i = Math.floor(((lng - g.lng) * g.mLng) / CELL + N / 2);
  const j = Math.floor(((g.lat - lat) * MLAT) / CELL + N / 2);
  return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i;
};
const cellLL = (i, j) => [g.lng + ((i + 0.5 - N / 2) * CELL) / g.mLng, g.lat - ((j + 0.5 - N / 2) * CELL) / MLAT];
const coords = () => {
  const dLat = HALF / MLAT, dLng = HALF / g.mLng;
  return [[g.lng - dLng, g.lat + dLat], [g.lng + dLng, g.lat + dLat], [g.lng + dLng, g.lat - dLat], [g.lng - dLng, g.lat - dLat]];
};
function ringAreaM2(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = (ring[i][0] - g.lng) * g.mLng, y1 = (ring[i][1] - g.lat) * MLAT;
    const x2 = (ring[i + 1][0] - g.lng) * g.mLng, y2 = (ring[i + 1][1] - g.lat) * MLAT;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}
function pointInRing(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (pt, poly) => pointInRing(pt, poly[0]) && !poly.slice(1).some(h => pointInRing(pt, h));

function rasterPoly(poly, arr) {
  const ring = poly[0];
  if (!ring || ring.length < 4) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const i0 = Math.max(0, Math.floor(((x0 - g.lng) * g.mLng) / CELL + N / 2));
  const i1 = Math.min(N - 1, Math.floor(((x1 - g.lng) * g.mLng) / CELL + N / 2));
  const j0 = Math.max(0, Math.floor(((g.lat - y1) * MLAT) / CELL + N / 2));
  const j1 = Math.min(N - 1, Math.floor(((g.lat - y0) * MLAT) / CELL + N / 2));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (inPoly(cellLL(i, j), poly)) arr[j * N + i] = 1;
  }
}
function fillFeature(f, arr) {
  const gm = f.geometry;
  const polys = gm.type === 'Polygon' ? [gm.coordinates] : gm.type === 'MultiPolygon' ? gm.coordinates : [];
  polys.forEach(p => rasterPoly(p, arr));
}
function blur(a, r, passes) {
  let src = Float32Array.from(a);
  const tmp = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let d = -r; d <= r; d++) { const x = i + d; if (x < 0 || x >= N) continue; s += src[j * N + x]; c++; }
      tmp[j * N + i] = s / c;
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let d = -r; d <= r; d++) { const y = j + d; if (y < 0 || y >= N) continue; s += tmp[y * N + i]; c++; }
      src[j * N + i] = s / c;
    }
  }
  return src;
}

/* ---------------- static layers (change only when the view moves / tiles load) ---------------- */
function buildStatic() {
  const c = map.getCenter();
  g = { lng: c.lng, lat: c.lat, mLng: MLAT * Math.cos((c.lat * Math.PI) / 180) };
  const M = N * N, z = () => new Float32Array(M);
  S = { built: z(), canopy: z(), green: z(), water: z(), traffic: z(), elev: z(), bList: [], meanElev: 0 };

  // buildings (polygons collected by index.html)
  for (const b of app.buildings.values()) {
    const k = idx((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2);
    if (k < 0) continue;
    const a = ringAreaM2(b.poly[0]);
    S.built[k] += a;
    S.bList.push({ k, a, b });
  }
  // tree cadastre: crown area per cell
  for (const r of trees) {
    const k = idx(r[0], r[1]);
    if (k < 0) continue;
    const crown = Math.min(r[3] > 0 ? r[3] : 3, 12);
    S.canopy[k] += Math.PI * (crown / 2) ** 2;
  }
  // land cover + water from the vector tiles
  const q = (layer) => { try { return map.querySourceFeatures('openmaptiles', { sourceLayer: layer }); } catch { return []; } };
  q('park').forEach(f => fillFeature(f, S.green));
  q('landcover').forEach(f => { if (['wood', 'grass', 'farmland', 'wetland'].includes(f.properties.class)) fillFeature(f, S.green); });
  q('water').forEach(f => fillFeature(f, S.water));
  // roads -> traffic proxy (weighted road length per cell)
  q('transportation').forEach(f => {
    const w = ROAD_W[f.properties.class];
    if (!w) return;
    const gm = f.geometry;
    const lines = gm.type === 'LineString' ? [gm.coordinates] : gm.type === 'MultiLineString' ? gm.coordinates : [];
    for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) {
      const a = ln[i], b = ln[i + 1];
      const len = Math.hypot((b[0] - a[0]) * g.mLng, (b[1] - a[1]) * MLAT);
      const steps = Math.max(1, Math.ceil(len / 10));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const k = idx(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        if (k >= 0) S.traffic[k] += (w * len) / steps;
      }
    }
  });
  // terrain height (for the cooling with altitude)
  let sum = 0, cnt = 0;
  const miss = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let e = null;
    try { e = map.queryTerrainElevation(cellLL(i, j)); } catch { /* terrain not ready */ }
    const k = j * N + i;
    if (e == null) miss.push(k); else { S.elev[k] = e; sum += e; cnt++; }
  }
  S.meanElev = cnt ? sum / cnt : 0;
  miss.forEach(k => { S.elev[k] = S.meanElev; });

  S.greenB = blur(S.green, 1, 2);
  S.waterB = blur(S.water, 1, 2);
  const tn = new Float32Array(M);
  for (let k = 0; k < M; k++) tn[k] = clamp(S.traffic[k] / CELL, 0, 1.5);
  S.trafB = blur(tn, 2, 2);
}

/* ---------------- user edits ---------------- */
function buildUser() {
  const M = N * N;
  U = { built: new Float32Array(M), removed: new Float32Array(M), canopy: new Float32Array(M), nTrees: 0, nBuild: 0, nRemoved: 0 };
  for (const p of app.placed) {
    const k = idx(p.lng, p.lat);
    if (p.type === 'tree') { U.nTrees++; if (k >= 0) U.canopy[k] += Math.PI * (3 * (p.obj.userData.s || 1)) ** 2; }
    else { U.nBuild++; if (k >= 0) U.built[k] += 140; } // 14 m x 10 m footprint
  }
  if (app.deleted.length) {
    for (const e of S.bList) if (app.isDeleted(e.b)) { U.removed[e.k] += e.a; U.nRemoved++; }
  }
}

/* ---------------- the model ---------------- */
function field(sc, withUser) {
  const area = CELL * CELL, M = N * N;
  const sealed = new Float32Array(M), canopy = new Float32Array(M);
  for (let k = 0; k < M; k++) {
    let b = S.built[k], c = S.canopy[k];
    if (withUser) { b += U.built[k] - U.removed[k]; c += U.canopy[k]; }
    sealed[k] = clamp((b / area) * 1.8, 0, 1);
    canopy[k] = clamp(c / area, 0, 1);
  }
  const sealedB = blur(sealed, 1, 2), canopyB = blur(canopy, 1, 2);
  const T = new Float32Array(M), PM = new Float32Array(M), RH = new Float32Array(M);
  for (let k = 0; k < M; k++) {
    const veg = clamp(canopyB[k] + 0.5 * S.greenB[k], 0, 1);
    T[k] = sc.T + 4.5 * sealedB[k] - 3.5 * veg - 1.8 * S.waterB[k] - 0.0065 * (S.elev[k] - S.meanElev);
    PM[k] = Math.max(0.3 * sc.pm, sc.pm * (0.75 + 0.9 * S.trafB[k] + 0.35 * sealedB[k]) * (1 - 0.4 * veg));
    RH[k] = clamp(sc.rh - 2 * (T[k] - sc.T) + 6 * veg + 8 * S.waterB[k], 15, 100);
  }
  return { T, PM, RH };
}
function computeRanges() {
  R = {};
  for (const key of ['T', 'PM', 'RH']) {
    let lo = Infinity, hi = -Infinity;
    for (const v of F.base[key]) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < MIN_SPAN[key]) { const m = (hi + lo) / 2; lo = m - MIN_SPAN[key] / 2; hi = m + MIN_SPAN[key] / 2; }
    R[key] = [lo, hi];
  }
}

/* ---------------- drawing ---------------- */
function colorAt(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], f = (t - t0) / (t1 - t0 || 1);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function ensureLayer(url = TRANSPARENT) {
  if (map.getSource('climate-img')) return true;
  map.addSource('climate-img', { type: 'image', url, coordinates: coords() });
  map.addLayer({
    id: 'climate-overlay', type: 'raster', source: 'climate-img',
    paint: { 'raster-opacity': 0.62, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
  }, map.getLayer('buildings-own') ? 'buildings-own' : undefined);
  return false;
}
let cv = null;
function paint() {
  if (mode === 'off') {
    if (map.getLayer('climate-overlay')) map.setLayoutProperty('climate-overlay', 'visibility', 'none');
    return;
  }
  const key = KEY[mode], A = F.scn[key], B = F.base[key], M = N * N;
  cv = cv || Object.assign(document.createElement('canvas'), { width: N, height: N });
  const cx = cv.getContext('2d'), im = cx.createImageData(N, N);
  let maxAbs = 0;
  if (deltaOnly) for (let k = 0; k < M; k++) maxAbs = Math.max(maxAbs, Math.abs(A[k] - B[k]));
  const [lo, hi] = R[key];
  for (let k = 0; k < M; k++) {
    let c, a;
    if (deltaOnly) {
      const d = A[k] - B[k];
      c = d < 0 ? [40, 110, 220] : [225, 50, 40];
      a = maxAbs > MIN_DELTA[key] ? Math.round(Math.min(1, Math.abs(d) / maxAbs) * 230) : 0;
    } else {
      c = colorAt(STOPS[key], (A[k] - lo) / (hi - lo)); a = 235;
    }
    im.data[k * 4] = c[0]; im.data[k * 4 + 1] = c[1]; im.data[k * 4 + 2] = c[2]; im.data[k * 4 + 3] = a;
  }
  cx.putImageData(im, 0, 0);
  const dataUrl = cv.toDataURL();
  if (ensureLayer(dataUrl)) {
    map.setLayoutProperty('climate-overlay', 'visibility', 'visible');
    map.getSource('climate-img').updateImage({ url: dataUrl, coordinates: coords() });
  }
}
function updateLegend() {
  const bar = document.getElementById('cl-bar');
  if (mode === 'off') { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  const key = KEY[mode], unit = { T: '°C', PM: 'µg/m³', RH: '%' }[key];
  const lo = document.getElementById('cl-lo'), mid = document.getElementById('cl-mid'), hi = document.getElementById('cl-hi');
  if (deltaOnly) {
    bar.style.background = 'linear-gradient(90deg,rgb(40,110,220),#f4f4f4,rgb(225,50,40))';
    lo.textContent = 'decrease'; mid.textContent = ''; hi.textContent = 'increase';
  } else {
    bar.style.background = 'linear-gradient(90deg,' + STOPS[key].map(([t, c]) => `rgb(${c}) ${t * 100}%`).join(',') + ')';
    lo.textContent = R[key][0].toFixed(key === 'PM' ? 1 : 0) + ' ' + unit;
    mid.textContent = mode === 'pm' ? 'black = highest' : '';
    hi.textContent = R[key][1].toFixed(key === 'PM' ? 1 : 0) + ' ' + unit;
  }
}
function updateEdits() {
  const el = document.getElementById('cl-edits');
  const M = N * N;
  let n = 0, dT = 0, dPM = 0, dRH = 0, pT = 0, pPM = 0, pRH = 0;
  for (let k = 0; k < M; k++) {
    const a = F.scn.T[k] - F.base.T[k], b = F.scn.PM[k] / F.base.PM[k] - 1, c = F.scn.RH[k] - F.base.RH[k];
    if (Math.abs(a) > 0.02 || Math.abs(b) > 0.005 || Math.abs(c) > 0.1) {
      n++; dT += a; dPM += b; dRH += c;
      if (Math.abs(a) > Math.abs(pT)) pT = a;
      if (Math.abs(b) > Math.abs(pPM)) pPM = b;
      if (Math.abs(c) > Math.abs(pRH)) pRH = c;
    }
  }
  const head = `<div><b>Your edits</b><span>+${U.nTrees} trees, +${U.nBuild} bldg, −${U.nRemoved} bldg</span></div>`;
  if (!n) { el.innerHTML = head + '<div style="color:#8a969c">Place a tree or building to see its effect.</div>'; return; }
  el.innerHTML = head +
    `<div><span>Affected area</span><b>≈ ${Math.round(n * CELL * CELL).toLocaleString()} m²</b></div>` +
    `<div><span>Temperature</span><b>${fmt(dT / n)} °C <small>(peak ${fmt(pT)})</small></b></div>` +
    `<div><span>PM2.5</span><b>${fmt((dPM / n) * 100)} % <small>(peak ${fmt(pPM * 100)})</small></b></div>` +
    `<div><span>Humidity</span><b>${fmt(dRH / n)} pts <small>(peak ${fmt(pRH)})</small></b></div>`;
}

/* ---------------- refresh pipeline ---------------- */
function refresh(full) {
  try {
    if (full || !S) buildStatic();
    buildUser();
    const sc = SCEN[scen];
    F = { base: field(sc, false), scn: field(sc, true) };
    computeRanges();
    paint(); updateLegend(); updateEdits(); updateMask();
  } catch (err) { console.error('climate layer failed:', err); }
}
let timer;
const schedule = (full, ms = 250) => { clearTimeout(timer); timer = setTimeout(() => refresh(full), ms); };

/* ---------------- live weather (Open-Meteo) ---------------- */
async function loadLive() {
  const lat = 49.1427, lon = 9.2109;
  try {
    const [w, a] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation`).then(r => r.json()),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5`).then(r => r.json())
    ]);
    const c = w.current || {};
    if (c.temperature_2m != null) SCEN.live.T = c.temperature_2m;
    if (c.relative_humidity_2m != null) SCEN.live.rh = c.relative_humidity_2m;
    if (c.precipitation != null) SCEN.live.precip = c.precipitation;
    if (a.current && a.current.pm2_5 != null) SCEN.live.pm = a.current.pm2_5;
    const opt = document.querySelector('#cl-scen option[value="live"]');
    if (opt) opt.textContent = `Live now (${SCEN.live.T.toFixed(1)} °C)`;
  } catch (err) { console.warn('Open-Meteo unavailable, using defaults', err); }
}

/* ---------------- rain / snow particles ---------------- */
const MW = 20, MH = 12;
const mask = new Uint8Array(MW * MH).fill(1); // 1 = rain, 2 = snow
let fx, fxc, parts = [];
function updateMask() {
  if (!F) return;
  const cvs = map.getCanvas(), w = cvs.clientWidth, h = cvs.clientHeight, base = SCEN[scen].T;
  for (let gy = 0; gy < MH; gy++) for (let gx = 0; gx < MW; gx++) {
    let T = base;
    try {
      const ll = map.unproject([((gx + 0.5) * w) / MW, ((gy + 0.5) * h) / MH]);
      const k = idx(ll.lng, ll.lat);
      if (k >= 0) T = F.scn.T[k];
    } catch { /* ignore */ }
    mask[gy * MW + gx] = T <= 0.5 ? 2 : 1;
  }
}
function setupFx() {
  fx = document.createElement('canvas'); fx.id = 'cl-fx';
  document.body.appendChild(fx); fxc = fx.getContext('2d');
  const size = () => { fx.width = innerWidth; fx.height = innerHeight; };
  size(); addEventListener('resize', size);
  for (let i = 0; i < 700; i++) parts.push({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, v: Math.random(), ph: Math.random() * 6.28 });
  (function frame(t) {
    requestAnimationFrame(frame);
    fxc.clearRect(0, 0, fx.width, fx.height);
    const p0 = SCEN[scen].precip;
    if (!fxOn || p0 <= 0) return;
    const n = Math.round(clamp(160 + p0 * 140, 160, 700)), w = fx.width, h = fx.height;
    fxc.beginPath(); fxc.strokeStyle = 'rgba(70,110,190,.6)'; fxc.lineWidth = 1.2;
    const snow = [];
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      const type = mask[clamp(Math.floor((p.y / h) * MH), 0, MH - 1) * MW + clamp(Math.floor((p.x / w) * MW), 0, MW - 1)];
      if (type === 1) {
        p.y += 14 + p.v * 8; p.x += 2;
        fxc.moveTo(p.x, p.y); fxc.lineTo(p.x + 2, p.y + 11);
      } else {
        p.y += 1 + p.v * 1.6; p.x += Math.sin(t / 700 + p.ph) * 0.7;
        snow.push(p);
      }
      if (p.y > h) { p.y = -12; p.x = Math.random() * w; }
      if (p.x > w) p.x = 0;
    }
    fxc.stroke();
    fxc.beginPath(); fxc.fillStyle = '#fff'; fxc.strokeStyle = 'rgba(110,130,150,.7)'; fxc.lineWidth = 0.8;
    for (const p of snow) { fxc.moveTo(p.x + 1.5 + p.v * 1.5, p.y); fxc.arc(p.x, p.y, 1.5 + p.v * 1.5, 0, 6.28); }
    fxc.fill(); fxc.stroke();
  })(0);
}

/* ---------------- UI ---------------- */
function buildUI() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const p = document.createElement('div'); p.id = 'cl-panel';
  p.innerHTML = `
    <div class="cl-head"><b>Climate layers</b><button id="cl-min" title="Collapse">–</button></div>
    <div id="cl-body">
      <div class="cl-modes">
        <button data-m="off">Off</button><button data-m="temp" class="on">🌡 Temp</button>
        <button data-m="pm">🏭 Pollution</button><button data-m="rh">💧 Humidity</button>
      </div>
      <label class="cl-row">Scenario
        <select id="cl-scen">
          <option value="live">Live now</option><option value="heat">Heatwave 34 °C</option>
          <option value="snow">Winter storm −2 °C</option><option value="rain">Heavy rain 11 °C</option>
        </select>
      </label>
      <label class="cl-chk"><input type="checkbox" id="cl-delta"> Show only the change from my edits</label>
      <label class="cl-chk"><input type="checkbox" id="cl-fxon" checked> Rain / snow effect</label>
      <div id="cl-bar"></div>
      <div class="cl-bar-l"><span id="cl-lo"></span><span id="cl-mid"></span><span id="cl-hi"></span></div>
      <div id="cl-edits"></div>
      <div class="cl-note">Illustrative model, not a measurement</div>
    </div>`;
  document.body.appendChild(p);
  const mc = document.getElementById('metrics-card');
  if (mc) {
    const syncTop = () => { p.style.top = `${mc.offsetTop + mc.offsetHeight + 10}px`; };
    new ResizeObserver(syncTop).observe(mc);
    syncTop();
  }
  const tip = document.createElement('div'); tip.id = 'cl-tip'; document.body.appendChild(tip);

  p.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    mode = b.dataset.m;
    p.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b));
    if (F) { paint(); updateLegend(); }
  });
  p.querySelector('#cl-scen').onchange = (e) => { scen = e.target.value; refresh(false); };
  p.querySelector('#cl-delta').onchange = (e) => { deltaOnly = e.target.checked; if (F) { paint(); updateLegend(); } };
  p.querySelector('#cl-fxon').onchange = (e) => { fxOn = e.target.checked; };
  p.querySelector('#cl-min').onclick = (e) => {
    const body = p.querySelector('#cl-body'), hide = body.style.display !== 'none';
    body.style.display = hide ? 'none' : 'block'; e.target.textContent = hide ? '+' : '–';
  };

  map.on('mousemove', (e) => {
    if (!F || mode === 'off') { tip.style.display = 'none'; return; }
    const k = idx(e.lngLat.lng, e.lngLat.lat);
    if (k < 0) { tip.style.display = 'none'; return; }
    const dT = F.scn.T[k] - F.base.T[k];
    tip.innerHTML = `<b>${F.scn.T[k].toFixed(1)} °C</b>` +
      (Math.abs(dT) > 0.02 ? ` <span>(${fmt(dT)} °C from your edits)</span>` : '') +
      `<br>PM2.5 ${F.scn.PM[k].toFixed(1)} µg/m³ · RH ${Math.round(F.scn.RH[k])} %`;
    tip.style.left = e.originalEvent.clientX + 14 + 'px';
    tip.style.top = e.originalEvent.clientY + 14 + 'px';
    tip.style.display = 'block';
  });
  map.on('mouseout', () => { tip.style.display = 'none'; });
}

/* ---------------- start ---------------- */
async function init() {
  app = window.__app; map = app.map;
  buildUI();
  setupFx();
  trees = await fetch('trees.json').then(r => r.json()).catch(() => []);
  await loadLive();
  refresh(true);

  window.addEventListener('scene-changed', () => schedule(false, 150));
  map.on('sourcedata', (e) => { if (e.sourceId === 'openmaptiles' && e.isSourceLoaded) schedule(true, 1200); });
  map.on('moveend', () => {
    if (!g) return;
    const c = map.getCenter();
    if (Math.hypot((c.lng - g.lng) * g.mLng, (c.lat - g.lat) * MLAT) > HALF * 0.4) schedule(true, 400);
    else updateMask();
  });
  let last = 0;
  map.on('move', () => { const t = performance.now(); if (t - last > 200) { last = t; updateMask(); } });
}
if (window.__app && window.__app.ready) init();
else window.addEventListener('app-ready', init, { once: true });