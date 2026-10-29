// Floating metrics card: live city values for Heilbronn from Open-Meteo (no API key).
// Compact: temperature, felt temperature, air quality (European AQI), humidity. Click to expand.
// The big temperature, humidity and PM2.5 are LOCAL: city value + the local offset that climate-layer.js
// computes for the spot at the centre of the map ('climate-local' event).
// The time slider calls showMonth() / showLive() to switch between a picked month and now.
const LAT = 49.142, LON = 9.219;
const REFRESH_MS = 10 * 60 * 1000;

// European AQI bands (EEA): upper bound, label, colour
const AQI_BANDS = [
  [20, 'Good', '#50c878'], [40, 'Fair', '#a3d65c'], [60, 'Moderate', '#f0c800'],
  [80, 'Poor', '#f08a24'], [100, 'Very poor', '#e0413a'], [Infinity, 'Extremely poor', '#8e2b88'],
];
const aqiBand = (v) => AQI_BANDS.find(([max]) => v <= max);

const card = document.createElement('div');
card.id = 'metrics-card';
card.title = 'Click for details';
card.innerHTML = '<div class="mc-head"><span>Heilbronn · now</span><span class="mc-chev">▾</span></div><div class="mc-temp">…</div>';
document.body.appendChild(card);
card.addEventListener('click', () => card.classList.toggle('open'));

const fmt = (v, digits = 0) => (v == null || isNaN(v) ? '–' : Number(v).toFixed(digits));

function formatDelta(v, unit = '', digits = 1) {
  if (v == null || isNaN(v)) return '0' + unit;
  const n = Number(v);
  if (Math.abs(n) < (digits === 0 ? 0.5 : 0.05)) {
    return (digits === 0 ? '0' : '0.0') + unit;
  }
  const sign = n > 0 ? '+' : '−';
  return `${sign}${Math.abs(n).toFixed(digits)}${unit}`;
}

let currentEdits = null;
let currentLocal = null;   // { T, dT, PET, PM, RH, area, precip, snowCm, waterCm } for the map centre, or null
let lastLiveData = null;
let lastMonthData = null;
let monthShown = false;

function rerender() {
  if (monthShown && lastMonthData) showMonth(lastMonthData);
  else if (!monthShown && lastLiveData) render(lastLiveData);
}
window.addEventListener('climate-edits', (e) => { currentEdits = e.detail; rerender(); });
window.addEventListener('climate-local', (e) => { currentLocal = e.detail; rerender(); });

// Local offset (°C) to add to a city value; 0 when the map centre is outside the model area.
const localShift = () => (currentLocal ? currentLocal.dT : 0);
const shifted = (v) => (v == null || isNaN(v) ? null : v + localShift());

function renderLocalHTML(cityTemp) {
  const L = currentLocal;
  if (!L) return '';
  const wx = L.precip === 'snow' ? '❄ Snowing here' : L.precip === 'rain' ? '🌧 Raining here' : '';
  const ground = L.snowCm >= 1 ? `❄ ${Math.round(L.snowCm)} cm snow on the ground`
    : L.waterCm >= 1 ? `💧 ${Math.round(L.waterCm)} cm standing water` : '';
  const extra = [wx, ground].filter(Boolean).join(' · ');
  return `<div class="mc-local" style="font-size:11px;line-height:1.45;color:#475569;margin:-2px 0 6px">
    📍 <b style="color:#1f2a30">${L.area}</b> · city ${fmt(cityTemp, 1)}°${extra ? '<br>' + extra : ''}</div>`;
}

function renderImpactHTML() {
  if (!currentEdits || !currentEdits.active) return '';

  const dT = Number(currentEdits.dT || 0);
  const peakT = currentEdits.peakT != null ? Number(currentEdits.peakT) : null;
  const dPET = currentEdits.dPET != null ? Number(currentEdits.dPET) : (dT < 0 ? dT * 4.0 : dT * 2.5);
  const dPM = Number(currentEdits.dPM || 0);
  const dRunoff = currentEdits.dRunoffPct != null ? Number(currentEdits.dRunoffPct) : (dT < 0 ? -35 : (dT > 0 ? 15 : 0));

  const isWarming = dPET > 0.05 || dT > 0.05;

  const airMain = formatDelta(dT, '°C', 1) + ' air';
  const peakStr = peakT != null && Math.abs(peakT) >= 0.05 ? ` (peak ${formatDelta(peakT, '°C', 1)})` : '';
  const airText = airMain + peakStr;

  const feelLabel = dPET <= 0 ? 'shade feel' : 'feel';
  const feelText = `${formatDelta(dPET, '°C', 1)} ${feelLabel}`;

  const pmText = `PM2.5 ${formatDelta(dPM, '%', 0)}`;
  const runoffText = `Runoff ${formatDelta(dRunoff, '%', 0)}`;
  const ecoText = `${pmText} · ${runoffText}`;

  const badgeText = isWarming ? 'Warming / Sealed' : 'Design Impact';
  const hintText = isWarming ? 'Urban heat added' : 'Cooling & retention';
  const iconTemp = isWarming ? '🌡️' : '🍃';
  const iconFeel = isWarming ? '☀️' : '🌳';

  return `
    <div class="mc-impact ${isWarming ? 'warm' : 'cool'}">
      <div class="mc-impact-head">
        <span class="mc-impact-pill">${badgeText}</span>
        <span class="mc-impact-hint">${hintText}</span>
      </div>
      <div class="mc-impact-line">
        <span class="mc-impact-icon">${iconTemp}</span>
        <b>${airText}</b>
      </div>
      <div class="mc-impact-line">
        <span class="mc-impact-icon">${iconFeel}</span>
        <b>${feelText}</b>
      </div>
      <div class="mc-impact-line">
        <span class="mc-impact-icon">💧</span>
        <b>${ecoText}</b>
      </div>
    </div>`;
}

