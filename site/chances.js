(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { data: null, pos: '', sort: 'pScore', dir: -1, hideOut: true };
  // key, header, value at full colour, format ('pct', 'pct1' or number of decimals)
  const METRICS = [
    ['pApp1', 'Appearance 1+', 1, 'pct'], ['pApp60', 'Appearance 60+', 1, 'pct'],
    ['pScore', 'Score 1+', 0.6, 'pct'], ['xGoals', 'xGoals', 0.9, 2], ['pAssist', 'Assist 1+', 0.35, 'pct'], ['xAssists', 'xAssists', 0.45, 2],
    ['pCs', 'Clean sheet', 0.6, 'pct'], ['xConceded', 'Conceded', 2.4, 2], ['pDefcon', 'DefCon', 0.7, 'pct'], ['xDefcon', 'DefCon actions', 14, 1], ['xSaves', 'Saves', 4.5, 1],
    ['pPenSave', 'Pen save', 0.03, 'pct1'], ['pPenMiss', 'Pen miss', 0.03, 'pct1'], ['pOwnGoal', 'Own goal', 0.03, 'pct1'],
    ['pRed', 'Red card', 0.02, 'pct1'], ['pYellow', 'Yellow card', 0.4, 'pct'], ['xBps', 'BPS', 32, 0], ['bonus', 'Bonus', 1.5, 2],
  ];
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
    if (p.role && p.role !== p.position) name.querySelector('b').append(' ', el('span', { className: 'oop', textContent: `OOP ${p.role}`, title: `Listed as ${p.position} but plays as ${p.role}` }));
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
    const gw = $('gw').value, q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value);
    const value = (p, d) => (state.sort === 'name' ? p.name.toLowerCase() : state.sort === 'price' ? p.price : state.sort === 'opp' ? d.opp.join() : d[state.sort]);
    const list = state.data.players
      .filter((p) => p.byGw[gw] && !(state.hideOut && Math.round(p.byGw[gw].pApp1 * 100) === 0 && Math.round(p.byGw[gw].pApp60 * 100) === 0) && (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
      .sort((a, b) => { const x = value(a, a.byGw[gw]), y = value(b, b.byGw[gw]); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    $('table').tBodies[0].replaceChildren(...(list.length ? list.map((p) => row(p, p.byGw[gw]))
      : [el('tr', {}, el('td', { colSpan: METRICS.length + 3, className: 'none', textContent: 'No players match these filters. Widen the price, team or position.' }))]));
  }

  $('filters').addEventListener('input', render);
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
