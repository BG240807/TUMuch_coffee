// climate-layer.js — local temperature / pollution / humidity layers + rain & snow for the Heilbronn map.
// Illustrative heuristic model: values come from land use (buildings, trees, parks, water, roads, elevation),
// not from measurements. City-wide base values come from Open-Meteo.
const N = 120;                 // grid cells per side
const HALF = 1600;             // metres from grid centre to edge (3.2 km × 3.2 km coverage)
const CELL = (2 * HALF) / N;   // ~26.7 m cells
const MLAT = 111320;           // metres per degree latitude
const AUTO_T = 4;              // °C: in Auto mode, rain/snow starts by itself at or below this
const SNOW_T = 1.5;            // °C: at or below this it falls as snow
const CO2_REF_KG = 7500;       // rough yearly CO₂ per person (kg): CO₂ avoided is also shown as a % of this
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

const SCEN = {
  live: { T: 12, rh: 65, pm: 8, pm10: 15, no2: 25, precip: 0 },
  heat: { T: 34, rh: 35, pm: 14, pm10: 24, no2: 30, precip: 0 },
  snow: { T: -2, rh: 88, pm: 14, pm10: 22, no2: 35, precip: 2.5 },
  rain: { T: 11, rh: 92, pm: 6.3, pm10: 4.5, no2: 18, precip: 8, rainWashout: true },
  carfree: { T: 12, rh: 65, pm: 6.8, pm10: 7.5, no2: 4.0, precip: 0, carfree: true }
};
const KEY = { temp: 'T', pet: 'PET', pm: 'PM', rh: 'RH' };
const STOPS = {
  T: [[0, [49, 104, 189]], [.25, [120, 178, 222]], [.45, [255, 247, 200]], [.65, [255, 190, 80]], [.85, [230, 80, 40]], [1, [150, 0, 20]]],
  PET: [[0, [50, 110, 200]], [.2, [60, 180, 160]], [.4, [100, 200, 90]], [.6, [245, 215, 60]], [.8, [235, 105, 40]], [1, [155, 15, 45]]],
  PM: [[0, [120, 200, 130]], [.3, [240, 225, 100]], [.55, [240, 150, 50]], [.8, [160, 30, 30]], [1, [10, 10, 10]]],
  RH: [[0, [247, 244, 235]], [.5, [150, 200, 230]], [1, [20, 70, 160]]]
};
const MIN_SPAN = { T: 3, PET: 5, PM: 4, RH: 10 };
const MIN_DELTA = { T: 0.02, PET: 0.05, PM: 0.05, RH: 0.1 };
const ROAD_W = { motorway: 1, trunk: 0.9, primary: 0.7, secondary: 0.5, tertiary: 0.35, minor: 0.12, service: 0.05 };

let app, map, g, S, U, F, R, trees = [];
let mode = 'temp', scen = 'live', deltaOnly = false;
let wxMode = 'auto';           // rain / snow buttons: 'auto' | 'rain' | 'snow' | 'off'
let stormH = 6;                // storm duration in hours (drives how much snow / water builds up)
let W = { Snow: null, Water: null, maxS: 0, maxW: 0, avgS: 0, avgW: 0 };
let showOriginal = false;      // comparison card "Original": hide the user's edits in the layer too
let monthRef = null;           // same calendar month, measured 2020–2025 average (colour scale anchor for the slider)
let pickedScen = 'live';       // dropdown choice to go back to when the slider returns to "Now"
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthsData = fetch('data/climate-months.json').then(r => r.json()).then(j => j.months).catch(() => ({}));

