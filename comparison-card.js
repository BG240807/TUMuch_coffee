export function addComparisonCard({ map, scene, placed, deleted }) {
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = new URL('./comparison-card.css', import.meta.url).href;
  document.head.appendChild(style);

  const card = document.createElement('aside');
  card.id = 'comparison-card';
  card.setAttribute('aria-label', 'Scenario comparison');
  card.innerHTML = `
    <div class="cc-head"><h3>Scenario comparison</h3><button type="button" class="cc-min" title="Collapse">–</button></div>
    <div class="cc-body">
    <div class="cc-toggle" role="group" aria-label="Map view">
      <button type="button" aria-pressed="false" disabled>Original</button>
      <button type="button" aria-pressed="true" disabled>Proposal</button>
    </div>
    <table>
      <caption>Changes from the unedited city</caption>
      <thead><tr><th scope="col">Change</th><th scope="col">Original</th><th scope="col">Proposal</th></tr></thead>
      <tbody>
        <tr><th scope="row">Added trees</th><td>0</td><td>0</td></tr>
        <tr><th scope="row">Added buildings</th><td>0</td><td>0</td></tr>
        <tr><th scope="row">Removed buildings</th><td>0</td><td>0</td></tr>
        <tr><th scope="row">Added canopy</th><td>0.0 m²</td><td>0.0 m²</td></tr>
        <tr><th scope="row">Green roof</th><td>0 m²</td><td>0 m²</td></tr>
        <tr><th scope="row">Solar roof</th><td>0 m²</td><td>0 m²</td></tr>
        <tr><th scope="row">Solar energy</th><td>0 kWh/yr</td><td>0 kWh/yr</td></tr>
        <tr><th scope="row">CO₂ avoided</th><td>0.0 t/yr</td><td>0.0 t/yr</td></tr>
        <tr><th scope="row">Car-free street</th><td>0 m</td><td>0 m</td></tr>
      </tbody>
    </table>
    <p>Canopy: sum of circular tree crowns, including overlaps. Not city-wide coverage or a climate prediction.</p>
    <p class="cc-status" role="status">Viewing proposal · editing enabled</p>
    </div>`;
  document.body.appendChild(card);
  const toolbar = document.getElementById('ui');
  new ResizeObserver(() => {
    card.style.top = `${toolbar.offsetTop + toolbar.offsetHeight + 10}px`;
  }).observe(toolbar);

  const minBtn = card.querySelector('.cc-min');
  minBtn.addEventListener('click', () => {
    const collapsed = card.classList.toggle('collapsed');
    minBtn.textContent = collapsed ? '+' : '–';
  });
  const [original, proposal] = card.querySelectorAll('.cc-toggle button');
  const cells = card.querySelectorAll('tbody tr td:last-child');
  const tools = document.querySelectorAll('#ui button');
  const status = card.querySelector('.cc-status');
  let originalShown = false;
  let previousTool;
  // Hide asynchronous arrivals before their first frame in Original.
  scene.onBeforeRender = () => {
    if (originalShown) for (const p of placed) p.obj.visible = false;
  };

  const MLAT = 111132.954;
  const MLNG = MLAT * Math.cos((49.142 * Math.PI) / 180);
  function ringArea(ring) {
    if (!ring || ring.length < 3) return 0;
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0] * MLNG, yi = ring[i][1] * MLAT;
      const xj = ring[j][0] * MLNG, yj = ring[j][1] * MLAT;
      a += xj * yi - xi * yj;
    }
    return Math.abs(a) / 2;
  }

  function update() {
    let trees = 0, buildings = 0, canopy = 0, greenM2 = 0, solarM2 = 0;
    for (const p of placed) {
      p.obj.visible = !originalShown;
      if (p.type === 'tree') {
        trees++;
        // The existing tree model has a 3 m crown radius before its group scale.
        canopy += Math.PI * (3 * p.obj.scale.x) ** 2;
      } else {
        buildings++;
        const u = p.obj.userData || {};
        const area = u.area || (u.w && u.d ? u.w * u.d : 140);
        if (u.roofType === 'green') greenM2 += area;
        else if (u.roofType === 'solar') solarM2 += area;
      }
    }

    if (window.__app?.retrofitted && window.__app?.buildings) {
      const retroEntries = window.__app.retrofitted instanceof Map
        ? window.__app.retrofitted.entries()
        : Object.entries(window.__app.retrofitted);
      for (const [key, type] of retroEntries) {
        if (!type) continue;
        let b = window.__app.buildings.get(key);
        if (!b) {
          for (const cand of window.__app.buildings.values()) {
            if (cand.key === key || String(cand.props?.bid) === key) {
              b = cand;
              break;
            }
          }
        }
        if (!b) continue;
        if (window.__app.isDeleted && window.__app.isDeleted(b)) continue;
        const area = ringArea(b.poly?.[0]);
        if (type === 'green') greenM2 += area;
        else if (type === 'solar') solarM2 += area;
      }
    }

    const solarKwh = Math.round(solarM2 * 90);   // 150 kWh/m² panel × 60 % usable roof
    const co2Tons = ((solarKwh * 0.363) / 1000).toFixed(1);

    let carFreeM = 0;
    if (window.__app?.carFreeLines) {
      for (const cf of window.__app.carFreeLines) {
        carFreeM += cf.lengthM || 0;
      }
    }

    const values = [
      trees,
      buildings,
      new Set(deleted.filter(Boolean).map(p => p.join(','))).size,
      `${canopy.toFixed(1)} m²`,
      `${Math.round(greenM2).toLocaleString()} m²`,
      `${Math.round(solarM2).toLocaleString()} m²`,
      `${Math.round(solarKwh).toLocaleString()} kWh/yr`,
      `${co2Tons} t/yr`,
      `${Math.round(carFreeM).toLocaleString()} m`
    ];
    values.forEach((value, i) => {
      if (cells[i] && cells[i].textContent !== String(value)) cells[i].textContent = value;
    });
  }

  function setOriginal(show) {
    if (show === originalShown) return;
    originalShown = show;
    if (show) {
      previousTool = document.querySelector('#ui button.active');
      document.getElementById('btnNav').click();
    }
    document.querySelectorAll('#ui button').forEach(button => { button.disabled = show && button.id !== 'btnNav'; });
    if (!show && previousTool) previousTool.click();
    for (const id of ['buildings-3d', 'buildings-own', 'buildings-retrofitted', 'carfree-lines-fill', 'carfree-lines-casing', 'carfree-lines-center']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'none' : 'visible');
    }
    map.setLayoutProperty('comparison-original', 'visibility', show ? 'visible' : 'none');
    original.setAttribute('aria-pressed', String(show));
    proposal.setAttribute('aria-pressed', String(!show));
    status.textContent = show ? 'Viewing original · editing paused' : 'Viewing proposal · editing enabled';
    window.dispatchEvent(new CustomEvent('view-original', { detail: show })); // climate-layer.js hides edits too
    update();
  }

  function setup() {
    // Use the original vector source so baseline buildings also follow newly loaded tiles.
    const layer = map.getStyle().layers.find(layer => layer.id === 'buildings-3d');
    map.addLayer({ ...layer, id: 'comparison-original', layout: { visibility: 'none' },
      paint: { ...layer.paint, 'fill-extrusion-opacity': 0.9 } }, 'three-layer');
    original.disabled = proposal.disabled = false;
  }
  original.addEventListener('click', () => setOriginal(true));
  proposal.addEventListener('click', () => setOriginal(false));
  window.addEventListener('scene-changed', update);
  if (map.getLayer('buildings-3d')) setup();
  else map.once('load', setup);
  update();
  setInterval(update, 250);
}
