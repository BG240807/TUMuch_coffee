const DATA_SOURCES = [
  'Trees: Datenquelle: Stadt Heilbronn, www.heilbronn.de (dl-de/by-2-0)',
  'Buildings & base map: © OpenStreetMap contributors, OpenFreeMap',
  'Weather & air quality: Open-Meteo.com',
  'Terrain: AWS Terrain Tiles',
];

function createAboutCard() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'about-btn';
  btn.textContent = 'i';
  btn.title = 'About this map';
  btn.setAttribute('aria-label', 'About this map');
  btn.setAttribute('aria-expanded', 'false');

  const card = document.createElement('aside');
  card.className = 'about-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'About this map');
  card.hidden = true;

  const title = document.createElement('h3');
  title.className = 'about-card-title';
  title.textContent = 'About this map';

  const list = document.createElement('ul');
  list.className = 'about-card-list';

  for (const source of DATA_SOURCES) {
    const li = document.createElement('li');
    li.textContent = source;
    list.appendChild(li);
  }

  card.append(title, list);

  const setOpen = (open) => {
    card.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  };

  btn.addEventListener('click', () => {
    setOpen(card.hidden);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !card.hidden) {
      setOpen(false);
    }
  });

  document.body.append(btn, card);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createAboutCard);
} else {
  createAboutCard();
}
