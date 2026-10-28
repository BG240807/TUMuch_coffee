// Floating metrics card: live city values for Heilbronn from Open-Meteo (no API key).
// Compact: temperature, felt temperature, air quality (European AQI), humidity. Click to expand.
// Self-contained: only adds its own element, does not touch map clicks or tools.
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

const fmt = (v, digits = 0) => (v == null ? '–' : Number(v).toFixed(digits));

async function load() {
  const q = `latitude=${LAT}&longitude=${LON}&timezone=Europe%2FBerlin`;
  const [w, a] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?${q}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,precipitation`).then((r) => r.json()),
    fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone`).then((r) => r.json()),
  ]);
  return { w: w.current, a: a.current };
}

function render({ w, a }) {
  const band = a.european_aqi == null ? null : aqiBand(a.european_aqi);
  const time = new Date(w.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  card.innerHTML = `
    <div class="mc-head"><span>Heilbronn · ${time}</span><span class="mc-chev">▾</span></div>
    <div class="mc-temp">${fmt(w.temperature_2m, 1)}°<small>feels ${fmt(w.apparent_temperature, 0)}°</small></div>
    <div class="mc-row"><span>Air quality</span><b>${band ? `<span class="mc-dot" style="background:${band[2]}"></span>${band[1]} (${fmt(a.european_aqi)})` : '–'}</b></div>
    <div class="mc-row"><span>Humidity</span><b>${fmt(w.relative_humidity_2m)} %</b></div>
    <div class="mc-more">
      <div class="mc-row"><span>PM2.5</span><b>${fmt(a.pm2_5, 1)} µg/m³</b></div>
      <div class="mc-row"><span>PM10</span><b>${fmt(a.pm10, 1)} µg/m³</b></div>
      <div class="mc-row"><span>NO₂</span><b>${fmt(a.nitrogen_dioxide, 0)} µg/m³</b></div>
      <div class="mc-row"><span>Ozone</span><b>${fmt(a.ozone, 0)} µg/m³</b></div>
      <div class="mc-row"><span>Wind</span><b>${fmt(w.wind_speed_10m, 0)} km/h</b></div>
      <div class="mc-row"><span>Rain</span><b>${fmt(w.precipitation, 1)} mm</b></div>
      <div class="mc-note">City-wide values from Open-Meteo (model data, not a local sensor).</div>
    </div>`;
}

// Monthly view for the time slider: m = { label, kind: 'measured' | 'projected', temp, tmax, hotDays, humidity, rain, aqi, pm2_5, pm10 }
let monthShown = false;
export function showMonth(m) {
  monthShown = true;
  const band = m.aqi == null ? null : aqiBand(m.aqi);
  const badge = m.kind === 'projected' ? '<span class="mc-badge proj">projected</span>' : '<span class="mc-badge meas">measured</span>';
  const air = m.kind === 'projected' ? '<span class="mc-muted">no projection</span>'
    : band ? `<span class="mc-dot" style="background:${band[2]}"></span>${band[1]} (${fmt(m.aqi)})` : '–';
  card.innerHTML = `
    <div class="mc-head"><span>Heilbronn · ${m.label}</span>${badge}</div>
    <div class="mc-temp">${fmt(m.temp, 1)}°<small>avg · max ${fmt(m.tmax, 0)}°</small></div>
    <div class="mc-row"><span>Air quality</span><b>${air}</b></div>
    <div class="mc-row"><span>Humidity</span><b>${fmt(m.humidity)} %</b></div>
    <div class="mc-more">
      <div class="mc-row"><span>Hot days (≥ 30°)</span><b>${fmt(m.hotDays)}</b></div>
      <div class="mc-row"><span>Rain (month)</span><b>${fmt(m.rain, 0)} mm</b></div>
      ${m.kind === 'projected' ? '' : `
      <div class="mc-row"><span>PM2.5</span><b>${fmt(m.pm2_5, 1)} µg/m³</b></div>
      <div class="mc-row"><span>PM10</span><b>${fmt(m.pm10, 1)} µg/m³</b></div>`}
      <div class="mc-note">${m.kind === 'projected'
        ? `Average of ${m.models ?? 7} climate models (CMIP6 HighResMIP via Open-Meteo), this month in ${m.years ? m.years.join('–') : '±5 years'}. A projection, not a forecast; no air-quality projection.`
        : 'Monthly average of measured history (ERA5 reanalysis and CAMS air quality via Open-Meteo).'}</div>
    </div>`;
}
export function showMonthLoading(label) {
  monthShown = true;
  card.querySelector('.mc-head span').textContent = `Heilbronn · ${label}`;
  card.querySelector('.mc-temp').textContent = '…';
}
export function showLive() {
  monthShown = false;
  refresh();
}

async function refresh() {
  try {
    const data = await load();
    if (!monthShown) render(data);
  } catch (err) {
    console.error('metrics card: Open-Meteo failed', err);
    if (!monthShown) card.querySelector('.mc-temp').textContent = 'offline';
  }
}
refresh();
setInterval(refresh, REFRESH_MS);
