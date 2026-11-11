// Site menu: one button in the header that opens a list of every page, the current one marked.
(function () {
  'use strict';
  const GROUPS = [
    ['Points', [['index.html', 'xPoints', 'Expected points by gameweek'], ['planner.html', 'Planner', 'Best transfers for your team']]],
    ['Players', [['minutes.html', 'Minutes', 'Played minutes and xMin'], ['chances.html', 'Chance 90min', 'Goals, assists, clean sheets…'],
      ['setpieces.html', 'Set pieces', 'Penalty, free kick and corner takers'], ['oop.html', 'OOP', 'Out of position players'],
      ['injuries.html', 'Injuries', 'Absence log']]],
    ['About', [['explain.html', 'How it works', 'The formula, step by step'], ['backtest.txt', 'Accuracy', 'Model against real results'],
      ['admin.html', 'Admin', 'Minutes and absences']]],
  ];
  const nav = document.querySelector('nav.sitenav');
  if (!nav) return;
  const here = location.pathname.split('/').pop() || 'index.html';
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids); return n; };

  const button = el('button', { type: 'button', className: 'menu-btn', ariaExpanded: 'false' },
    el('span', { className: 'bars', ariaHidden: 'true' }, el('i'), el('i'), el('i')), el('span', { className: 'menu-label', textContent: 'Menu' }));
  button.setAttribute('aria-controls', 'sitemenu');
  button.setAttribute('aria-expanded', 'false');
  const panel = el('div', { id: 'sitemenu', className: 'menu-panel' });
  panel.hidden = true;
  GROUPS.forEach(([title, pages]) => {
    panel.append(el('p', { className: 'menu-group', textContent: title }), el('ul', {}, ...pages.map(([href, name, desc]) => {
      const a = el('a', { href }, el('b', { textContent: name }), el('span', { textContent: desc }));
      if (href === here) { a.setAttribute('aria-current', 'page'); a.className = 'current'; }
      return el('li', {}, a);
    })));
  });
  nav.replaceChildren(button, panel);

  const open = (yes) => {
    panel.hidden = !yes;
    button.setAttribute('aria-expanded', String(yes));
    nav.classList.toggle('open', yes);
    if (yes) (panel.querySelector('a.current') || panel.querySelector('a')).focus({ preventScroll: true });
  };
  button.addEventListener('click', () => open(panel.hidden));
  document.addEventListener('click', (e) => { if (!panel.hidden && !nav.contains(e.target)) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); button.focus(); } });
})();
