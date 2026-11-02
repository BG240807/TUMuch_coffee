const DATA_SOURCES = [
  'Trees: Datenquelle: Stadt Heilbronn, www.heilbronn.de (dl-de/by-2-0)',
  'Buildings & base map: © OpenStreetMap contributors, OpenFreeMap',
  'Weather & air quality: Open-Meteo.com',
  'Terrain: AWS Terrain Tiles',
];

const SCIENTIFIC_SOURCES = [
  {
    title: 'German Heatwave Canopy Cooling',
    desc: 'Empirical microclimate studies: −0.8 °C ambient air cooling per +10% canopy cover (capped at −1.5 °C for +30% canopy cover); −4 to −11 °C PET (physiologically equivalent temperature / shade feel) reduction via solar shielding and evapotranspirative cooling.',
  },
  {
    title: 'SuDS Stormwater Retention',
    desc: 'Sustainable Drainage Systems (SuDS) hydrology: 30–50% stormwater runoff reduction through unsealed green infiltration areas vs. ~95% runoff on impervious concrete surfaces.',
  },
  {
    title: 'EU Air Quality Directive 2024/2881',
    desc: 'Legally binding targets effective 2030: PM2.5 10 µg/m³ · PM10 20 µg/m³ · NO₂ 20 µg/m³ (annual mean thresholds).',
  },
  {
    title: 'WHO 2021 Global Air Quality Guidelines',
    desc: 'Health protection guidelines: PM2.5 5 µg/m³ · PM10 15 µg/m³ · NO₂ 10 µg/m³.',
  },
  {
    title: 'LUBW (2023) Heilbronn Baseline',
    desc: 'Landesanstalt für Umwelt Baden-Württemberg official monitoring station Weinsberger Str.: NO₂ 29 µg/m³ · PM10 15 µg/m³ annual baseline.',
  },
  {
    title: 'Climate & PM projections to 2050',
    desc: 'Weather: 7 CMIP6 HighResMIP models via Open-Meteo, bias-corrected against measured 2021–2025 Heilbronn data. PM2.5/PM10: estimate from the Europe-wide SSP2-4.5 trend (Clayton et al. 2024, ACP 24:10717). Effects of edits are estimates from a simple model using published effect sizes.',
  },
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
  card.style.maxWidth = '340px';
  card.style.maxHeight = '80vh';
  card.style.overflowY = 'auto';

  const title = document.createElement('h3');
  title.className = 'about-card-title';
  title.textContent = 'Data Sources';

  const list = document.createElement('ul');
  list.className = 'about-card-list';

  for (const source of DATA_SOURCES) {
    const li = document.createElement('li');
    li.textContent = source;
    list.appendChild(li);
  }

  const sciTitle = document.createElement('h3');
  sciTitle.className = 'about-card-title';
  sciTitle.style.marginTop = '12px';
  sciTitle.textContent = 'Scientific Model & Sources';

  const sciList = document.createElement('ul');
  sciList.className = 'about-card-list';

  for (const item of SCIENTIFIC_SOURCES) {
    const li = document.createElement('li');
    li.style.marginBottom = '6px';
    li.innerHTML = `<strong>${item.title}:</strong> ${item.desc}`;
    sciList.appendChild(li);
  }

  card.append(title, list, sciTitle, sciList);

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
