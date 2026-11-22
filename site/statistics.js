(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { data: null, pos: '', sort: 'xgi', dir: -1 };
  // [key, label, digits]: digits null = whole number
  const COLS = [['name', 'Player'], ['price', 'Price', 1], ['starts', 'Starts', null], ['mins', 'Min', null], ['goals', 'G', null], ['assists', 'A', null],
    ['xg', 'xG', 2], ['xa', 'xA', 2], ['xgi', 'xGI', 2], ['xg90', 'xG/90', 2], ['xa90', 'xA/90', 2], ['xgi90', 'xGI/90', 2], ['dc', 'DefCon', null], ['dc90', 'DefCon/90', 1], ['pts', 'Pts', null]];
  const val = (p, k) => (k === 'name' ? p.name.toLowerCase() : k === 'price' ? p.price : (p.season ? p.season[k] : null));

  function header() {
    $('table').tHead.replaceChildren(el('tr', {}, ...COLS.map(([k, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
        render();
      } }));
      if (state.sort === k) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  function render() {
    if (!state.data) return;
    header();
    const q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value), mm = parseFloat($('minmins').value) || 0;
    const list = state.data.players.filter((p) => p.season && p.season.mins >= mm && (!state.pos || p.position === state.pos) && (!team || p.team === team)
      && (!(max > 0) || p.price <= max) && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
      .sort((a, b) => { const x = val(a, state.sort) ?? -1, y = val(b, state.sort) ?? -1; return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    const rows = list.map((p) => el('tr', {}, ...COLS.map(([k, , d]) => {
      if (k === 'name') return el('td', { className: 'player', title: p.fullName }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position}` }));
      if (k === 'price') return el('td', { textContent: `£${p.price.toFixed(1)}` });
      const v = p.season[k];
      const td = el('td', { textContent: v === null || v === undefined ? '–' : d === null ? String(v) : v.toFixed(d) });
      if (k === 'starts') td.title = `${p.season.starts} starts in ${p.season.matches} league matches, played in ${p.season.apps}`;
      if (k === state.sort) td.className = 'sorted';
      return td;
    })));
    $('table').tBodies[0].replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colSpan: COLS.length, className: 'none', textContent: 'No players match these filters.' }))]));
  }

  $('filters').addEventListener('input', render);
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
      const last = d.pastGws && d.pastGws.length ? Math.max(...d.pastGws) : d.gws[0] - 1;
      $('status').textContent = `This season to GW${last}, updated ${new Date(d.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`;
      $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(d.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      render();
    })
    .catch(() => { $('error').textContent = 'Could not load the statistics. Reload the page to try again.'; $('error').hidden = false; $('status').textContent = 'No data yet'; });
})();
