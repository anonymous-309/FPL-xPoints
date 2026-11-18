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
    // the official FPL spread over every match shown: 5 for the hardest 5%, 4 the next 25%, 3 the middle 43%,
    // 2 the next 25%, and 1 only for the easiest 2% (FPL itself gives almost no 1s)
    const vals = [];
    Object.values(data.teams).forEach((t) => gws.forEach((g) => (t[g] || []).forEach((m) => vals.push(k.v(m)))));
    vals.sort((a, b) => a - b);
    const cut = [0.05, 0.30, 0.73, 0.98].map((q) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))]);
    const rating = (x) => 5 - cut.filter((c) => x >= c).length; // 1 easiest .. 5 hardest
    const rows = Object.entries(data.teams).map(([short, t]) => {
      const total = gws.reduce((s, g) => s + (t[g] || []).reduce((a, m) => a + k.v(m), 0), 0);
      const rs = gws.flatMap((g) => (t[g] || []).map((m) => rating(k.v(m))));
      return { short, t, total, avg: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
    }).sort((a, b) => b.total - a.total);
    $('.fdr thead').replaceChildren(el('tr', {}, el('th', { scope: 'col', textContent: 'Team' }), el('th', { scope: 'col', className: 'num', textContent: 'Avg FDR' }),
      ...gws.map((g) => el('th', { scope: 'col', textContent: `GW${g}` }))));
    $('.fdr tbody').replaceChildren(...rows.map(({ short, t, avg }) => el('tr', {},
      el('td', { className: 'player', textContent: data.names[short] || short }),
      el('td', { className: 'num', textContent: avg == null ? '–' : avg.toFixed(1) }),
      ...gws.map((g) => {
        const ms = t[g] || [];
        if (!ms.length) return el('td', { className: 'fdr-cell blank', textContent: 'Blank' });
        return el('td', { className: `fdr-cell${ms.length > 1 ? ' double' : ''}` }, ...ms.map((m) => el('span', { className: `fdr-m r${rating(k.v(m))}`, title: `${m.opp} (${m.home ? 'H' : 'A'}): FDR ${rating(k.v(m))}, ${k.title(m)}` },
          el("b", { textContent: `${m.opp.toUpperCase()} (${m.home ? "H" : "A"})` }), el('small', { textContent: String(rating(k.v(m))) }))));
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
