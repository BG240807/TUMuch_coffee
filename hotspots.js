// Hotspots menu: compact round 📍 button by the zoom/compass controls that opens a popover list
// of Heilbronn neighbourhoods plus ↺ Reset city.

export const HOTSPOTS = [
  { id: 'marktplatz', name: 'Marktplatz', center: [9.2191, 49.1417], zoom: 17.5, pitch: 60, bearing: -20 },
  { id: 'neckarbogen', name: 'Neckarbogen', center: [9.2109, 49.1475], zoom: 17, pitch: 65, bearing: 30 },
  { id: 'experimenta', name: 'Experimenta', center: [9.2155, 49.1448], zoom: 17.5, pitch: 65, bearing: -45 },
  { id: 'wollhaus', name: 'Wollhaus', center: [9.2212, 49.1388], zoom: 17, pitch: 60, bearing: 0 },
];

export function addHotspots({ map }) {
  const wrap = document.createElement('div');
  wrap.id = 'hotspot-pill';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.id = 'hotspot-btn';
  trigger.className = 'hotspot-btn';
  trigger.textContent = '📍';
  trigger.title = 'City hotspots';
  trigger.setAttribute('aria-label', 'City hotspots');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-haspopup', 'true');

  const menu = document.createElement('div');
  menu.id = 'hotspot-menu';
  menu.className = 'hotspot-popover';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'City hotspots');
  menu.hidden = true;

  const buttons = new Map();

  function setOpen(open) {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }

  function setActive(activeId) {
    buttons.forEach((btn, id) => {
      btn.classList.toggle('active', id === activeId);
      btn.setAttribute('aria-pressed', String(id === activeId));
    });
  }

  function flyToSpot(spot) {
    setActive(spot.id);
    setOpen(false);
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
    btn.setAttribute('role', 'menuitem');
    btn.textContent = spot.name;
    btn.title = `Fly to ${spot.name}`;
    btn.addEventListener('click', () => flyToSpot(spot));
    menu.appendChild(btn);
    buttons.set(spot.id, btn);
  });

  const sep = document.createElement('div');
  sep.className = 'hp-sep';
  sep.setAttribute('role', 'separator');
  menu.appendChild(sep);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.id = 'btnResetCity';
  resetBtn.className = 'hp-reset';
  resetBtn.setAttribute('role', 'menuitem');
  resetBtn.textContent = '↺ Reset city';
  resetBtn.title = 'Reset all changes back to baseline';
  resetBtn.addEventListener('click', () => {
    setOpen(false);
    window.__app?.resetCity?.();
  });
  menu.appendChild(resetBtn);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setOpen(false);
    }
  });

  const closeOutside = (e) => {
    if (!menu.hidden && !wrap.contains(e.target)) {
      setOpen(false);
    }
  };
  document.addEventListener('pointerdown', closeOutside);
  document.addEventListener('click', closeOutside);

  wrap.append(trigger, menu);
  document.body.appendChild(wrap);

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