const CSS = `
#cl-panel{position:absolute;top:148px;right:54px;z-index:2;width:240px;max-height:calc(100vh - 170px);overflow-y:auto;padding:12px 14px;box-sizing:border-box;
 background:rgba(255,255,255,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-radius:14px;
 border:1px solid rgba(15,23,42,.08);box-shadow:0 4px 20px rgba(15,23,42,.12);font:12px/1.35 system-ui,-apple-system,sans-serif;color:#1f2a30}
@media (max-width: 1150px), (max-height: 760px){
 #cl-panel{width:206px;padding:9px 11px;font-size:11px;right:46px;max-height:calc(100vh - 150px)}
 #cl-panel .cl-head{font-size:12px;margin-bottom:6px}
 #cl-panel button,#cl-panel select{font-size:11px;padding:4px 6px}
}
#cl-panel .cl-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px}
#cl-panel button{font:500 12px system-ui,-apple-system,sans-serif;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.8);color:#1f2a30;border-radius:7px;padding:5px 8px;cursor:pointer;transition:background .15s,color .15s}
#cl-panel button:hover:not(.on){background:rgba(15,23,42,.05)}
#cl-panel button.on{background:#1f2a30;color:#fff;border-color:#1f2a30}
#cl-panel #cl-min{width:20px;height:20px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:5px}
#cl-panel .cl-modes{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:10px}
#cl-panel .cl-modes button[data-m="off"]{grid-column:1 / -1}
#cl-panel .cl-modes button{white-space:nowrap;padding:5px 4px}
#cl-panel .cl-wx{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:0 0 8px}
#cl-panel .cl-wx button{padding:5px 2px;white-space:nowrap}
#cl-panel .cl-row{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;color:#475569;font-weight:500}
#cl-panel select{font:500 12px system-ui,-apple-system,sans-serif;padding:5px 7px;border-radius:7px;border:1px solid rgba(15,23,42,.15);background:#fff;color:#1f2a30}
#cl-panel input[type=range]{width:100%;margin:2px 0 0;accent-color:#1f2a30;cursor:pointer}
#cl-panel .cl-chk{display:flex;gap:7px;align-items:center;margin:4px 0;color:#334155}
#cl-bar{height:8px;border-radius:999px;margin-top:8px;border:1px solid rgba(15,23,42,.1)}
#cl-panel .cl-bar-l{display:flex;justify-content:space-between;color:#64748b;font-size:10.5px;margin-top:3px}
#cl-acc{margin-top:8px;padding-top:8px;border-top:1px solid rgba(15,23,42,.08);font-size:11px;line-height:1.45;color:#334155}
#cl-acc i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px;border:1px solid rgba(15,23,42,.25)}
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
  S.elevB = blur(S.elev, 6, 2);   // smoothed terrain: cells lower than this collect standing water
  const tn = new Float32Array(M);
  for (let k = 0; k < M; k++) tn[k] = clamp(S.traffic[k] / CELL, 0, 1.5);
  S.trafB = blur(tn, 2, 2);
}

/* ---------------- user edits ---------------- */
function buildUser() {
  const M = N * N;
  const area = CELL * CELL;
  U = {
    built: new Float32Array(M),
    removed: new Float32Array(M),
    canopy: new Float32Array(M),
    park: new Float32Array(M),
    greenRoof: new Float32Array(M),
    solarRoof: new Float32Array(M),
    nTrees: 0,
    nBuild: 0,
    nRemoved: 0,
    nParks: 0,
    totalBuildArea: 0,
    greenRoofArea: 0,
    solarRoofArea: 0,
    carFree: new Float32Array(M),
    carFreeM: 0
  };
  for (const p of app.placed) {
    const k = idx(p.lng, p.lat);
    if (p.type === 'tree') {
      U.nTrees++;
      if (k >= 0) U.canopy[k] += Math.PI * (3 * (p.obj?.userData?.s || 1)) ** 2;
    } else if (p.type === 'building') {
      U.nBuild++;
      const bArea = (p.obj && p.obj.userData && p.obj.userData.area) || 140;
      const roofType = (p.obj && p.obj.userData && p.obj.userData.roofType) || 'standard';
      U.totalBuildArea += bArea;
      if (roofType === 'green') {
        U.greenRoofArea += bArea;
        if (k >= 0) U.greenRoof[k] += bArea;
      } else if (roofType === 'solar') {
        U.solarRoofArea += bArea;
        if (k >= 0) {
          U.solarRoof[k] += bArea;
          U.built[k] += bArea;
        }
      } else {
        if (k >= 0) U.built[k] += bArea;
      }
    } else if (p.type === 'park') {
      U.nParks++;
      if (k >= 0) U.park[k] += (p.obj?.userData?.area || 400);
    }
  }

  // Retrofitted map buildings
  if (app.retrofitted && S.bList) {
    const retroEntries = app.retrofitted instanceof Map ? app.retrofitted.entries() : Object.entries(app.retrofitted);
    const retroMap = new Map(retroEntries);
    for (const e of S.bList) {
      if (app.isDeleted(e.b)) continue;
      const type = retroMap.get(e.b.key) || retroMap.get(String(e.b.props?.bid)) || e.b.props?.retrofit;
      if (type === 'green') {
        U.greenRoofArea += e.a;
        if (e.k >= 0) U.greenRoof[e.k] += e.a;
      } else if (type === 'solar') {
        U.solarRoofArea += e.a;
        if (e.k >= 0) U.solarRoof[e.k] += e.a;
      }
    }
  }

  // Green areas created via wand / draw tool in placement.js
  let greenAreas = [];
  try {
    greenAreas = (JSON.parse(sessionStorage.getItem('heilbronn3d-green-areas')) || []).filter(a => a && a.ring);
  } catch { greenAreas = []; }
  U.nParks += greenAreas.length;
  for (const ga of greenAreas) {
    if (ga.ring && ga.ring.length >= 3) {
      let r = ga.ring;
      const first = r[0], last = r[r.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-7) {
        r = [...r, first];
      }
      rasterPoly([r], U.park);
    }
  }

  if (app.deleted && app.deleted.length) {
    for (const e of S.bList) if (app.isDeleted(e.b)) { U.removed[e.k] += e.a; U.nRemoved++; }
  }

  // Car-free pedestrian/bike streets
  const carFreeLines = window.__app?.carFreeLines || [];
  for (const cf of carFreeLines) {
    U.carFreeM += cf.lengthM || 0;
    const lines = cf.lines || (cf.coordinates ? [cf.coordinates] : []);
    for (const seg of lines) {
      const pts = Array.isArray(seg) ? seg : (seg.a && seg.b ? [seg.a, seg.b] : []);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const len = Math.hypot((b[0] - a[0]) * g.mLng, (b[1] - a[1]) * MLAT);
        const steps = Math.max(1, Math.ceil(len / 12));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const k = idx(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
          if (k >= 0) U.carFree[k] = 1.0;
        }
      }
    }
  }
  U.carFreeB = blur(U.carFree, 1, 2);
}

/* ---------------- the model ---------------- */
function field(sc, withUser) {
  const area = CELL * CELL, M = N * N;
  const sealed = new Float32Array(M), canopy = new Float32Array(M), userVeg = new Float32Array(M), userBuilt = new Float32Array(M);
  for (let k = 0; k < M; k++) {
    let b = S.built[k], c = S.canopy[k];
    if (withUser) {
      b = Math.max(0, b + U.built[k] - U.removed[k] * 1.4 - U.greenRoof[k] * 0.7);
      c += U.canopy[k] * 1.8;
      userVeg[k] = clamp((U.canopy[k] * 2.2 + U.removed[k] * 0.8 + (U.park[k] || 0) * area * 0.85 + U.greenRoof[k] * 0.7) / area, 0, 1.2);
      userBuilt[k] = clamp((U.built[k] * 1.6) / area, 0, 1.2);
    }
    sealed[k] = clamp((b / area) * 1.8, 0, 1);
    canopy[k] = clamp(c / area, 0, 1);
  }
  const sealedB = blur(sealed, 1, 2), canopyB = blur(canopy, 1, 2);
  const uVegB = withUser ? blur(userVeg, 2, 2) : userVeg;
  const uBuiltB = withUser ? blur(userBuilt, 2, 2) : userBuilt;
  const uCarFreeB = withUser ? U.carFreeB : new Float32Array(M);

  const T = new Float32Array(M), PET = new Float32Array(M), PM = new Float32Array(M), RH = new Float32Array(M), Runoff = new Float32Array(M);
  const Veg = new Float32Array(M);

  const isCarFree = !!sc.carfree;
  const trafFactor = isCarFree ? 0.16 : 1.0;
  const basePm = isCarFree ? (sc.pm * 0.85) : sc.pm;
  const rainWashout = (sc.precip > 0) ? clamp(1 - 0.05 * sc.precip, 0.65, 1.0) : 1.0;

  for (let k = 0; k < M; k++) {
    const baseVeg = clamp(canopyB[k] + 0.5 * S.greenB[k], 0, 1);
    const cf = clamp(uCarFreeB[k], 0, 1);
    Veg[k] = clamp(baseVeg + 0.6 * uVegB[k], 0, 1);

    // --- 1. Ambient Air Temp (Ta) ---
    // Single tree: cools local cell by -0.2 to -0.6 °C with log diminishing returns (Math.log1p)
    // +10% canopy cools neighborhood by -0.8 °C, capped at -1.5 °C for +30% canopy
    // Added concrete buildings warm local Ta up to +1.8 °C
    // Car-free pedestrian street eliminates asphalt heat buildup (-1.2 °C)
    // Thermal floor: cannot cool below rural background (sc.T)
    const baseTreeCool = -0.983 * Math.log1p(baseVeg * 12.0);
    const userTreeCool = withUser ? -Math.min(1.5, 0.983 * Math.log1p(uVegB[k] * 12.0)) : 0;
    const userBuildWarm = withUser ? Math.min(1.8, 1.8 * uBuiltB[k]) : 0;
    const userRoadCool = withUser ? -1.2 * cf : 0;

    const rawT = sc.T + 4.2 * sealedB[k] + baseTreeCool + userTreeCool + userBuildWarm + userRoadCool
      - 1.8 * S.waterB[k] - 0.0065 * (S.elev[k] - S.meanElev);

    T[k] = Math.max(sc.T - Math.max(0, 0.0065 * (S.elev[k] - S.meanElev)), rawT);

    // --- 2. Perceived Temperature (PET / Shade Comfort) ---
    // Trees/parks reduce local PET by -4.0 to -11.0 °C (dense shade + evapotranspiration)
    // Unshaded concrete/added buildings raise PET by +3.5 to +6.0 °C
    // Pedestrianization & street shading adds -2.5 °C PET comfort
    const solarGain = Math.max(0, (sc.T - 8) * 0.28) * (1 + 1.2 * sealedB[k]);
    const baseShade = -(4.0 * Math.min(1.0, baseVeg * 2.0) + 7.0 * (baseVeg * baseVeg));

    let userPetDelta = 0;
    if (withUser) {
      const uShade = clamp(userVeg[k] * 2.5 + uVegB[k] * 1.5, 0, 1);
      const dPetVeg = -(4.0 * clamp(uShade * 2.0, 0, 1) + 7.0 * uShade);
      const uConcrete = clamp(userBuilt[k] * 2.0 + uBuiltB[k], 0, 1);
      const dPetBuilt = +(3.5 * clamp(uConcrete * 1.5, 0, 1) + 2.5 * uConcrete);
      userPetDelta = dPetVeg + dPetBuilt - 2.5 * cf;
    }
    PET[k] = T[k] + solarGain + baseShade + userPetDelta;

    // --- 3. Particulate Matter (PM2.5) & Traffic Pollution ---
    // Car-free street reduces local traffic NO2/pollution by -50% per Brussels study in effects.json
    const localTrafFactor = 1.0 - 0.50 * cf;
    const trafProxy = 0.9 * S.trafB[k] * trafFactor * localTrafFactor;
    const vegFilter = clamp(0.4 * baseVeg + 0.45 * uVegB[k] + 0.20 * cf, 0, 0.75);
    PM[k] = Math.max(0.2 * basePm, basePm * (0.75 + trafProxy + 0.35 * sealedB[k] + 0.3 * uBuiltB[k]) * (1 - vegFilter) * rainWashout * (1 - 0.15 * cf));

    // --- 4. Relative Humidity (RH) ---
    RH[k] = clamp(sc.rh - 2.0 * (T[k] - sc.T) + 6.0 * baseVeg + 5.0 * uVegB[k] + 8.0 * S.waterB[k] + 2.0 * cf, 15, 100);

    // --- 5. Stormwater Runoff Coefficient ---
    const cBase = clamp(0.95 * sealedB[k] + 0.20 * baseVeg + 0.50 * (1 - sealedB[k] - baseVeg), 0.15, 0.95);
    const dRunoffGreen = -0.30 * clamp(U.greenRoof[k] / area, 0, 1);
    const dRunoffCarFree = -0.15 * cf;
    Runoff[k] = withUser ? clamp(cBase - 0.42 * uVegB[k] + 0.48 * uBuiltB[k] + dRunoffGreen + dRunoffCarFree, 0.15, 0.95) : cBase;
  }

  return { T, PET, PM, RH, Runoff, Sealed: sealedB, Veg };
}
function computeRanges() {
  // Slider month: colour scale comes from the same month in 2020–2025, so a warmer future month looks redder.
  const ref = scen === 'month' && monthRef ? field(monthRef, false) : F.base;
  R = {};
  for (const key of ['T', 'PET', 'PM', 'RH']) {
    let lo = Infinity, hi = -Infinity;
    for (const v of ref[key]) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo < MIN_SPAN[key]) { const m = (hi + lo) / 2; lo = m - MIN_SPAN[key] / 2; hi = m + MIN_SPAN[key] / 2; }
    R[key] = [lo, hi];
  }
}

/* ---------------- precipitation: rain / snow rules + accumulated levels ---------------- */
// Water-equivalent precipitation rate (mm/h) for a cell.
//  auto : real rain (live / month data) at any temperature, plus it starts by itself at <= AUTO_T
//  rain / snow : forced by the buttons;  off : nothing
function precipRate(T, p0) {
  if (wxMode === 'off') return 0;
  if (wxMode === 'rain' || wxMode === 'snow') return Math.max(p0, 3);
  if (T <= AUTO_T) return clamp(Math.max(p0, 1 + (AUTO_T - T) * 0.3), 0, 8);
  return p0;
}
// 0 = dry, 1 = rain, 2 = snow
function precipKind(T, rate) {
  if (rate <= 0) return 0;
  if (wxMode === 'rain') return 1;
  if (wxMode === 'snow') return 2;
  return T <= SNOW_T ? 2 : 1;
}
function areaType(k) {
  const s = F.scn.Sealed[k], v = F.scn.Veg[k], w = S.waterB[k];
  if (S.elev[k] - S.meanElev > 45) return 'Hillside';
  if (w > 0.35) return 'Waterside';
  if (v > 0.55) return 'Park / green area';
  if (s > 0.65) return 'Dense urban';
  if (s > 0.3) return 'Built-up area';
  return 'Open / low density';
}
// Snow depth (cm) and standing water depth (cm) per cell after `stormH` hours of the storm.
function computeWeather() {
  const M = N * N, p0 = SCEN[scen].precip, isCarFree = !!SCEN[scen].carfree;
  const Snow = new Float32Array(M), Water = new Float32Array(M);
  let maxS = 0, sumS = 0, nS = 0, maxW = 0, sumW = 0, nW = 0;
  for (let k = 0; k < M; k++) {
    const T = F.scn.T[k], rate = precipRate(T, p0), kind = precipKind(T, rate);
    if (kind === 0) continue;
    if (kind === 2) {
      // colder = fluffier, deeper pile; trees and busy (warm, salted) roads keep less snow
      const cold = 0.35 + 0.65 * clamp((SNOW_T - T) / 6, 0, 1);
      const shelter = clamp(1 - 0.25 * F.scn.Veg[k] - 0.35 * clamp(S.trafB[k] * (isCarFree ? 0.16 : 1), 0, 1), 0.4, 1);
      const d = Math.min(60, rate * stormH * cold * shelter);
      Snow[k] = d;
      if (d > 0.3) { sumS += d; nS++; if (d > maxS) maxS = d; }
    } else {
      // rain runs off sealed ground and pools in low spots (valley bottoms, next to water)
      const low = clamp((S.elevB[k] - S.elev[k]) / 4 + 0.3 * S.waterB[k], 0, 1);
      const d = Math.min(40, rate * stormH * F.scn.Runoff[k] * (0.03 + 0.3 * low));
      Water[k] = d;
      if (d > 0.3) { sumW += d; nW++; if (d > maxW) maxW = d; }
    }
  }
  W = { Snow, Water, maxS, maxW, avgS: nS ? sumS / nS : 0, avgW: nW ? sumW / nW : 0 };
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
  const half = N / 2;
  for (let k = 0; k < M; k++) {
    const i = k % N, j = (k - i) / N;
    // Smooth radial + edge vignette so the overlay blends softly instead of showing a sharp square box
    const rx = (i + 0.5 - half) / half, ry = (j + 0.5 - half) / half;
    const r = Math.hypot(rx, ry);
    const fade = clamp((1.02 - r) / 0.28, 0, 1);
    const edgeFade = fade * fade * (3 - 2 * fade);
    let c, a;
    if (deltaOnly) {
      const d = A[k] - B[k];
      c = d < 0 ? [40, 110, 220] : [225, 50, 40];
      a = maxAbs > MIN_DELTA[key] ? Math.round(Math.min(1, Math.abs(d) / maxAbs) * 235 * edgeFade) : 0;
    } else {
      // Amplify local user-edit delta visually on the colour ramp so new parks/buildings stand out clearly
      const val = B[k] + (A[k] - B[k]) * 1.65;
      c = colorAt(STOPS[key], (val - lo) / (hi - lo));
      a = Math.round(230 * edgeFade);
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

// Snow / standing water on the ground (raster) ...
function ensureWeatherLayer(url) {
  if (map.getSource('weather-img')) return true;
  map.addSource('weather-img', { type: 'image', url, coordinates: coords() });
  map.addLayer({
    id: 'weather-ground', type: 'raster', source: 'weather-img',
    paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
  }, map.getLayer('buildings-own') ? 'buildings-own' : undefined);
  return false;
}
let cv2 = null;
function paintWeather() {
  const hide = () => { if (map.getLayer('weather-ground')) map.setLayoutProperty('weather-ground', 'visibility', 'none'); };
  if (!W.Snow || (W.maxS < 0.3 && W.maxW < 0.3)) return hide();
  cv2 = cv2 || Object.assign(document.createElement('canvas'), { width: N, height: N });
  const cx = cv2.getContext('2d'), im = cx.createImageData(N, N), half = N / 2, M = N * N;
  for (let k = 0; k < M; k++) {
    const i = k % N, j = (k - i) / N;
    const r = Math.hypot((i + 0.5 - half) / half, (j + 0.5 - half) / half);
    const fade = clamp((1.02 - r) / 0.28, 0, 1), edge = fade * fade * (3 - 2 * fade);
    const s = W.Snow[k], w = W.Water[k];
    let c = null, a = 0;
    if (s >= w && s > 0.3) {            // snow: pale blue when thin, white when deep
      const t = clamp(s / 20, 0, 1);
      c = [205 + 50 * t, 225 + 30 * t, 245 + 10 * t];
      a = 0.5 + 0.5 * clamp(s / 10, 0, 1);
    } else if (w > 0.3) {               // standing water: light blue when shallow, deep blue when deep
      const t = clamp(w / 15, 0, 1);
      c = [150 - 120 * t, 200 - 110 * t, 240 - 40 * t];
      a = 0.45 + 0.5 * t;
    }
    if (c) {
      im.data[k * 4] = c[0]; im.data[k * 4 + 1] = c[1]; im.data[k * 4 + 2] = c[2];
      im.data[k * 4 + 3] = Math.round(255 * a * edge);
    }
  }
  cx.putImageData(im, 0, 0);
  const url = cv2.toDataURL();
  if (ensureWeatherLayer(url)) {
    map.setLayoutProperty('weather-ground', 'visibility', 'visible');
    map.getSource('weather-img').updateImage({ url, coordinates: coords() });
  }
}
// ... and snow caps on the roofs (3D). Thickness is drawn 4x so a few cm are visible.
function updateCaps() {
  const wantCaps = W.Snow && W.maxS >= 1;
  if (!map.getSource('snow-caps')) {
    if (!wantCaps) return;
    map.addSource('snow-caps', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'snow-caps', type: 'fill-extrusion', source: 'snow-caps', minzoom: 14,
      paint: {
        'fill-extrusion-color': '#ffffff',
        'fill-extrusion-height': ['get', 't'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-opacity': 0.97
      }
    });
  }
  const src = map.getSource('snow-caps');
  if (!wantCaps) { src.setData(EMPTY_FC); return; }
  const features = [];
  for (const b of app.buildings.values()) {
    if (app.isDeleted(b)) continue;
    const k = idx((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2);
    if (k < 0) continue;
    const d = W.Snow[k];
    if (d < 1) continue;
    const h = b.props.render_height ?? 8;
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: b.poly },
      properties: { b: h, t: h + Math.max(0.3, (d / 100) * 4) }
    });
  }
  src.setData({ type: 'FeatureCollection', features });
}
function updateAccText() {
  const el = document.getElementById('cl-acc');
  if (!el) return;
  const rows = [];
  if (W.maxS >= 0.3) rows.push(`<div><i style="background:#e8f1fb"></i>Snow after ${stormH} h: avg ${W.avgS.toFixed(0)} cm, max ${W.maxS.toFixed(0)} cm</div>`);
  if (W.maxW >= 0.3) rows.push(`<div><i style="background:#4a8fd8"></i>Standing water: avg ${W.avgW.toFixed(1)} cm, max ${W.maxW.toFixed(0)} cm</div>`);
  if (rows.length) {
    el.innerHTML = rows.join('') + (W.maxS >= 1 ? '<div style="color:#94a3b8">Roof snow is drawn 4× thicker than real.</div>' : '');
  } else if (wxMode === 'off') {
    el.innerHTML = '<div style="color:#94a3b8">Rain / snow is switched off.</div>';
  } else {
    el.innerHTML = `<div style="color:#94a3b8">Dry. In Auto, rain / snow appears when it really rains or at ≤ ${AUTO_T} °C.</div>`;
  }
}

/* ---------------- local readout for the metrics card ---------------- */
let lastLocalKey = '';
function updateLocal() {
  if (!F || !g) return;
  const c = map.getCenter(), k = idx(c.lng, c.lat);
  let d = null;
  if (k >= 0) {
    const T = F.scn.T[k], rate = precipRate(T, SCEN[scen].precip), kind = precipKind(T, rate);
    d = {
      T, dT: T - SCEN[scen].T, PET: F.scn.PET[k], PM: F.scn.PM[k], RH: F.scn.RH[k],
      area: areaType(k),
      precip: kind === 2 ? 'snow' : kind === 1 ? 'rain' : 'none',
      snowCm: W.Snow ? W.Snow[k] : 0, waterCm: W.Water ? W.Water[k] : 0
    };
  }
  const key = d ? [d.T.toFixed(1), d.area, d.precip, Math.round(d.snowCm), Math.round(d.waterCm), d.PM.toFixed(1), Math.round(d.RH)].join('|') : 'none';
  if (key === lastLocalKey) return;
  lastLocalKey = key;
  window.dispatchEvent(new CustomEvent('climate-local', { detail: d }));
}

function updateLegend() {
  const bar = document.getElementById('cl-bar');
  if (mode === 'off') { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  const key = KEY[mode], unit = { T: '°C', PET: '°C feel', PM: 'µg/m³', RH: '%' }[key];
  const lo = document.getElementById('cl-lo'), mid = document.getElementById('cl-mid'), hi = document.getElementById('cl-hi');
  if (deltaOnly) {
    bar.style.background = 'linear-gradient(90deg,rgb(40,110,220),#f4f4f4,rgb(225,50,40))';
    lo.textContent = 'cooling'; mid.textContent = ''; hi.textContent = 'warming';
  } else {
    bar.style.background = 'linear-gradient(90deg,' + STOPS[key].map(([t, c]) => `rgb(${c}) ${t * 100}%`).join(',') + ')';
    lo.textContent = R[key][0].toFixed(key === 'PM' ? 1 : 0) + ' ' + unit;
    if (key === 'PET') mid.textContent = 'comfort ~22°';
    else if (key === 'PM') mid.textContent = 'black = highest';
    else mid.textContent = '';
    hi.textContent = R[key][1].toFixed(key === 'PM' ? 1 : 0) + ' ' + unit;
  }
}
function updateEdits() {
  const el = document.getElementById('cl-edits');
  const M = N * N;
  let n = 0, dT = 0, dPET = 0, dPM = 0, dRH = 0;
  let pT = 0, pPET = 0, pPM = 0, pRH = 0;
  let sumBaseRunoff = 0, sumScnRunoff = 0, sumBaseRH = 0;

  for (let k = 0; k < M; k++) {
    const a = F.scn.T[k] - F.base.T[k];
    const b = F.scn.PM[k] / (F.base.PM[k] || 1) - 1;
    const c = F.scn.RH[k] - F.base.RH[k];
    const d = F.scn.PET[k] - F.base.PET[k];

    if (Math.abs(a) > 0.02 || Math.abs(d) > 0.05 || Math.abs(b) > 0.005 || Math.abs(c) > 0.1) {
      n++;
      dT += a;
      dPET += d;
      dPM += b;
      dRH += c;
      sumBaseRH += F.base.RH[k];
      if (Math.abs(a) > Math.abs(pT)) pT = a;
      if (Math.abs(d) > Math.abs(pPET)) pPET = d;
      if (Math.abs(b) > Math.abs(pPM)) pPM = b;
      if (Math.abs(c) > Math.abs(pRH)) pRH = c;

      if (F.base.Runoff && F.scn.Runoff) {
        sumBaseRunoff += F.base.Runoff[k];
        sumScnRunoff += F.scn.Runoff[k];
      }
    }
  }

  let dRunoffPct = 0;
  if (sumBaseRunoff > 0) {
    dRunoffPct = ((sumScnRunoff - sumBaseRunoff) / sumBaseRunoff) * 100;
  }

  const solarKwhYr = Math.round((U.solarRoofArea || 0) * 175);
  const solarCo2SavedKgYr = solarKwhYr * 0.36; // German grid factor 0.36 kg CO2/kWh (UBA 2024)
  const treeCo2SavedKgYr = (U.nTrees || 0) * 25 + (U.nParks || 0) * 1500;
  const co2SavedKgYr = Math.round(solarCo2SavedKgYr + treeCo2SavedKgYr);
  const co2Pct = (co2SavedKgYr / CO2_REF_KG) * 100;   // share of one person's yearly footprint

  const counts = { tree: U.nTrees, park: U.nParks, building: U.nBuild };
  const hasInterventions = (U.nTrees > 0 || U.nBuild > 0 || U.nRemoved > 0 || U.nParks > 0 || U.greenRoofArea > 0 || U.solarRoofArea > 0 || (U.carFreeM || 0) > 0);
  const active = !showOriginal && (hasInterventions || n > 0);

  const avgT = n ? dT / n : 0;
  const avgPET = n ? dPET / n : 0;
  const avgPM = n ? (dPM / n) * 100 : 0;
  const avgRH = n ? dRH / n : 0;
  const rhPct = sumBaseRH ? (dRH / sumBaseRH) * 100 : 0;   // humidity change relative to its own level

  window.dispatchEvent(new CustomEvent('climate-edits', {
    detail: {
      active,
      dT: Number(avgT.toFixed(2)),
      peakT: Number(pT.toFixed(2)),
      dPET: Number(avgPET.toFixed(1)),
      peakPET: Number(pPET.toFixed(1)),
      dPM: Number(avgPM.toFixed(1)),
      dRH: Number(avgRH.toFixed(1)),
      dRHpct: Number(rhPct.toFixed(1)),
      dRunoffPct: Number(dRunoffPct.toFixed(1)),
      greenRoofM2: Math.round(U.greenRoofArea),
      solarRoofM2: Math.round(U.solarRoofArea),
      solarKwhYr,
      co2SavedKgYr,
      carFreeLengthM: Math.round(U.carFreeM || 0),
      co2Pct: Number(co2Pct.toFixed(2)),
      counts,
      areaM2: Math.round(n * CELL * CELL),
      nTrees: U.nTrees,
      nBuild: U.nBuild,
      nRemoved: U.nRemoved,
      showOriginal
    }
  }));

  const parkText = U.nParks > 0 ? `, +${U.nParks} park` : '';
  const roofParts = [];
  if (U.greenRoofArea > 0) roofParts.push(`+${Math.round(U.greenRoofArea)} m² green roof`);
  if (U.solarRoofArea > 0) roofParts.push(`+${Math.round(U.solarRoofArea)} m² solar`);
  const roofText = roofParts.length ? `, ${roofParts.join(', ')}` : '';
  const carFreeText = (U.carFreeM && U.carFreeM > 0) ? `, +${Math.round(U.carFreeM)} m car-free` : '';
  const head = `<div><b>Your edits</b><span>+${U.nTrees} trees${parkText}, +${U.nBuild} bldg, −${U.nRemoved} bldg${roofText}${carFreeText}</span></div>`;

  if (showOriginal) {
    el.innerHTML = head + '<div style="color:#8a969c">Viewing the original city: edits hidden.</div>';
    return;
  }
  if (!n) {
    el.innerHTML = head + '<div style="color:#8a969c">Place a tree or building to see its effect.</div>';
    return;
  }

  let co2Val = '';
  if (co2SavedKgYr >= 1000) co2Val = `${(co2SavedKgYr / 1000).toFixed(1)} t/yr`;
  else if (co2SavedKgYr > 0) co2Val = `${co2SavedKgYr} kg/yr`;

  el.innerHTML = head +
    `<div><span>Affected area</span><b>≈ ${Math.round(n * CELL * CELL).toLocaleString()} m²</b></div>` +
    `<div><span>Temperature</span><b>${fmt(avgT)} °C <small>(peak ${fmt(pT)})</small></b></div>` +
    `<div><span>Shade feel (PET)</span><b>${fmt(avgPET)} °C <small>(peak ${fmt(pPET)})</small></b></div>` +
    `<div><span>Stormwater runoff</span><b>${fmt(dRunoffPct)} %</b></div>` +
    `<div><span>PM2.5</span><b>${fmt(avgPM)} % <small>(peak ${fmt(pPM * 100)})</small></b></div>` +
    `<div><span>Humidity</span><b>${fmt(avgRH)} pts <small>(${fmt(rhPct)} %)</small></b></div>` +
    (solarKwhYr > 0 ? `<div><span>Rooftop solar</span><b>${solarKwhYr.toLocaleString()} kWh/yr</b></div>` : '') +
    (U.carFreeM > 0 ? `<div><span>Car-free street</span><b>${Math.round(U.carFreeM).toLocaleString()} m</b></div>` : '') +
    (co2Val ? `<div><span>CO₂ avoided</span><b>${co2Val} <small>(${co2Pct.toFixed(1)} %)</small></b></div>` +
      `<div style="color:#94a3b8;font-size:10.5px">CO₂ % = share of one person's yearly footprint (≈ ${(CO2_REF_KG / 1000).toFixed(1)} t).</div>` : '');
}

