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
    // Each club against its own fixtures: its coming matches (every gameweek we have, so a rating does not move
    // with the range picked) ranked from hardest to easiest, then FPL's own spread: the hardest 5% get 5, the next
    // 25% get 4, the middle 43% get 3, the next 25% get 2, and only the easiest 2% get 1.
    const rate = new Map();
    Object.values(data.teams).forEach((t) => {
      const ms = data.gws.flatMap((g) => t[g] || []);
      const order = ms.slice().sort((x, y) => k.v(x) - k.v(y));
      order.forEach((m, i) => {
        const q = (i + 0.5) / order.length;
        rate.set(m, q < 0.05 ? 5 : q < 0.30 ? 4 : q < 0.73 ? 3 : q < 0.98 ? 2 : 1);
      });
    });
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