function renderBenchmarksHTML() {
  return `
    <div class="mc-benchmarks">
      <div class="mc-bench-title">Reference Air Quality Benchmarks</div>
      <div class="mc-bench-item"><b>EU 2030 limit:</b> PM2.5 10 · PM10 20 · NO₂ 20 µg/m³</div>
      <div class="mc-bench-item"><b>WHO guideline:</b> PM2.5 5 · PM10 15 · NO₂ 10 µg/m³</div>
      <div class="mc-bench-item"><b>Heilbronn LUBW baseline (Weinsberger Str.):</b> NO₂ 29 · PM10 15 µg/m³</div>
    </div>`;
}

function renderExtraImpactDetailsHTML() {
  if (!currentEdits || !currentEdits.active) return '';
  const rows = [];
  if (currentEdits.greenRoofM2) {
    rows.push(`<div class="mc-row mc-impact-detail"><span>Green roof</span><b>+${Math.round(currentEdits.greenRoofM2).toLocaleString()} m²</b></div>`);
  }
  if (currentEdits.solarRoofM2) {
    rows.push(`<div class="mc-row mc-impact-detail"><span>Solar roof</span><b>+${Math.round(currentEdits.solarRoofM2).toLocaleString()} m²</b></div>`);
  }
  if (currentEdits.solarKwhYr) {
    rows.push(`<div class="mc-row mc-impact-detail"><span>Rooftop solar</span><b>+${Math.round(currentEdits.solarKwhYr).toLocaleString()} kWh/yr</b></div>`);
  }
  if (currentEdits.carFreeLengthM) {
    rows.push(`<div class="mc-row mc-impact-detail"><span>Car-free street</span><b>+${Math.round(currentEdits.carFreeLengthM).toLocaleString()} m</b></div>`);
  }
  if (currentEdits.co2SavedKgYr) {
    const val = Number(currentEdits.co2SavedKgYr);
    const t = Math.abs(val) >= 1000 ? `${(val / 1000).toFixed(1)} t` : `${Math.round(val)} kg`;
    rows.push(`<div class="mc-row mc-impact-detail"><span>CO₂ avoided</span><b>−${t}/yr</b></div>`);
  }
  if (currentEdits.areaM2) {
    rows.push(`<div class="mc-row mc-impact-detail"><span>Intervention footprint</span><b>≈ ${Number(currentEdits.areaM2).toLocaleString()} m²</b></div>`);
  }
  return rows.join('');
}

// Snow / standing water level at the map centre (only shown when there is some)
function renderGroundRowsHTML() {
  const L = currentLocal;
  if (!L) return '';
  const rows = [];
  if (L.snowCm >= 1) rows.push(`<div class="mc-row"><span>Snow cover here</span><b>${fmt(L.snowCm, 0)} cm</b></div>`);
  if (L.waterCm >= 1) rows.push(`<div class="mc-row"><span>Standing water here</span><b>${fmt(L.waterCm, 0)} cm</b></div>`);
  return rows.join('');
}

async function load() {
  const q = `latitude=${LAT}&longitude=${LON}&timezone=Europe%2FBerlin`;
  const [w, a] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation`).then((r) => r.json()),
    fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone`).then((r) => r.json()),
  ]);
  return { w: w.current, a: a.current };
}

const LOCAL_NOTE = 'Temperature, humidity and PM2.5 are for the spot at the centre of the map: city values from Open-Meteo adjusted by a land-use model (illustrative).';

