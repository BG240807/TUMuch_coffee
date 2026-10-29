// Hotspots pill: quick jump between Heilbronn neighbourhoods for testing interventions.

export const HOTSPOTS = [
  { id: 'marktplatz', name: 'Marktplatz', center: [9.2191, 49.1417], zoom: 17.5, pitch: 60, bearing: -20 },
  { id: 'neckarbogen', name: 'Neckarbogen', center: [9.2109, 49.1475], zoom: 17, pitch: 65, bearing: 30 },
  { id: 'experimenta', name: 'Experimenta', center: [9.2155, 49.1448], zoom: 17.5, pitch: 65, bearing: -45 },
  { id: 'wollhaus', name: 'Wollhaus', center: [9.2212, 49.1388], zoom: 17, pitch: 60, bearing: 0 },
];

export function addHotspots({ map }) {
  const pill = document.createElement('div');
  pill.id = 'hotspot-pill';
  pill.setAttribute('role', 'group');
  pill.setAttribute('aria-label', 'City hotspots');

  const label = document.createElement('span');
  label.className = 'hp-title';
  label.textContent = '📍';
  label.setAttribute('aria-hidden', 'true');
  pill.appendChild(label);

  const buttons = new Map();

  function setActive(activeId) {
    buttons.forEach((btn, id) => {
      btn.classList.toggle('active', id === activeId);
      btn.setAttribute('aria-pressed', String(id === activeId));
    });
  }

  function flyToSpot(spot) {
    setActive(spot.id);
    map.flyTo({
      center: spot.center,
      zoom: spot.zoom,
      pitch: spot.pitch,
      bearing: spot.bearing,
      duration: 2500,
      essential: true
    });
  }

  HOTSPOTS.forEach((spot) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = `btnHotspot-${spot.id}`;
    btn.textContent = spot.name;
    btn.title = `Fly to ${spot.name}`;
    btn.addEventListener('click', () => flyToSpot(spot));
    pill.appendChild(btn);
    buttons.set(spot.id, btn);
  });

  document.body.appendChild(pill);

  function updateProximity() {
    const c = map.getCenter();
    let closest = null, minDist = 0.005; // ~500m
    for (const spot of HOTSPOTS) {
      const d = Math.hypot(c.lng - spot.center[0], c.lat - spot.center[1]);
      if (d < minDist) {
        minDist = d;
        closest = spot.id;
      }
    }
    setActive(closest);
  }

  map.on('moveend', updateProximity);
  updateProximity();

  window.__app = window.__app || {};
  window.__app.hotspots = {
    list: HOTSPOTS,
    flyTo: (id) => {
      const spot = HOTSPOTS.find((s) => s.id === id);
      if (spot) flyToSpot(spot);
    }
  };
}
