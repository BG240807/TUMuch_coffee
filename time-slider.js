// Time slider: pick a month from 2020 to 2050. The metrics card then shows that month for Heilbronn:
// past months = measured history, future months = climate projection, both precomputed in
// data/climate-months.json (scripts/fetch_climate.py), so dragging needs no API calls and works offline.
// Today ("Now") shows the live values again. Self-contained: own element only, no map clicks.
import { showMonth, showLive } from './metrics-card.js';

const START_YEAR = 2020, END_YEAR = 2050;
const PROJ_WINDOW = 5, PROJ_FIRST = 2021; // projection: same month averaged over Y-5..Y+5 (see fetch_climate.py)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const now = new Date();
const toIndex = (y, m) => (y - START_YEAR) * 12 + m; // m = 0..11
const fromIndex = (i) => ({ y: START_YEAR + Math.floor(i / 12), m: i % 12 });
const TODAY = toIndex(now.getFullYear(), now.getMonth());
const MAX = toIndex(END_YEAR, 11);
const label = ({ y, m }) => `${MONTHS[m]} ${y}`;
const pct = (i) => `${(i / MAX) * 100}%`;

const el = document.createElement('div');
el.id = 'time-slider';
el.innerHTML = `
  <div class="ts-top"><span class="ts-label">Now</span><button class="ts-now" disabled>Now</button></div>
  <div class="ts-track">
    <input type="range" min="0" max="${MAX}" step="1" value="${TODAY}" aria-label="Month">
    <div class="ts-today" style="left:${pct(TODAY)}"></div>
  </div>
  <div class="ts-split"><span class="meas" style="left:${pct(TODAY)}">measured</span><span class="proj" style="left:${pct(TODAY)}">projected</span></div>
  <div class="ts-years"><span>${START_YEAR}</span><span>2030</span><span>2040</span><span>${END_YEAR}</span></div>`;
document.body.appendChild(el);
const input = el.querySelector('input');
const labelEl = el.querySelector('.ts-label');
const nowBtn = el.querySelector('.ts-now');

const pad = (n) => String(n).padStart(2, '0');
const months = fetch('data/climate-months.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
  .then((j) => j.months)
  .catch((err) => { console.error('time slider: could not load data/climate-months.json', err); return {}; });

async function loadMonth(i) {
  const ym = fromIndex(i);
  const kind = i > TODAY ? 'projected' : 'measured';
  const d = (await months)[`${ym.y}-${pad(ym.m + 1)}`];
  if (!d) return { label: label(ym), kind }; // missing month: the card shows dashes
  return { label: label(ym), kind, temp: d.t, tmax: d.tx, hotDays: d.hd, tropicalNights: d.tn, heavyRainDays: d.hr,
    humidity: d.h, rain: d.r, wind: d.w,
    aqi: d.aqi, pm2_5: d.pm25, pm10: d.pm10,
    models: d.n, years: kind === 'projected' ? [Math.max(ym.y - PROJ_WINDOW, PROJ_FIRST), Math.min(ym.y + PROJ_WINDOW, END_YEAR)] : null };
}

let wanted = TODAY;

function select(i) {
  wanted = i;
  const atNow = i === TODAY;
  labelEl.textContent = atNow ? 'Now' : label(fromIndex(i));
  nowBtn.disabled = atNow;
  if (atNow) return showLive();
  loadMonth(i).then((m) => { if (wanted === i) showMonth(m); });
}

input.addEventListener('input', () => select(Number(input.value)));
nowBtn.addEventListener('click', () => { input.value = TODAY; select(TODAY); });
