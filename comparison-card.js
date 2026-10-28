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

  function update() {
    let trees = 0, buildings = 0, canopy = 0;
    for (const p of placed) {
      p.obj.visible = !originalShown;
      if (p.type === 'tree') {
        trees++;
        // The existing tree model has a 3 m crown radius before its group scale.
        canopy += Math.PI * (3 * p.obj.scale.x) ** 2;
      } else {
        buildings++;
      }
    }
    const values = [trees, buildings, new Set(deleted.map(p => p.join(','))).size, `${canopy.toFixed(1)} m²`];
    values.forEach((value, i) => {
      if (cells[i].textContent !== String(value)) cells[i].textContent = value;
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
    for (const id of ['buildings-3d', 'buildings-own']) {
      map.setLayoutProperty(id, 'visibility', show ? 'none' : 'visible');
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
  if (map.getLayer('buildings-3d')) setup();
  else map.once('load', setup);
  update();
  setInterval(update, 250);
}