/* ---------------- refresh pipeline ---------------- */
function refresh(full) {
  try {
    if (full || !S) buildStatic();
    buildUser();
    const sc = SCEN[scen];
    const base = field(sc, false);
    F = { base, scn: showOriginal ? base : field(sc, true) };
    computeRanges();
    paint(); updateLegend(); updateEdits(); updateRef();
  } catch (err) { console.error('climate layer failed:', err); return; }
  // rain / snow levels and local readout: separate, so a problem here can never hide the edits panel
  try {
    computeWeather();
    updateMask();
    paintWeather(); updateCaps(); updateAccText(); updateLocal();
  } catch (err) { console.error('weather layer failed:', err); }
}
let timer;
const schedule = (full, ms = 250) => { clearTimeout(timer); timer = setTimeout(() => refresh(full), ms); };
// storm-duration slider / rain-snow buttons: only the weather part needs recomputing
let wTimer;
function refreshWeather(immediate) {
  clearTimeout(wTimer);
  const run = () => {
    if (!F) return;
    try {
      computeWeather(); updateMask();
      paintWeather(); updateCaps(); updateAccText(); updateLocal();
    } catch (err) { console.error('weather layer failed:', err); }
  };
  if (immediate) run(); else wTimer = setTimeout(run, 120);
}

