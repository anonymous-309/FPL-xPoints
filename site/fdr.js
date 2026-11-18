// Fixture difficulty from our own model: overall, attack and defence, per club and coming gameweek.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k != null)); return n; };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const state = { kind: 'overall', range: 6 };
  let data;
  // value of one match for each table (higher is easier) and how it is written in the cell
  const KIND = {
    overall: { v: (m) => (m.xgf || 0) - m.xga, text: (x) => (x >= 0 ? '+' : '') + x.toFixed(2), title: (m) => `expected goals ${(m.xgf || 0).toFixed(2)} for, ${m.xga.toFixed(2)} against` },
    attack: { v: (m) => m.xgf || 0, text: (x) => x.toFixed(2), title: (m) => `expected goals scored ${(m.xgf || 0).toFixed(2)}` },
    defence: { v: (m) => m.cs, text: (x) => `${Math.round(x * 100)}%`, title: (m) => `clean sheet ${Math.round(m.cs * 100)}%, expected conceded ${m.xga.toFixed(2)}` },
  };

  function render() {
    const k = KIND[state.kind];
    const gws = data.gws.slice(0, state.range);
    document.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === state.kind)));
    // As FPL does it, a match is rated by the opponent alone, at home and away apart: every club is ranked by its
    // strength from our model (its average expected goals for and against over its coming matches at that venue),
    // then the 2 strongest are 5, the next 5 are 4, the next 8 are 3 and the last 5 are 2.
    const STRENGTH = {
      overall: (s) => s.xgf - s.xga, // stronger side: scores more, concedes less
      attack: (s) => -s.xga, // our goals depend on their defence: conceding little is hard to score against
      defence: (s) => s.xgf, // our clean sheet depends on their attack
    };
    const avg = {};
    Object.entries(data.teams).forEach(([short, t]) => {
      [true, false].forEach((home) => {
        const ms = data.gws.flatMap((g) => (t[g] || []).filter((m) => m.home === home));
        const all = data.gws.flatMap((g) => t[g] || []);
        const use = ms.length ? ms : all;
        avg[`${short}|${home}`] = { xgf: use.reduce((a, m) => a + (m.xgf || 0), 0) / (use.length || 1), xga: use.reduce((a, m) => a + m.xga, 0) / (use.length || 1) };
      });
    });
    const tier = {};
    [true, false].forEach((home) => {
      Object.keys(data.teams).map((short) => [short, STRENGTH[state.kind](avg[`${short}|${home}`])])
        .sort((x, y) => y[1] - x[1])
        .forEach(([short], i) => { tier[`${short}|${home}`] = i < 2 ? 5 : i < 7 ? 4 : i < 15 ? 3 : 2; });
    });
    const rate = new Map();
    Object.values(data.teams).forEach((t) => data.gws.forEach((g) => (t[g] || []).forEach((m) => {
      rate.set(m, tier[`${m.opp.toUpperCase()}|${!m.home}`] || 3); // the opponent plays at the other venue
    })));
    const rating = (x, m) => rate.get(m);
    const rows = Object.entries(data.teams).map(([short, t]) => {
      const total = gws.reduce((s, g) => s + (t[g] || []).reduce((a, m) => a + k.v(m), 0), 0);
      const rs = gws.flatMap((g) => (t[g] || []).map((m) => rating(0, m)));
      return { short, t, total, avg: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
    }).sort((a, b) => b.total - a.total);
    $('.fdr thead').replaceChildren(el('tr', {}, el('th', { scope: 'col', textContent: 'Team' }), el('th', { scope: 'col', className: 'num', textContent: 'Total' }),
      ...gws.map((g) => el('th', { scope: 'col', textContent: `GW${g}` }))));
    $('.fdr tbody').replaceChildren(...rows.map(({ short, t, total }) => el('tr', {},
      el('td', { className: 'player', textContent: data.names[short] || short }),
      el('td', { className: 'num', textContent: k.text(total) }),
      ...gws.map((g) => {
        const ms = t[g] || [];
        if (!ms.length) return el('td', { className: 'fdr-cell blank', textContent: 'Blank' });
        return el('td', { className: `fdr-cell${ms.length > 1 ? ' double' : ''}` }, ...ms.map((m) => el('span', { className: `fdr-m r${rating(0, m)}`, title: `${m.opp} (${m.home ? 'H' : 'A'}): FDR ${rating(0, m)}, ${k.title(m)}` },
          el("b", { textContent: `${m.opp.toUpperCase()} (${m.home ? "H" : "A"})` }), el('small', { textContent: String(rating(0, m)) }))));
      }))));
    store.set('fdr-view', JSON.stringify(state));
  }

  fetch('fdr.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`fdr.json: HTTP ${r.status}`); return r.json(); }).then((d) => {
    data = d;
    try { Object.assign(state, JSON.parse(store.get('fdr-view') || '{}')); } catch (e) { /* ignore */ }
    if (!KIND[state.kind]) state.kind = 'overall';
    state.range = Math.min(Math.max(1, Number(state.range) || 6), data.gws.length);
    $('#range').replaceChildren(...data.gws.map((g, i) => el('option', { value: String(i + 1), textContent: String(i + 1) })));
    $('#range').value = String(state.range);
    $('#range').addEventListener('change', (e) => { state.range = Number(e.target.value); render(); });
    document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { state.kind = b.dataset.kind; render(); }));
    $('#status').textContent = `GW${data.gws[0]}-${data.gws[data.gws.length - 1]}, from our own model`;
    render();
  }).catch((e) => { $('#status').textContent = 'Not loaded'; $('#error').textContent = String(e.message || e); $('#error').hidden = false; });
})();
