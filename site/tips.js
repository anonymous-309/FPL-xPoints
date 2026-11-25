// No hover tooltips anywhere: every title="…" becomes data-tip, and a tap or click on that element shows the text in
// a small pop-up (except on buttons, links and other things that already do something when clicked).
(function () {
  'use strict';
  const strip = (root) => {
    const all = root.querySelectorAll ? root.querySelectorAll('[title]') : [];
    [root, ...all].forEach((n) => {
      if (!n.getAttribute || !n.hasAttribute('title') || n.tagName === 'TITLE' || n.tagName === 'svg') return;
      const t = n.getAttribute('title');
      n.removeAttribute('title');
      if (t && t.trim()) n.dataset.tip = t;
    });
  };
  const start = () => {
    strip(document.body);
    new MutationObserver((ms) => ms.forEach((m) => {
      if (m.type === 'attributes') strip(m.target);
      m.addedNodes.forEach((n) => { if (n.nodeType === 1) strip(n); });
    })).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  };
  let pop = null, popFor = null;
  const close = () => { if (pop) { pop.remove(); pop = null; } };
  document.addEventListener('click', (e) => {
    if (pop && pop.contains(e.target) && !e.target.closest('.tip-close')) return;
    const had = !!pop;
    close();
    const n = e.target.closest('[data-tip]');
    if (!n) return;
    // things that already do something on click keep doing just that
    const busy = 'button, a, select, input, textarea, label, summary, [role="button"], .gw, .stat-row, .info-btn, .pp-card';
    for (let x = e.target; x; x = x.parentElement) {  // only between what was tapped and the element with the note
      if (x.matches(busy)) return;
      if (x === n) break;
    }
    if (had && n === popFor) { popFor = null; return; }  // a second tap on the same thing closes it
    popFor = n;
    pop = document.createElement('div');
    pop.className = 'tip-pop';
    pop.setAttribute('role', 'dialog');
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'tip-close'; x.textContent = '×'; x.setAttribute('aria-label', 'Close');
    const body = document.createElement('div');
    body.textContent = n.dataset.tip;
    pop.append(x, body);
    document.body.append(pop);
    const r = n.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 16);
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + window.scrollX}px`;
    const below = r.bottom + 6 + pop.offsetHeight < window.innerHeight;
    pop.style.top = `${(below ? r.bottom + 6 : Math.max(8, r.top - 6 - pop.offsetHeight)) + window.scrollY}px`;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