function render({ w, a }) {
  lastLiveData = { w, a };
  const L = currentLocal;
  const band = a.european_aqi == null ? null : aqiBand(a.european_aqi);
  const time = new Date(w.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  card.innerHTML = `
    <div class="mc-head"><span>Heilbronn · ${time}</span><span class="mc-chev">▾</span></div>
    <div class="mc-temp">${fmt(shifted(w.temperature_2m), 1)}°<small>feels ${fmt(shifted(w.apparent_temperature), 0)}°</small></div>
    ${renderLocalHTML(w.temperature_2m)}
    ${renderImpactHTML()}
    <div class="mc-row"><span>Air quality</span><b>${band ? `<span class="mc-dot" style="background:${band[2]}"></span>${band[1]} (${fmt(a.european_aqi)})` : '–'}</b></div>
    <div class="mc-row"><span>Humidity</span><b>${fmt(L ? L.RH : w.relative_humidity_2m)} %</b></div>
    <div class="mc-more">
      <div class="mc-row"><span>PM2.5</span><b>${fmt(L ? L.PM : a.pm2_5, 1)} µg/m³</b></div>
      <div class="mc-row"><span>PM10</span><b>${fmt(a.pm10, 1)} µg/m³</b></div>
      <div class="mc-row"><span>NO₂</span><b>${fmt(a.nitrogen_dioxide, 0)} µg/m³</b></div>
      <div class="mc-row"><span>Ozone</span><b>${fmt(a.ozone, 0)} µg/m³</b></div>
      <div class="mc-row"><span>Wind</span><b>${fmt(w.wind_speed_10m, 0)} km/h</b></div>
      <div class="mc-row"><span>Rain (now)</span><b>${fmt(w.precipitation, 1)} mm</b></div>
      ${renderGroundRowsHTML()}
      ${renderExtraImpactDetailsHTML()}
      ${renderBenchmarksHTML()}
      <div class="mc-note">${LOCAL_NOTE} Air quality, PM10, NO₂, ozone and wind are city-wide model data, not a local sensor.</div>
    </div>`;
}

// Monthly view for the time slider: m = { label, kind: 'measured' | 'projected', temp, tmax, hotDays, humidity, rain, aqi, pm2_5, pm10 }
export function showMonth(m) {
  monthShown = true;
  lastMonthData = m;
  const L = currentLocal;
  const band = m.aqi == null ? null : aqiBand(m.aqi);
  const badge = m.kind === 'projected' ? '<span class="mc-badge proj">projected</span>' : '<span class="mc-badge meas">measured</span>';
  const air = m.kind === 'projected' ? '<span class="mc-muted">no projection</span>'
    : band ? `<span class="mc-dot" style="background:${band[2]}"></span>${band[1]} (${fmt(m.aqi)})` : '–';
  card.innerHTML = `
    <div class="mc-head"><span>Heilbronn · ${m.label}</span>${badge}</div>
    <div class="mc-temp">${fmt(shifted(m.temp), 1)}°<small>avg · max ${fmt(shifted(m.tmax), 0)}°</small></div>
    ${renderLocalHTML(m.temp)}
    ${renderImpactHTML()}
    <div class="mc-row"><span>Air quality</span><b>${air}</b></div>
    <div class="mc-row"><span>Humidity</span><b>${fmt(L ? L.RH : m.humidity)} %</b></div>
    <div class="mc-more">
      <div class="mc-row"><span>Hot days (≥ 30°)</span><b>${fmt(m.hotDays)}</b></div>
      <div class="mc-row"><span>Tropical nights (≥ 20°)</span><b>${fmt(m.tropicalNights)}</b></div>
      <div class="mc-row"><span>Rain (month)</span><b>${fmt(m.rain, 0)} mm</b></div>
      <div class="mc-row"><span>Heavy-rain days (≥ 20 mm)</span><b>${fmt(m.heavyRainDays)}</b></div>
      <div class="mc-row"><span>Wind (avg)</span><b>${fmt(m.wind, 0)} km/h</b></div>
      <div class="mc-row"><span>PM2.5${m.kind === 'projected' ? ' (estimate)' : ''}</span><b>${fmt(L ? L.PM : m.pm2_5, 1)} µg/m³</b></div>
      <div class="mc-row"><span>PM10${m.kind === 'projected' ? ' (estimate)' : ''}</span><b>${fmt(m.pm10, 1)} µg/m³</b></div>
      ${renderGroundRowsHTML()}
      ${renderExtraImpactDetailsHTML()}
      ${renderBenchmarksHTML()}
      <div class="mc-note">${LOCAL_NOTE} ${m.kind === 'projected'
        ? `Month values: average of ${m.models ?? 7} climate models (CMIP6 HighResMIP via Open-Meteo), this month in ${m.years ? m.years.join('–') : '±5 years'}, bias-corrected against measured 2021–2025. A projection, not a forecast. PM estimate: Europe-wide SSP2-4.5 trend (Clayton et al. 2024) applied to Heilbronn's 2023–25 values; no projection for air-quality index, NO₂ or ozone.`
        : 'Month values: monthly average of measured history (ERA5 reanalysis and CAMS air quality via Open-Meteo).'}</div>
    </div>`;
}
export function showMonthLoading(label) {
  monthShown = true;
  const headSpan = card.querySelector('.mc-head span');
  if (headSpan) headSpan.textContent = `Heilbronn · ${label}`;
  const tempEl = card.querySelector('.mc-temp');
  if (tempEl) tempEl.textContent = '…';
}
export function showLive() {
  monthShown = false;
  if (lastLiveData) render(lastLiveData);
  refresh();
}

async function refresh() {
  try {
    const data = await load();
    if (!monthShown) render(data);
  } catch (err) {
    console.error('metrics card: Open-Meteo failed', err);
    if (!monthShown) {
      const tempEl = card.querySelector('.mc-temp');
      if (tempEl) tempEl.textContent = 'offline';
    }
  }
}
refresh();
setInterval(refresh, REFRESH_MS);