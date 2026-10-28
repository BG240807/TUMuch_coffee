function createIntroScreen() {
  if (new URLSearchParams(window.location.search).has('nointro')) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'intro-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'TUMuch Coffee');

  const card = document.createElement('div');
  card.className = 'intro-card';

  const logo = document.createElement('img');
  logo.className = 'intro-logo';
  logo.src = 'assets/pitch/logo-tumuch-coffee.jpg';
  logo.alt = 'TUMuch Coffee';
  logo.width = 120;
  logo.addEventListener('error', () => {
    logo.style.display = 'none';
  });

  const title = document.createElement('h2');
  title.className = 'intro-title';
  title.textContent = 'TUMuch Coffee';

  const subtitle = document.createElement('p');
  subtitle.className = 'intro-subtitle';
  subtitle.textContent = '3D Climate Map of Heilbronn: see today, explore 2050, plan greener streets';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'intro-btn';
  btn.textContent = 'Explore the map';

  card.append(logo, title, subtitle, btn);
  overlay.appendChild(card);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    overlay.classList.add('intro-fade-out');
    window.removeEventListener('keydown', onKeyDown);
    setTimeout(() => {
      overlay.hidden = true;
      overlay.remove();
    }, 400);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dismiss();
    }
  };

  btn.addEventListener('click', dismiss);
  window.addEventListener('keydown', onKeyDown);

  document.body.appendChild(overlay);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createIntroScreen);
} else {
  createIntroScreen();
}
