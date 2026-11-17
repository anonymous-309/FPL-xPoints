(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { rows: [], sort: 'xgi90', dir: -1 };
  const COLS = [['name', 'Player'], ['position', 'FPL position'], ['role', 'Plays as'], ['price', 'Price'], ['box90', 'Box touches /90'], ['xgi90', 'npxGI /90'],
    ['score', 'Score 1+'], ['assist', 'Assist 1+'], ['xpts', 'xPoints next 5']];

  function render() {
    $('table').tHead.replaceChildren(el('tr', {}, ...COLS.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = ['name', 'position', 'role'].includes(key) ? 1 : -1; }
        render();
      } }));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
    const rows = [...state.rows].sort((a, b) => { const x = a[state.sort], y = b[state.sort]; return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    $('table').tBodies[0].replaceChildren(...(rows.length ? rows.map((r) => el('tr', {},
      el('td', { className: 'player' }, el('b', { textContent: r.name }), el('span', { textContent: r.team })),
      el('td', { textContent: r.position }), el('td', { textContent: r.role }), el('td', { textContent: `£${r.price.toFixed(1)}` }),
      el('td', { textContent: r.box90 === null ? '–' : r.box90.toFixed(1) }), el('td', { textContent: r.xgi90 === null ? '–' : r.xgi90.toFixed(2) }),
      el('td', { textContent: `${Math.round(r.score * 100)}%` }), el('td', { textContent: `${Math.round(r.assist * 100)}%` }),
      el('td', { className: 'total', textContent: r.xpts.toFixed(1) }))) : [el('tr', {}, el('td', { colSpan: COLS.length, className: 'none', textContent: 'No players are out of position right now.' }))]));
  }

  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      const gws = d.gws.slice(0, 5), first = d.gws[0];
      state.rows = d.players.filter((p) => p.role && p.role !== p.position).map((p) => ({
        name: p.name, team: p.team, position: p.position, role: p.role, price: p.price, box90: p.box90, xgi90: p.xgi90,
        score: p.byGw[first] ? p.byGw[first].pScore : 0, assist: p.byGw[first] ? p.byGw[first].pAssist : 0,
        xpts: gws.reduce((s, g) => s + (p.byGw[g] ? p.byGw[g].xpts : 0), 0),
      }));
      const m = d.roleMedians || {};
      $('medians').textContent = Object.entries(m).map(([pos, v]) => `Median ${pos}: ${v.box90.toFixed(1)} box touches and ${v.xgi90.toFixed(2)} npxGI per 90.`).join(' ');
      const when = new Date(d.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
      $('status').textContent = `${state.rows.length} players, Score 1+ and Assist 1+ for GW${first} at 90 minutes, updated ${when}`;
      $('wrap').hidden = false;
      render();
    })
    .catch(() => {
      $('error').textContent = 'Could not load the data. Check the latest run in the GitHub Actions tab, then reload this page.';
      $('error').hidden = false;
      $('status').textContent = 'No data yet';
    });
})();
