// Map legend: colours match the base map and buildings set in index.html
const LEGEND_ITEMS = [
  { label: 'Parks', color: '#cfe6c2' },
  { label: 'Grass & meadows', color: '#d6ebc8' },
  { label: 'Forest', color: '#b7d9a8' },
  { label: 'Water', color: '#a9cfe6' },
  { label: 'Buildings', color: '#e8e4dc' },
  { label: 'Roads', color: '#ffffff' },
];

function createLegend() {
  const card = document.createElement('aside');
  card.className = 'map-legend';
  card.setAttribute('aria-label', 'Map legend');

  const header = document.createElement('div');
  header.className = 'map-legend-header';

  const title = document.createElement('span');
  title.className = 'map-legend-title';
  title.textContent = 'Map';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'map-legend-toggle';
  toggle.textContent = '–';
  toggle.title = 'Collapse legend';
  toggle.setAttribute('aria-expanded', 'true');

  const list = document.createElement('ul');
  list.className = 'map-legend-rows';

  for (const item of LEGEND_ITEMS) {
    const row = document.createElement('li');
    row.className = 'map-legend-row';

    const swatch = document.createElement('span');
    swatch.className = 'map-legend-swatch';
    swatch.style.backgroundColor = item.color;

    const label = document.createElement('span');
    label.textContent = item.label;

    row.append(swatch, label);
    list.appendChild(row);
  }

  toggle.addEventListener('click', () => {
    const collapsed = card.classList.toggle('collapsed');
    toggle.textContent = collapsed ? '+' : '–';
    toggle.title = collapsed ? 'Expand legend' : 'Collapse legend';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });

  header.append(title, toggle);
  card.append(header, list);
  document.body.appendChild(card);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createLegend);
} else {
  createLegend();
}