/* ---------------- time slider month (event from time-slider.js) ---------------- */
async function setMonth(m) {
  const sel = document.getElementById('cl-scen');
  if (!sel) return;
  let opt = sel.querySelector('option[value="month"]');
  if (!m || m.tmax == null) { // back to "Now" (or month without data)
    if (opt) opt.remove();
    scen = pickedScen; sel.value = scen; monthRef = null;
    return schedule(false, 30);
  }
  const all = await monthsData, mm = String(m.month + 1).padStart(2, '0');
  const past = Object.entries(all).filter(([k, d]) => k.endsWith('-' + mm) && d.k === 'm' && +k.slice(0, 4) <= 2025);
  const avg = (f) => { const v = past.map(([, d]) => d[f]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  monthRef = { T: avg('tx') ?? m.tmax, rh: avg('h') ?? m.humidity, pm: avg('pm25') ?? SCEN.live.pm, precip: 0, name: MONTH_NAMES[m.month] };
  // rain in that month: monthly total -> typical intensity during a rainy spell (mm/h); very dry months stay dry
  const mp = m.rain == null ? 0 : clamp(m.rain / 30.4 / 2.4, 0, 6);
  SCEN.month = { T: m.tmax, rh: m.humidity ?? monthRef.rh, pm: m.pm2_5 ?? monthRef.pm, precip: mp < 0.3 ? 0 : mp, label: m.label, kind: m.kind };
  if (!opt) { opt = document.createElement('option'); opt.value = 'month'; sel.prepend(opt); }
  opt.textContent = `${m.label} · avg. daily max ${m.tmax.toFixed(1)} °C`;
  scen = 'month'; sel.value = 'month';
  schedule(false, 30);
}
function updateRef() {
  const el = document.getElementById('cl-ref');
  if (!el) return;
  if (scen !== 'month' || !monthRef) { el.style.display = 'none'; return; }
  const d = SCEN.month.T - monthRef.T;
  el.style.display = 'block';
  el.innerHTML = `${SCEN.month.label} (${SCEN.month.kind}): <b style="color:${d > 0 ? '#c2410c' : '#1d4ed8'}">${fmt(d)} °C</b> vs. ${monthRef.name} 2020–25 average. Colours use the 2020–25 scale.`;
}

/* ---------------- live weather (Open-Meteo) ---------------- */
async function loadLive() {
  const lat = 49.1427, lon = 9.2109;
  try {
    const [w, a] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation`).then(r => r.json()),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=pm2_5,pm10,nitrogen_dioxide`).then(r => r.json())
    ]);
    const c = w.current || {}, aq = a.current || {};
    if (c.temperature_2m != null) SCEN.live.T = c.temperature_2m;
    if (c.relative_humidity_2m != null) SCEN.live.rh = c.relative_humidity_2m;
    // real rain right now: any amount > 0 shows as (at least light) rain, at any temperature
    if (c.precipitation != null) SCEN.live.precip = c.precipitation > 0 ? Math.max(0.6, c.precipitation) : 0;
    if (aq.pm2_5 != null) SCEN.live.pm = aq.pm2_5;
    if (aq.pm10 != null) SCEN.live.pm10 = aq.pm10;
    if (aq.nitrogen_dioxide != null) SCEN.live.no2 = aq.nitrogen_dioxide;

    SCEN.carfree.T = SCEN.live.T;
    SCEN.carfree.rh = SCEN.live.rh;
    SCEN.carfree.pm = SCEN.live.pm * 0.85; // -15% PM2.5
    SCEN.carfree.pm10 = (SCEN.live.pm10 || 15) * 0.50; // -50% PM10
    SCEN.carfree.no2 = (SCEN.live.no2 || 25) * 0.16; // -84% NO2

    const opt = document.querySelector('#cl-scen option[value="live"]');
    if (opt) opt.textContent = `Live now (${SCEN.live.T.toFixed(1)} °C)`;
  } catch (err) { console.warn('Open-Meteo unavailable, using defaults', err); }
}

