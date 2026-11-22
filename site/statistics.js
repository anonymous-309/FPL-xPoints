(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  // one row per league match this season, in this order (fpl_xpoints.py export_site)
  const K = ['gw', 'opp', 'mins', 'starts', 'pts', 'g', 'a', 'xg', 'xa', 'xgot', 'pens', 'dc', 'bonus', 'bps', 'cs', 'saves', 'pensave', 'yc', 'rc'];
  const I = Object.fromEntries(K.map((k, i) => [k, i]));
  const NPXG_PEN = 0.76;
  const state = { data: null, pos: '', sort: 'pts', dir: -1, from: 1, to: 1, open: null };
  // [key, label, digits, tooltip]: digits null = whole number
  const COLS = [['name', 'Player'], ['apps', 'Matches', null, 'League matches he played in (1+ minutes)'], ['pts', 'Total pts', null, 'FPL points'],
    ['ppm', 'Pts/match', 2, 'Points per match played'], ['gwPts', 'GW pts', null, 'Points in the last gameweek of the range'], ['price', 'Price', 1],
    ['mins', 'Minutes', null], ['starts', 'Starts', null], ['g', 'G', null, 'Goals'], ['a', 'A', null, 'Assists as FPL counts them'],
    ['gi', 'GI', null, 'Goal involvements: goals + FPL assists'], ['cs', 'CS', null, 'Clean sheets'],
    ['xg', 'xG', 2], ['xa', 'xA', 2], ['xgi', 'xGI', 2, 'xG + xA'], ['npxg', 'npxG', 2, 'Non-penalty xG: xG less 0.76 for each penalty taken'],
    ['npxgxa', 'npxG+xA', 2], ['xgot', 'xGoT', 2, 'Expected goals on target: the shot\'s placement counted too'],
    ['xgi90', 'xGI/90', 2], ['npxgxa90', 'npxG+xA/90', 2], ['dc', 'DefCon', null, 'Defensive contributions (FPL)'], ['dc90', 'DefCon/90', 1],
    ['saves', 'Saves', null], ['pensave', 'Pen saves', null], ['bonus', 'Bonus', null], ['bps', 'BPS', null, 'Bonus Points System score'],
    ['yc', 'YC', null, 'Yellow cards'], ['rc', 'RC', null, 'Red cards']];
  const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '–' : d === null || d === undefined ? String(Math.round(v)) : v.toFixed(d));

  // totals over the chosen gameweeks
  function stats(p) {
    const rows = (p.seasonGw || []).filter((r) => r[I.gw] >= state.from && r[I.gw] <= state.to);
    const s = Object.fromEntries(['mins', 'starts', 'pts', 'g', 'a', 'xg', 'xa', 'dc', 'bonus', 'bps', 'cs', 'saves', 'pensave', 'yc', 'rc'].map((k) => [k, rows.reduce((t, r) => t + (r[I[k]] || 0), 0)]));
    s.apps = rows.filter((r) => r[I.mins] > 0).length;
    s.ppm = s.apps ? s.pts / s.apps : null;
    s.gwPts = rows.filter((r) => r[I.gw] === state.to).reduce((t, r) => t + r[I.pts], 0);
    s.gi = s.g + s.a;
    s.xgi = s.xg + s.xa;
    const core = rows.some((r) => r[I.xgot] !== null);
    s.xgot = core ? rows.reduce((t, r) => t + (r[I.xgot] || 0), 0) : null;
    const pens = rows.reduce((t, r) => t + (r[I.pens] || 0), 0);
    s.npxg = core ? Math.max(0, s.xg - NPXG_PEN * pens) : null;
    s.npxgxa = core ? s.npxg + s.xa : null;
    const n90 = s.mins / 90;
    s.xgi90 = n90 ? s.xgi / n90 : null;
    s.npxgxa90 = n90 && core ? s.npxgxa / n90 : null;
    s.dc90 = n90 ? s.dc / n90 : null;
    s.rows = rows;
    return s;
  }
  const val = (p, k) => (k === 'name' ? p.name.toLowerCase() : k === 'price' ? p.price : p.st[k]);

  function header() {
    $('table').tHead.replaceChildren(el('tr', {}, ...COLS.map(([k, label, , tip]) => {
      const th = el('th', { scope: 'col', title: tip || '' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
        render();
      } }));
      if (state.sort === k) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  // the player's matches, one row per gameweek
  function detail(p) {
    const H = [['gw', 'GW'], ['opp', 'Opp'], ['mins', 'Min'], ['starts', 'Start'], ['pts', 'Pts'], ['g', 'G'], ['a', 'A'], ['xg', 'xG', 2], ['xa', 'xA', 2], ['xgot', 'xGoT', 2],
      ['dc', 'DefCon'], ['cs', 'CS'], ['saves', 'Saves'], ['bonus', 'Bonus'], ['bps', 'BPS'], ['yc', 'YC'], ['rc', 'RC']];
    const rows = p.st.rows.map((r) => el('tr', {}, ...H.map(([k, , d]) => el('td', { textContent: k === 'opp' ? r[I.opp] : k === 'gw' ? `GW${r[I.gw]}` : k === 'starts' ? (r[I.starts] ? '✓' : '') : fmt(r[I[k]], d) }))));
    return el('tr', { className: 'stat-detail' }, el('td', { colSpan: COLS.length },
      el('div', { className: 'wrap' }, el('table', { className: 'stats inner' }, el('thead', {}, el('tr', {}, ...H.map(([, l]) => el('th', { textContent: l })))), el('tbody', {}, ...rows)))));
  }

  function render() {
    if (!state.data) return;
    header();
    const q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value), mm = parseFloat($('minmins').value) || 0;
    const list = state.data.players.filter((p) => (!state.pos || p.position === state.pos) && (!team || p.team === team)
      && (!(max > 0) || p.price <= max) && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)));
    list.forEach((p) => { p.st = stats(p); });
    const shown = list.filter((p) => p.st.mins >= mm)
      .sort((a, b) => { const x = val(a, state.sort) ?? -1, y = val(b, state.sort) ?? -1; return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    const body = [];
    shown.forEach((p) => {
      const tr = el('tr', { className: 'stat-row' }, ...COLS.map(([k, , d]) => {
        if (k === 'name') return el('td', { className: 'player', title: 'Tap for each gameweek' }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position}` }));
        if (k === 'price') return el('td', { textContent: `£${p.price.toFixed(1)}` });
        const td = el('td', { textContent: fmt(p.st[k], d) });
        if (k === state.sort) td.className = 'sorted';
        return td;
      }));
      tr.addEventListener('click', () => { state.open = state.open === p.id ? null : p.id; render(); });
      body.push(tr);
      if (state.open === p.id) body.push(detail(p));
    });
    $('table').tBodies[0].replaceChildren(...(body.length ? body : [el('tr', {}, el('td', { colSpan: COLS.length, className: 'none', textContent: 'No players match these filters.' }))]));
  }

  function fillRange(gws) {
    const opts = (sel) => gws.map((g) => el('option', { value: g, textContent: `GW${g}`, selected: g === sel }));
    $('from').replaceChildren(...opts(state.from));
    $('to').replaceChildren(...opts(state.to));
  }
  $('filters').addEventListener('input', (e) => {
    if (e.target.id === 'from' || e.target.id === 'to') {
      state.from = Number($('from').value); state.to = Number($('to').value);
      if (state.from > state.to) { [state.from, state.to] = [state.to, state.from]; fillRange([...$('from').options].map((o) => Number(o.value))); }
    }
    render();
  });
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  fetch('data.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      state.data = d;
      const gws = [...new Set(d.players.flatMap((p) => (p.seasonGw || []).map((r) => r[I.gw])))].sort((a, b) => a - b);
      if (!gws.length) throw new Error('no season data');
      state.from = gws[0]; state.to = gws[gws.length - 1];
      fillRange(gws);
      $('status').textContent = `This season to GW${state.to}, updated ${new Date(d.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`;
      $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(d.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      render();
    })
    .catch(() => { $('error').textContent = 'Could not load the statistics. Reload the page to try again.'; $('error').hidden = false; $('status').textContent = 'No data yet'; });
})();
