(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { data: null, pos: '', sort: null, dir: -1, flagged: false, overrides: XMin.load() };

  const futureGws = () => state.data.gws.slice(0, Number($('horizon').value));
  const pastGws = () => state.data.pastGws || [];
  const flaggedPlayer = (p) => Boolean(p.minNote) || (p.status && p.status !== 'a');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const pastMins = (p, g) => (p.pastMin && p.pastMin[g]) || null;
  const nextMins = (p, g) => { const m = XMin.minutes(state.overrides, p, g); return m ? sum(m.mins) : -1; };

  function save(p) {
    XMin.tidy(state.overrides, p.id);
    XMin.save(state.overrides);
    updateReset();
    const tr = $('table').tBodies[0].querySelector(`tr[data-pid="${CSS.escape(p.id)}"]`);
    if (tr) tr.replaceWith(row(p));
  }
  function updateReset() {
    const n = Object.keys(state.overrides).length;
    $('reset').hidden = n === 0;
    $('reset').textContent = `Reset your minutes (${n})`;
  }

  function columns() {
    return [
      ['name', 'Player'],
      ...pastGws().map((g) => [`p${g}`, `GW${g}`, 'played']),
      ['usual', 'Usual', 'last 5'], ['adjust', 'Adjust min', 'all GWs'],
      ...futureGws().map((g) => [`f${g}`, `GW${g}`, 'xMin']),
      ['note', 'Injury / ban'],
    ];
  }
  // Same order as the xPoints page (saved there each time it sorts), else total xPts over these gameweeks.
  function xpointsOrder() {
    let ids = null;
    try { ids = JSON.parse(localStorage.getItem('xpoints-order')); } catch (e) { ids = null; }
    if (Array.isArray(ids) && ids.length) {
      const rank = new Map(ids.map((id, i) => [id, i]));
      return (p) => (rank.has(p.id) ? rank.get(p.id) : ids.length);
    }
    const gws = futureGws();
    return (p) => -gws.reduce((a, g) => { const d = XMin.view(state.overrides, p, g); return a + (d ? d.xpts : 0); }, 0);
  }
  function sortValue(key) {
    if (key === 'order') return xpointsOrder();
    if (key === 'name') return (p) => p.name.toLowerCase();
    if (key === 'usual') return (p) => p.minUsual;
    if (key === 'adjust') return (p) => { const o = state.overrides[p.id]; return o && o.all !== undefined ? o.all : -1; };
    if (key === 'note') return (p) => p.minNote || '';
    if (key[0] === 'p') { const g = key.slice(1); return (p) => { const m = pastMins(p, g); return m ? sum(m) : -1; }; }
    const g = key.slice(1);
    return (p) => nextMins(p, g);
  }

  function header() {
    const head = el('tr', {}, ...columns().map(([key, label, sub]) => {
      const th = el('th', { scope: 'col', className: /^p\d/.test(key) ? 'past' : '' },
        el('button', { type: 'button', onclick: () => {
          if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' || key === 'note' ? 1 : -1; }
          render();
        } }, label, ...(sub ? [el('small', { textContent: sub })] : [])));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    }));
    $('table').tHead.replaceChildren(head);
  }

  function input(value, placeholder, label, data) {
    const i = el('input', { className: 'xmin-input', type: 'text', inputMode: 'numeric', value: value === undefined ? '' : value, placeholder });
    i.setAttribute('aria-label', label);
    Object.assign(i.dataset, data);
    return i;
  }

  function row(p) {
    const meta = el('span', { textContent: `${p.team} ${p.position} £${p.price.toFixed(1)}` });
    const name = el('td', { className: 'player', title: p.news || p.fullName }, el('b', { textContent: p.name }), meta);
    if (p.status && p.status !== 'a') meta.append(' ', el('span', { className: 'flag', textContent: 'Flagged' }));
    const o = state.overrides[p.id] || {};
    const adjust = el('td', { className: 'xmin' }, input(o.all, String(Math.round(p.minUsual)), `Minutes per match for ${p.name} in every gameweek`, { all: '1' }));
    const usual = p.adminMin !== null && p.adminMin !== undefined
      ? el('td', { className: 'usual admin-set', textContent: Math.round(p.minUsual), title: `Set by admin (formula ${Math.round(p.minModel ?? p.minUsual)})` })
      : el('td', { className: 'usual', textContent: Math.round(p.minUsual), title: p.w5Min !== null && Math.round(p.w5Min) !== Math.round(p.minUsual) ? `${Math.round(p.w5Min)} counting his current absence` : '' });
    const past = pastGws().map((g) => {
      const m = pastMins(p, g);
      return m ? el('td', { className: 'past', textContent: XMin.join(m) }) : el('td', { className: 'past none', textContent: '–' });
    });
    const future = futureGws().map((g) => {
      const m = XMin.minutes(state.overrides, p, g);
      if (!m) return el('td', { className: 'none', textContent: 'Blank' });
      const model = XMin.model(p, g);
      const own = o.gw && o.gw[g] !== undefined;
      const td = el('td', { className: `fut ${m.source !== 'model' ? 'edited' : ''} ${sum(m.mins) === 0 ? 'zero' : ''}` },
        input(own ? o.gw[g] : undefined, XMin.join(m.source === 'all' ? m.mins : model.mins), `Minutes per match for ${p.name} in gameweek ${g}`, { gw: String(g) }),
        el('small', { textContent: p.byGw[g].opp.join(', ') }));
      return td;
    });
    const note = el('td', { className: 'note', textContent: p.minNote || '', title: p.news || '' });
    const tr = el('tr', {}, name, ...past, usual, adjust, ...future, note);
    tr.dataset.pid = p.id;
    return tr;
  }

  function render() {
    if (!state.data) return;
    if (!state.sort || (state.sort !== 'order' && !columns().some(([k]) => k === state.sort))) { state.sort = 'order'; state.dir = 1; }
    header();
    $('order').setAttribute('aria-pressed', String(state.sort === 'order'));
    const q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value);
    const value = sortValue(state.sort);
    const list = state.data.players
      .filter((p) => (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!state.flagged || flaggedPlayer(p)) && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
      .sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    const body = list.length ? list.map(row)
      : [el('tr', {}, el('td', { colSpan: columns().length, className: 'none', textContent: 'No players match these filters.' }))];
    $('table').tBodies[0].replaceChildren(...body);
  }

  function show(data) {
    state.data = data;
    XMin.setPlayers(data.players);
    $('empty').hidden = true;
    $('wrap').hidden = false;
    const when = new Date(data.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
    $('status').textContent = `From GW${data.gws[0]}, updated ${when}`;
    $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(data.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
    updateReset();
    render();
  }

  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('order').addEventListener('click', () => { state.sort = 'order'; state.dir = 1; render(); });
  $('flagged').addEventListener('click', () => {
    state.flagged = !state.flagged;
    $('flagged').setAttribute('aria-pressed', String(state.flagged));
    render();
  });
  $('table').tBodies[0].addEventListener('change', (e) => {
    if (!e.target.matches('.xmin-input')) return;
    const p = state.data.players.find((x) => x.id === e.target.closest('tr').dataset.pid);
    const v = XMin.parse(e.target.value);
    if (v === undefined) { e.target.value = ''; return; }
    const o = state.overrides[p.id] || (state.overrides[p.id] = {});
    if (e.target.dataset.all) {
      // Adjust min applies to every gameweek, so it replaces single-gameweek edits.
      delete o.gw;
      if (v === null) delete o.all; else o.all = v;
    } else {
      const g = e.target.dataset.gw;
      o.gw = o.gw || {};
      if (v === null) delete o.gw[g]; else o.gw[g] = v;
    }
    save(p);
  });
  $('table').tBodies[0].addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.xmin-input')) { e.preventDefault(); e.target.blur(); }
  });
  $('reset').addEventListener('click', () => { state.overrides = {}; XMin.save(state.overrides); updateReset(); render(); });
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') { state.overrides = XMin.load(); updateReset(); render(); } });

  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(show)
    .catch(() => {
      $('error').textContent = 'Could not load the minutes. Check the latest run in the GitHub Actions tab, then reload this page.';
      $('error').hidden = false;
      $('status').textContent = 'No data yet';
    });
})();