/* ---------------- rain / snow particles (per local temperature and the buttons) ---------------- */
const MW = 20, MH = 12;
const mask = new Uint8Array(MW * MH);   // per screen cell: 0 dry, 1 rain, 2 snow
let fx, fxc, parts = [], fxAny = false, fxN = 0;
function updateMask() {
  if (!F) return;
  const cvs = map.getCanvas(), w = cvs.clientWidth, h = cvs.clientHeight;
  const base = SCEN[scen].T, p0 = SCEN[scen].precip;
  let any = false, sumR = 0, nWet = 0;
  for (let gy = 0; gy < MH; gy++) for (let gx = 0; gx < MW; gx++) {
    let T = base;
    try {
      const ll = map.unproject([((gx + 0.5) * w) / MW, ((gy + 0.5) * h) / MH]);
      const k = idx(ll.lng, ll.lat);
      if (k >= 0) T = F.scn.T[k];
    } catch { /* ignore */ }
    const r = precipRate(T, p0), kind = precipKind(T, r);
    mask[gy * MW + gx] = kind;
    if (kind) { any = true; sumR += r; nWet++; }
  }
  fxAny = any;
  fxN = nWet ? Math.round(clamp(120 + (sumR / nWet) * 110, 120, 700)) : 0;   // heavier when colder / stormier
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
    if (!fxAny) return;
    const w = fx.width, h = fx.height;
    fxc.beginPath(); fxc.strokeStyle = 'rgba(70,110,190,.6)'; fxc.lineWidth = 1.2;
    const snow = [];
    for (let i = 0; i < fxN; i++) {
      const p = parts[i];
      const type = mask[clamp(Math.floor((p.y / h) * MH), 0, MH - 1) * MW + clamp(Math.floor((p.x / w) * MW), 0, MW - 1)];
      if (type === 1) {
        p.y += 14 + p.v * 8; p.x += 2;
        fxc.moveTo(p.x, p.y); fxc.lineTo(p.x + 2, p.y + 11);
      } else if (type === 2) {
        p.y += 1 + p.v * 1.6; p.x += Math.sin(t / 700 + p.ph) * 0.7;
        snow.push(p);
      } else {
        p.y += 6; p.x += 1;   // dry area: keep moving, draw nothing
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
        <button data-m="off">Off</button><button data-m="temp" class="on">🌡 Air Temp</button>
        <button data-m="pet">☀️ Feel (PET)</button><button data-m="pm">🏭 Pollution</button>
        <button data-m="rh">💧 Humidity</button>
      </div>
      <label class="cl-row">Scenario
        <select id="cl-scen">
          <option value="live">Live now</option><option value="heat">Heatwave 34 °C</option>
          <option value="snow">Winter storm −2 °C</option><option value="rain">Heavy rain 11 °C</option>
          <option value="carfree">Car-free day</option>
        </select>
      </label>
      <div id="cl-ref" style="display:none;margin:-2px 0 6px;color:#475569;font-size:11px"></div>
      <label class="cl-chk"><input type="checkbox" id="cl-delta"> Show only the change from my edits</label>
      <div class="cl-row" style="margin:8px 0 4px">Rain / snow</div>
      <div class="cl-wx">
        <button data-w="auto" class="on" title="Follows real rain and the temperature (≤ ${AUTO_T} °C)">Auto</button>
        <button data-w="rain" title="Show rain everywhere">🌧</button>
        <button data-w="snow" title="Show snow everywhere">❄</button>
        <button data-w="off" title="Hide rain and snow">Off</button>
      </div>
      <label class="cl-row">Storm duration: <b id="cl-hv">${stormH} h</b>
        <input type="range" id="cl-hours" min="1" max="24" value="${stormH}">
      </label>
      <div id="cl-bar"></div>
      <div class="cl-bar-l"><span id="cl-lo"></span><span id="cl-mid"></span><span id="cl-hi"></span></div>
      <div id="cl-acc"></div>
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
  p.querySelectorAll('[data-w]').forEach(b => b.onclick = () => {
    wxMode = b.dataset.w;
    p.querySelectorAll('[data-w]').forEach(x => x.classList.toggle('on', x === b));
    refreshWeather(true);
  });
  p.querySelector('#cl-scen').onchange = (e) => {
    scen = e.target.value;
    if (scen !== 'month') pickedScen = scen;
    refresh(false);
  };
  p.querySelector('#cl-delta').onchange = (e) => { deltaOnly = e.target.checked; if (F) { paint(); updateLegend(); } };
  p.querySelector('#cl-hours').oninput = (e) => {
    stormH = Number(e.target.value);
    p.querySelector('#cl-hv').textContent = stormH + ' h';
    refreshWeather(false);
  };
  p.querySelector('#cl-min').onclick = (e) => {
    const body = p.querySelector('#cl-body'), hide = body.style.display !== 'none';
    body.style.display = hide ? 'none' : 'block'; e.target.textContent = hide ? '+' : '–';
  };

  map.on('mousemove', (e) => {
    if (!F || mode === 'off') { tip.style.display = 'none'; return; }
    const k = idx(e.lngLat.lng, e.lngLat.lat);
    if (k < 0) { tip.style.display = 'none'; return; }
    const dT = F.scn.T[k] - F.base.T[k];
    const dPET = F.scn.PET[k] - F.base.PET[k];
    const dPM = F.scn.PM[k] - F.base.PM[k];
    const ground = W.Snow && W.Snow[k] >= 1 ? `<br>❄ ${Math.round(W.Snow[k])} cm snow`
      : W.Water && W.Water[k] >= 1 ? `<br>💧 ${Math.round(W.Water[k])} cm standing water` : '';

    if (mode === 'pet') {
      tip.innerHTML = `<b>${F.scn.PET[k].toFixed(1)} °C feel (PET)</b>` +
        (Math.abs(dPET) > 0.1 ? ` <span>(${fmt(dPET)} °C feel from edits)</span>` : '') +
        `<br>Air ${F.scn.T[k].toFixed(1)} °C${Math.abs(dT) > 0.02 ? ` (${fmt(dT)}°)` : ''} · PM2.5 ${F.scn.PM[k].toFixed(1)} µg/m³ · RH ${Math.round(F.scn.RH[k])} %`;
    } else if (mode === 'temp') {
      tip.innerHTML = `<b>${F.scn.T[k].toFixed(1)} °C</b>` +
        (Math.abs(dT) > 0.02 ? ` <span>(${fmt(dT)} °C from edits)</span>` : '') +
        `<br>Feel ${F.scn.PET[k].toFixed(1)} °C PET${Math.abs(dPET) > 0.1 ? ` <span style="color:#a5d8ff">(${fmt(dPET)}°)</span>` : ''}` +
        `<br>PM2.5 ${F.scn.PM[k].toFixed(1)} µg/m³ · RH ${Math.round(F.scn.RH[k])} %`;
    } else if (mode === 'pm') {
      tip.innerHTML = `<b>PM2.5 ${F.scn.PM[k].toFixed(1)} µg/m³</b>` +
        (Math.abs(dPM) > 0.1 ? ` <span>(${fmt(dPM)} µg/m³ from edits)</span>` : '') +
        `<br>Air ${F.scn.T[k].toFixed(1)} °C · Feel ${F.scn.PET[k].toFixed(1)} °C PET · RH ${Math.round(F.scn.RH[k])} %`;
    } else {
      tip.innerHTML = `<b>RH ${Math.round(F.scn.RH[k])} %</b>` +
        `<br>Air ${F.scn.T[k].toFixed(1)} °C · Feel ${F.scn.PET[k].toFixed(1)} °C PET · PM2.5 ${F.scn.PM[k].toFixed(1)} µg/m³`;
    }
    tip.innerHTML += ground;
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
  window.addEventListener('climate-month', (e) => setMonth(e.detail));
  window.addEventListener('view-original', (e) => { showOriginal = !!e.detail; schedule(false, 30); });
  map.on('sourcedata', (e) => { if (e.sourceId === 'openmaptiles' && e.isSourceLoaded) schedule(true, 1200); });
  map.on('moveend', () => {
    if (!g) return;
    const c = map.getCenter();
    if (Math.hypot((c.lng - g.lng) * g.mLng, (c.lat - g.lat) * MLAT) > HALF * 0.22) schedule(true, 220);
    else { updateMask(); updateLocal(); }
  });
  let last = 0;
  map.on('move', () => { const t = performance.now(); if (t - last > 200) { last = t; updateMask(); updateLocal(); } });
}
if (window.__app && window.__app.ready) init();
else window.addEventListener('app-ready', init, { once: true });