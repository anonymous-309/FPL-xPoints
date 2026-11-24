// Team odds: every league match of a gameweek with each side's expected goals and clean sheet chance (fdr.json),
// and the kick-off time (fixtures.json).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== '')); return n; };
  const state = { matches: {}, gws: [], sort: 'time', names: {}, view: 'table', tsort: 'goals', tdir: -1 };

  function build(fdr, fx) {
    const kick = new Map(); // "HOME-AWAY-gw" -> kick-off
    (fx.teams || []).forEach((t) => (t.matches || []).forEach((m) => {
      if (m.comp === 'PL' && m.home && m.gw) kick.set(`${t.short}-${m.oppShort}-${m.gw}`, m.t);
    }));
    const out = {};
    Object.entries(fdr.teams).forEach(([team, byGw]) => Object.entries(byGw).forEach(([gw, list]) => list.forEach((f) => {
      if (!f.home) return;
      const away = String(f.opp).toUpperCase();
      const back = ((fdr.teams[away] || {})[gw] || []).find((x) => String(x.opp).toUpperCase() === team && !x.home);
      (out[gw] = out[gw] || []).push({ home: team, away, hxg: f.xgf, axg: f.xga, hcs: f.cs, acs: back ? back.cs : Math.exp(-f.xgf), t: kick.get(`${team}-${away}-${gw}`) || null });
    })));
    return out;
  }

  const pct = (x) => `${Math.round(x * 100)}%`;
  // shade: stronger green for more goals / higher clean sheet chance
  const shade = (x, lo, hi) => { const a = Math.max(0, Math.min(1, (x - lo) / (hi - lo))); return `rgba(16, 122, 70, ${(0.08 + 0.55 * a).toFixed(2)})`; };
  const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Time to be set');

  // Table: one row per team and match, sortable by any column
  function renderTable() {
    const gw = $('gw').value;
    const rows = [];
    (state.matches[gw] || []).forEach((m) => {
      rows.push({ team: m.home, home: true, opp: m.away, goals: m.hxg, cs: m.hcs });
      rows.push({ team: m.away, home: false, opp: m.home, goals: m.axg, cs: m.acs });
    });
    const name = (t) => state.names[t] || t;
    const cols = [['team', 'Team'], ['opp', 'Opponent'], ['goals', 'Goals'], ['cs', 'Clean sheet']];
    const val = { team: (r) => name(r.team), opp: (r) => r.opp, goals: (r) => r.goals, cs: (r) => r.cs };
    const k = state.tsort;
    rows.sort((a, b) => { const x = val[k](a), y = val[k](b); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * state.tdir || b.goals - a.goals; });
    $('oddsTable').tHead.replaceChildren(el('tr', {}, ...cols.map(([key, label]) => {
      const th = el('th', { scope: 'col', className: key === 'goals' || key === 'cs' ? 'num' : '' }, el('button', { type: 'button', textContent: label + (key === k ? (state.tdir < 0 ? ' ▼' : ' ▲') : ''), onclick: () => {
        if (state.tsort === key) state.tdir *= -1; else { state.tsort = key; state.tdir = key === 'team' || key === 'opp' ? 1 : -1; }
        renderTable();
      } }));
      return th;
    })));
    $('oddsTable').tBodies[0].replaceChildren(...rows.map((r) => el('tr', {},
      el('td', { className: 'odds-tname' }, el('b', { textContent: name(r.team) }), ` (${r.home ? 'H' : 'A'})`),
      el('td', { textContent: r.opp, title: name(r.opp) }),
      el('td', { className: 'num odds-cell', style: `background:${shade(r.goals, 0.6, 2.4)}`, textContent: r.goals.toFixed(2) }),
      el('td', { className: 'num odds-cell', style: `background:${shade(r.cs, 0.1, 0.55)}`, textContent: pct(r.cs) }))));
  }

  function render() {
    $('tableBox').hidden = state.view !== 'table';
    $('list').hidden = state.view === 'table';
    $('matchSort').hidden = state.view === 'table';
    if (state.view === 'table') { renderTable(); return; }
    const gw = $('gw').value;
    const list = (state.matches[gw] || []).slice();
    const key = { time: (m) => (m.t ? Date.parse(m.t) : 9e15), goals: (m) => -(m.hxg + m.axg), cs: (m) => -Math.max(m.hcs, m.acs) }[state.sort];
    list.sort((a, b) => key(a) - key(b) || a.home.localeCompare(b.home));
    if (!list.length) { $('list').replaceChildren(el('p', { className: 'meta', textContent: `No league matches in GW${gw}.` })); return; }
    const rows = list.map((m) => {
      const side = (team, xg, cs, home) => el('div', { className: 'odds-side' },
        el('b', { className: 'odds-team', textContent: state.names[team] || team, title: team }),
        el('span', { className: 'odds-num', style: `background:${shade(xg, 0.6, 2.4)}`, textContent: xg.toFixed(2) }),
        el('span', { className: 'odds-num', style: `background:${shade(cs, 0.1, 0.55)}`, textContent: pct(cs) }),
        el('small', { textContent: home ? 'H' : 'A' }));
      return el('section', { className: 'odds-card' },
        el('p', { className: 'odds-when', textContent: when(m.t) }),
        el('div', { className: 'odds-grid' },
          el('span'), el('span', { className: 'odds-h', textContent: 'Goals' }), el('span', { className: 'odds-h', textContent: 'CS' }), el('span'),
          ...side(m.home, m.hxg, m.hcs, true).childNodes, ...side(m.away, m.axg, m.acs, false).childNodes));
    });
    $('list').replaceChildren(...rows);
  }

  document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    state.sort = b.dataset.sort;
    document.querySelectorAll('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('gw').addEventListener('change', render);
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));

  Promise.all(['fdr.json', 'fixtures.json'].map((f) => fetch(f, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); })))
    .then(([fdr, fx]) => {
      state.names = fdr.names || {};
      state.matches = build(fdr, fx);
      state.gws = (fdr.gws || Object.keys(state.matches).map(Number)).filter((g) => state.matches[g]);
      $('gw').replaceChildren(...state.gws.map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
      $('status').textContent = `Expected goals and clean sheet chances, GW${state.gws[0]}-${state.gws[state.gws.length - 1]}`;
      render();
    })
    .catch((e) => { $('error').textContent = `Could not load the data: ${e.message}`; $('error').hidden = false; });
})();
