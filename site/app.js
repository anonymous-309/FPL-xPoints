(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { data: null, pos: '', sort: 'total', dir: -1, overrides: XMin.load() };
  const PARTS = { app: 'Appearance', goal: 'Goals', assist: 'Assists', bonus: 'Bonus', cs: 'Clean sheet', conceded: 'Goals conceded', saves: 'Saves', pensave: 'Penalty saves', penmiss: 'Penalty misses', own: 'Own goals', defcon: 'DefCon', cards: 'Cards' };
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const f1 = (x) => x.toFixed(1);

  // Points for a gameweek, rescaled to the minutes set on the Minutes page.
  const view = (p, g) => XMin.view(state.overrides, p, g);
  const minutesText = (p, g) => XMin.join(XMin.minutes(state.overrides, p, g).mins);
  // Average minutes per match over the gameweeks shown, blanks left out (read-only here; edited on the Minutes page).
  function avgMins(p, gws) {
    const all = gws.map((g) => XMin.minutes(state.overrides, p, g)).filter(Boolean);
    const mins = all.flatMap((m) => m.mins);
    return { avg: mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null, edited: all.some((m) => m.source !== 'model') };
  }
  // Points per component, leaving out the ones that are zero for this player.
  const breakdownText = (d) => Object.entries(PARTS).filter(([k]) => Math.abs(d.parts[k]) >= 0.005).map(([k, label]) => `${label}: ${d.parts[k] >= 0 ? '+' : ''}${d.parts[k].toFixed(2)}`).join('\n');
  const pct = (v) => `${Math.round(v * 100)}%`;
  // The same figures as the Chance page: everything except appearances assumes a full 90 minutes.
  const CHANCES = [
    ['pApp1', 'Appearance 1+', 'pct'], ['pApp60', 'Appearance 60+', 'pct'], ['pScore', 'Score 1+', 'pct'], ['xGoals', 'xGoals', 2],
    ['pAssist', 'Assist 1+', 'pct'], ['xAssists', 'xAssists', 2], ['pCs', 'Clean sheet', 'pct'], ['xConceded', 'Conceded', 2],
    ['pDefcon', 'DefCon', 'pct'], ['xSaves', 'Saves', 1], ['pPenSave', 'Pen save', 'pct1'], ['pPenMiss', 'Pen miss', 'pct1'],
    ['pOwnGoal', 'Own goal', 'pct1'], ['pRed', 'Red card', 'pct1'], ['pYellow', 'Yellow card', 'pct'], ['bonus', 'Bonus', 2],
  ];
  function chanceText(p, g) {
    const d = p.byGw[g];
    return CHANCES.filter(([key]) => !(key === 'pDefcon' && p.position === 'GK') && !((key === 'xSaves' || key === 'pPenSave') && p.position !== 'GK'))
      .map(([key, label, fmt]) => `${label}: ${fmt === 'pct' ? `${Math.round(d[key] * 100)}%` : fmt === 'pct1' ? `${(d[key] * 100).toFixed(1)}%` : d[key].toFixed(fmt)}`)
      .join('\n');
  }
  const findPlayer = (id) => state.data.players.find((p) => p.id === id);
  function updateEdited() {
    const n = Object.keys(state.overrides).length;
    $('edited').hidden = n === 0;
    $('edited').textContent = `Your minutes for ${n} player${n === 1 ? '' : 's'}`;
  }
  function openText(text) {
    $('detail-text').textContent = text;
    $('detail').hidden = false;
  }
  function openGw(p, g) {
    const d = view(p, g);
    const mins = `${minutesText(p, g)} minutes${d.edited ? ' (yours)' : ''}`;
    openText(`${p.name}, GW${g} v ${d.opp.join(', ')}\nExpected ${f1(d.xpts)} points, ${mins}\n\nChance 90min\n${chanceText(p, g)}\n\nPoints\n${breakdownText(d)}`);
  }

  function heat(cell, x) {
    const t = Math.max(0, Math.min(1, (x - 1) / 6));
    cell.style.background = `color-mix(in srgb, #0e5a41 ${Math.round(t * 100)}%, #edf3ec)`;
    cell.style.color = t > 0.68 ? '#fff' : '#17261f';
  }

  function visibleGws() { return state.data.gws.slice(0, Number($('horizon').value)); }
  const total = (p, gws) => gws.reduce((s, g) => s + (p.byGw[g] ? view(p, g).xpts : 0), 0);

  function filtered(gws) {
    const q = $('search').value.trim().toLowerCase();
    const team = $('team').value;
    const max = parseFloat($('price').value);
    const value = {
      name: (p) => p.name.toLowerCase(), price: (p) => p.price, xmin: (p) => { const a = avgMins(p, gws).avg; return a === null ? -1 : a; }, total: (p) => total(p, gws),
    }[state.sort] || ((p) => (p.byGw[state.sort] ? view(p, state.sort).xpts : -99));
    const sorted = [...state.data.players].sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    // The Minutes page lists players in this same order.
    try { localStorage.setItem('xpoints-order', JSON.stringify(sorted.map((p) => p.id))); } catch (e) { /* the Minutes page falls back to total xPts */ }
    return sorted
      .filter((p) => (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)));
  }

  function header(gws) {
    const columns = [['name', 'Player'], ['price', 'Price'], ['xmin', 'Avg xMin'], ...gws.map((g) => [String(g), `GW${g}`]), ['total', 'Total']];
    $('table').tHead.replaceChildren(el('tr', {}, ...columns.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
        render();
      } }));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  function row(p, gws) {
    const meta = el('span', { textContent: `${p.team} ${p.position}` });
    const name = el('td', { className: 'player', title: p.news || p.fullName }, el('b', { textContent: p.name }), meta);
    if (p.role && p.role !== p.position) name.querySelector('b').append(' ', el('span', { className: 'oop', textContent: `OOP ${p.role}`, title: `Listed as ${p.position} but plays as ${p.role}` }));
    if (p.news) name.dataset.news = `${p.name}: ${p.news}`;
    if (p.status && p.status !== 'a') meta.append(' ', el('span', { className: 'flag', textContent: 'Flagged' }));
    const cells = gws.map((g) => {
      const d = view(p, g);
      if (!d) return el('td', { className: 'none', textContent: 'Blank' });
      const c = el('td', { className: d.edited ? 'gw edited' : 'gw', title: `${minutesText(p, g)} minutes${d.edited ? ' (yours)' : ''}\n\nChance 90min\n${chanceText(p, g)}\n\nPoints\n${breakdownText(d)}`, tabIndex: 0 }, el('strong', { textContent: f1(d.xpts) }), el('small', { textContent: d.opp.join(', ') }));
      c.dataset.gw = g;
      heat(c, d.xpts / Math.max(1, d.opp.length) * (d.opp.length > 1 ? 1.25 : 1));
      return c;
    });
    const a = avgMins(p, gws);
    const xmin = a.avg !== null ? el('td', { className: a.edited ? 'xmin-ro edited' : 'xmin-ro', textContent: Math.round(a.avg), title: `Average minutes per match, GW${gws[0]}-${gws[gws.length - 1]}${a.edited ? ', with your minutes' : ''}. Edit on the Minutes page.` })
      : el('td', { className: 'none', textContent: '–' });
    const tr = el('tr', {}, name, el('td', { textContent: `£${p.price.toFixed(1)}` }), xmin, ...cells, el('td', { className: 'total', textContent: f1(total(p, gws)) }));
    tr.dataset.pid = p.id;
    return tr;
  }

  function render() {
    if (!state.data) return;
    const gws = visibleGws();
    if (/^\d+$/.test(state.sort) && !gws.includes(Number(state.sort))) state.sort = 'total';
    header(gws);
    const list = filtered(gws);
    const body = list.length ? list.map((p) => row(p, gws))
      : [el('tr', {}, el('td', { colSpan: gws.length + 4, className: 'none', textContent: 'No players match these filters. Widen the price, team or position.' }))];
    $('table').tBodies[0].replaceChildren(...body);
  }

  function show(data) {
    state.data = data;
    XMin.setPlayers(data.players);
    $('empty').hidden = true;
    $('wrap').hidden = false;
    const when = new Date(data.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
    $('status').textContent = `From GW${data.gws[0]}, updated ${when}`;
    $('warnings').textContent = data.warnings.join(' ');
    const current = $('team').value;
    $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(data.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
    $('team').value = current;
    updateEdited();
    render();
  }

  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  const tbody = $('table').tBodies[0];
  tbody.addEventListener('click', (e) => {
    const gwCell = e.target.closest('td.gw');
    if (gwCell) { openGw(findPlayer(gwCell.closest('tr').dataset.pid), Number(gwCell.dataset.gw)); return; }
    const nameCell = e.target.closest('td.player');
    if (nameCell && nameCell.dataset.news) openText(nameCell.dataset.news);
  });
  tbody.addEventListener('keydown', (e) => {
    const td = e.target.closest('td.gw');
    if (td && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openGw(findPlayer(td.closest('tr').dataset.pid), Number(td.dataset.gw)); }
  });
  $('close').addEventListener('click', () => { $('detail').hidden = true; });
  // Minutes edited on the Minutes page in another tab.
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') { state.overrides = XMin.load(); updateEdited(); render(); } });

  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(show)
    .catch(() => {
      $('error').textContent = 'Could not load the points. Check the latest run in the GitHub Actions tab, then reload this page.';
      $('error').hidden = false;
      $('status').textContent = 'No data yet';
    });
})();
