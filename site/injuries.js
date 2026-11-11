(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { log: [], show: 'out' };
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '');

  function rows(r) {
    const expected = r.expectedReturnGw ? `GW${r.expectedReturnGw}${r.expectedReturnDate ? ` (${day(r.expectedReturnDate)})` : ''}` : (r.status === 'out' ? 'Unknown' : '–');
    const main = el('tr', { className: `inj ${r.status}`, tabIndex: 0 },
      el('td', { className: 'player' }, el('b', { textContent: r.name }), el('span', { textContent: `${r.team} ${r.position}` })),
      el('td', { textContent: r.type + (r.type === 'Doubtful' && r.chance !== null ? ` ${r.chance}%` : '') + (r.manual ? ' (admin)' : '') }),
      el('td', { textContent: `GW${r.startGw}`, title: r.startFrom === 'matches' ? 'First of his zero-minute matches in a row' : 'Gameweek of the news' }),
      el('td', { textContent: expected }),
      el('td', { textContent: r.status === 'out' ? 'Out' : r.returnedGw ? `GW${r.returnedGw}` : 'Left' }),
      el('td', { className: 'note', textContent: r.news || '' }));
    const detail = el('tr', { className: 'inj-detail', hidden: true },
      el('td', { colSpan: 6 }, el('ul', {}, ...(r.updates || []).map((u) => el('li', {},
        el('b', { textContent: `GW${u.gw} · ${day(u.at)}: ` }),
        `${u.type}${u.chance !== null && u.chance !== undefined ? ` ${u.chance}%` : ''}, expected back ${u.expectedReturnGw ? 'GW' + u.expectedReturnGw : 'unknown'}. ${u.news}`)))));
    const toggle = () => { detail.hidden = !detail.hidden; };
    main.addEventListener('click', toggle);
    main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    return [main, detail];
  }

  function render() {
    const q = $('search').value.trim().toLowerCase(), team = $('team').value, type = $('type').value;
    const list = state.log.filter((r) => (!state.show || (state.show === 'out' ? r.status === 'out' : r.status !== 'out'))
      && (!team || r.team === team) && (!type || (type === 'Added by admin' ? r.manual : r.type === type)) && (!q || r.name.toLowerCase().includes(q)));
    $('table').tBodies[0].replaceChildren(...(list.length ? list.flatMap(rows)
      : [el('tr', {}, el('td', { colSpan: 6, className: 'none', textContent: 'No absences match these filters.' }))]));
    const out = state.log.filter((r) => r.status === 'out').length;
    $('status').textContent = `${out} out now, ${state.log.length} in the log`;
  }

  $('filters').addEventListener('input', render);
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.show = b.dataset.show;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  fetch('injury_log.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((log) => {
      state.log = log;
      $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(log.map((r) => r.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      render();
    })
    .catch(() => { $('error').textContent = 'The injury log appears here once the GitHub update has run.'; $('error').hidden = false; $('status').textContent = 'No log yet'; });
})();
