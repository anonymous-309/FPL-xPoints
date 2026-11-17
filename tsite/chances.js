(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { data: null, pos: '', sort: 'order', dir: 1, hideOut: true, overrides: XMin.load() };
  // key, header, value at full colour, format ('pct', 'pct1' or number of decimals)
  const METRICS = [
    ['pApp1', 'Appearance 1+', 1, 'pct'], ['pApp60', 'Appearance 60+', 1, 'pct'],
    ['pScore', 'Score 1+', 0.6, 'pct'], ['npxGoals', 'NPxGoals', 0.8, 2], ['xPenGoals', 'Pen goals', 0.15, 2], ['pAssist', 'Assist 1+', 0.35, 'pct'], ['xAssists', 'xAssists', 0.45, 2],
    ['pCs', 'Clean sheet', 0.6, 'pct'], ['xConceded', 'Conceded', 2.4, 2], ['pDefcon', 'DefCon', 0.7, 'pct'], ['xDefcon', 'DefCon actions', 14, 1], ['xSaves', 'Saves', 4.5, 1],
    ['pPenSave', 'Pen save', 0.03, 'pct1'], ['pPenMiss', 'Pen miss', 0.03, 'pct1'], ['pOwnGoal', 'Own goal', 0.03, 'pct1'],
    ['pRed', 'Red card', 0.02, 'pct1'], ['pYellow', 'Yellow card', 0.4, 'pct'], ['xBps', 'BPS', 32, 0], ['bonus', 'Bonus', 1.5, 2],
  ];
  const LEAGUE_MISS = 0.22;
  const cache = new Map();
  // Goals split into open play (NPxGoals) and penalties. The penalty share follows the minutes set on the Minutes
  // page for the takers above him, so Score 1+, Pen goals and Pen miss move with them.
  function figures(p, g) {
    const d = p.byGw[g];
    if (!d) return null;
    const key = `${p.id}|${g}`;
    if (cache.has(key)) return cache.get(key);
    const miss = p.penMiss == null ? LEAGUE_MISS : p.penMiss;
    let penModel = 0, pen = 0, missed = 0;
    (d.fx || []).forEach((_, j) => {
      const tp = d.tp ? d.tp[j] : 0;
      penModel += (d.pc ? d.pc[j] : 0) * tp * (1 - miss);
      const pens = XMin.penCond(state.overrides, p, g, j) * tp;
      pen += pens * (1 - miss);
      missed += pens * miss;
    });
    const np = Math.max(0, d.xGoals - penModel);
    const out = { ...d, npxGoals: np, xPenGoals: pen, pScore: 1 - Math.exp(-(np + pen)), pPenMiss: d.fx ? 1 - Math.exp(-missed) : d.pPenMiss };
    cache.set(key, out);
    return out;
  }
  const isChance = (fmt) => fmt === 'pct' || fmt === 'pct1';
  const notApplicable = (p, key) => ((key === 'pDefcon' || key === 'xDefcon') && p.position === 'GK') || ((key === 'xSaves' || key === 'pPenSave') && p.position !== 'GK');

  function heat(cell, t) {
    const v = Math.max(0, Math.min(1, t));
    cell.style.background = `color-mix(in srgb, #0e5a41 ${Math.round(v * 100)}%, #edf3ec)`;
    cell.style.color = v > 0.68 ? '#fff' : '#17261f';
  }

  function header() {
    const cols = [['name', 'Player'], ['price', 'Price'], ['opp', 'Opponent'], ...METRICS.map(([k, l]) => [k, l])];
    $('table').tHead.replaceChildren(el('tr', {}, ...cols.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' || key === 'opp' ? 1 : -1; }
        render();
      } }));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  function row(p, d) {
    const name = el('td', { className: 'player', title: p.news || p.fullName }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position}` }));
    if (p.role && p.role !== p.position) name.querySelector('b').append(' ', el('span', { className: 'oop', textContent: 'OOP', title: `Listed as ${p.position} but plays as ${p.role}` }));
    const cells = METRICS.map(([key, , full, fmt]) => {
      if (notApplicable(p, key)) return el('td', { className: 'none', textContent: '–' });
      const v = d[key];
      const text = fmt === 'pct' ? `${Math.round(v * 100)}%` : fmt === 'pct1' ? `${(v * 100).toFixed(1)}%` : v.toFixed(fmt);
      const c = el('td', { className: 'gw prob' }, el('strong', { textContent: text }));
      heat(c, v / full);
      return c;
    });
    return el('tr', {}, name, el('td', { textContent: `£${p.price.toFixed(1)}` }), el('td', { className: 'opp', textContent: d.opp.join(', ') }), ...cells);
  }

  function render() {
    if (!state.data) return;
    header();
    $('order').setAttribute('aria-pressed', String(state.sort === 'order'));
    const gw = $('gw').value, q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value);
    const rank = state.sort === 'order' ? XMin.order(state.data, state.overrides) : null;
    const value = (p, d) => (rank ? rank(p) : state.sort === 'name' ? p.name.toLowerCase() : state.sort === 'price' ? p.price : state.sort === 'opp' ? d.opp.join() : figures(p, gw)[state.sort]);
    const list = state.data.players
      .filter((p) => p.byGw[gw] && !(state.hideOut && Math.round(p.byGw[gw].pApp1 * 100) === 0 && Math.round(p.byGw[gw].pApp60 * 100) === 0) && (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
      .sort((a, b) => { const x = value(a, a.byGw[gw]), y = value(b, b.byGw[gw]); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    $('table').tBodies[0].replaceChildren(...(list.length ? list.map((p) => row(p, figures(p, gw)))
      : [el('tr', {}, el('td', { colSpan: METRICS.length + 3, className: 'none', textContent: 'No players match these filters. Widen the price, team or position.' }))]));
  }

  $('filters').addEventListener('input', render);
  $('order').addEventListener('click', () => { state.sort = 'order'; state.dir = 1; render(); });
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') { state.overrides = XMin.load(); cache.clear(); render(); } });
  $('hide-out').addEventListener('click', () => {
    state.hideOut = !state.hideOut;
    $('hide-out').setAttribute('aria-pressed', String(state.hideOut));
    render();
  });
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));

  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      state.data = data;
      XMin.setPlayers(data.players);
      $('gw').replaceChildren(...data.gws.map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
      $('team').append(...[...new Set(data.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      const when = new Date(data.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
      $('status').textContent = `Updated ${when}`;
      $('wrap').hidden = false;
      render();
    })
    .catch(() => {
      $('error').textContent = 'Could not load the data. Check the latest run in the GitHub Actions tab, then reload this page.';
      $('error').hidden = false;
      $('status').textContent = 'No data yet';
    });
})();
