(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  let data = null, byId = {}, overrides = XMin.load();

  // Minutes and penalty share with the viewer's own xMin edits (Minutes page) applied: when a taker above him
  // plays less, the next taker on the list gets more of the penalties.
  function live(t) {
    const p = byId[t.id], g = String(data.gw);
    if (!p || !p.byGw[g]) return t;
    const d = p.byGw[g], j = 0;  // the table covers his first match of the gameweek
    const mins = XMin.minutes(overrides, p, g).mins[j];
    const share = XMin.penCond(overrides, p, g, j) * mins / 90;
    const tp = d.tp ? d.tp[j] : data.teams.find((x) => x.team === p.team).penRate;
    const miss = p.penMiss == null ? 0.22 : p.penMiss;
    return { ...t, adjMin: mins, share, xPenGoals: share * tp * (1 - miss), edited: XMin.minutes(overrides, p, g).source !== 'model' };
  }

  function takerList(title, list) {
    const box = el('div', { className: 'sp-block' }, el('h3', { textContent: title }));
    if (!list.length) { box.append(el('p', { className: 'sp-none', textContent: 'No taker listed' })); return box; }
    box.append(el('ol', {}, ...list.map((t) => el('li', { textContent: t.name }))));
    return box;
  }

  function penTable(team) {
    const box = el('div', { className: 'sp-block sp-pens' }, el('h3', { textContent: 'Penalties' }));
    if (!team.pens.length) { box.append(el('p', { className: 'sp-none', textContent: 'No taker listed' })); return box; }
    const head = el('tr', {}, ...['#', 'Player', 'Adj. Min', 'Pen share', 'xPen goals'].map((h) => el('th', { scope: 'col', textContent: h })));
    const rows = team.pens.map(live).map((p) => {
      const bar = el('span', { className: 'sp-bar' });
      bar.style.width = `${Math.round(p.share * 100)}%`;
      return el('tr', {},
        el('td', { textContent: p.order }), el('td', { className: 'sp-name', textContent: p.name }), el('td', { textContent: Math.round(p.adjMin) + (p.edited ? '*' : ''), title: p.edited ? 'Your own minutes from the Minutes page' : '' }),
        el('td', { className: 'sp-share' }, el('span', { className: 'sp-track' }, bar), el('strong', { textContent: `${Math.round(p.share * 100)}%` })),
        el('td', { textContent: p.xPenGoals.toFixed(3) }));
    });
    box.append(el('table', {}, el('thead', {}, head), el('tbody', {}, ...rows)));
    return box;
  }

  function card(team) {
    const head = el('header', { className: 'sp-head' },
      el('h2', { textContent: team.name }),
      el('p', { textContent: `GW${data.gw} v ${team.opp.join(', ')} · ${team.penRate.toFixed(2)} penalties per match` }));
    const body = el('div', { className: 'sp-body' }, penTable(team), takerList('Direct free kicks', team.fk), takerList('Corners and indirect free kicks', team.corners));
    const c = el('section', { className: 'sp-card' }, head, body);
    if (team.notes.length) c.append(el('p', { className: 'sp-notes', textContent: team.notes.join(' ') }));
    return c;
  }

  function render() {
    const q = $('search').value.trim().toLowerCase();
    const match = (t) => !q || t.name.toLowerCase().includes(q) || t.team.toLowerCase().includes(q)
      || [...t.pens, ...t.fk, ...t.corners].some((p) => p.name.toLowerCase().includes(q));
    const teams = data.teams.filter(match).sort((a, b) => ($('sort').value === 'pens' ? b.penRate - a.penRate : a.name.localeCompare(b.name)));
    $('grid').replaceChildren(...(teams.length ? teams.map(card) : [el('p', { className: 'sp-none', textContent: 'No team or player matches this search.' })]));
  }

  $('filters').addEventListener('input', render);
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') { overrides = XMin.load(); if (data) render(); } });
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      if (!d.setPieces) throw new Error('missing');
      data = d.setPieces;
      byId = Object.fromEntries(d.players.map((p) => [p.id, p]));
      XMin.setPlayers(d.players);
      const when = new Date(d.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
      $('status').textContent = `GW${data.gw}, updated ${when}`;
      render();
    })
    .catch(() => {
      $('error').textContent = 'Could not load the set piece data. Check the latest run in the GitHub Actions tab, then reload this page.';
      $('error').hidden = false;
      $('status').textContent = 'No data yet';
    });
})();
