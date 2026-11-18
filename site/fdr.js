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

  // As FPL does it, a match is rated by the opponent alone, home and away apart. Every club, once at home and once
  // away (40 sides), is ranked by its strength in our model (its average expected goals for and against over its
  // coming matches at that venue); the 4 strongest are 5, the next 10 are 4, the next 16 are 3 and the last 10 are 2
  // (the spread of FPL's own ratings).
  const STRENGTH = {
    overall: { f: (s) => s.xgf - s.xga, text: (s) => `${s.xgf.toFixed(2)} for, ${s.xga.toFixed(2)} against`, show: (v) => (v >= 0 ? '+' : '') + v.toFixed(2) }, // scores more, concedes less
    attack: { f: (s) => -s.xga, text: (s) => `concedes ${s.xga.toFixed(2)} a match`, show: (v) => (-v).toFixed(2) }, // our goals depend on their defence
    defence: { f: (s) => s.xgf, text: (s) => `scores ${s.xgf.toFixed(2)} a match`, show: (v) => v.toFixed(2) }, // our clean sheet depends on their attack
  };
  function strength(kind) {
    const list = [];
    Object.entries(data.teams).forEach(([short, t]) => {
      [true, false].forEach((home) => {
        const ms = data.gws.flatMap((g) => (t[g] || []).filter((m) => m.home === home));
        const use = ms.length ? ms : data.gws.flatMap((g) => t[g] || []);
        const s = { xgf: use.reduce((a, m) => a + (m.xgf || 0), 0) / (use.length || 1), xga: use.reduce((a, m) => a + m.xga, 0) / (use.length || 1) };
        list.push({ short, home, s, v: STRENGTH[kind].f(s) });
      });
    });
    list.sort((x, y) => y.v - x.v);
    const tier = {};
    list.forEach((x, i) => { x.tier = i < 4 ? 5 : i < 14 ? 4 : i < 30 ? 3 : 2; tier[`${x.short}|${x.home}`] = x.tier; });
    return { list, tier };
  }

  // Ranking: the 40 sides from hardest to easiest to face, for each table. "ARS (A)" is a trip to Arsenal.
  function renderRanking() {
    $('#ranking').replaceChildren(...[['overall', 'Overall'], ['attack', 'Attack'], ['defence', 'Defence']].map(([kind, name]) => {
      const { list } = strength(kind);
      return el('div', { className: 'fdr-rank' }, el('table', { className: 'minutes' },
        el('caption', { textContent: name }),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', className: 'num', textContent: '#' }), el('th', { scope: 'col', textContent: 'Opponent' }),
          el('th', { scope: 'col', className: 'num', textContent: kind === 'overall' ? 'xG +/-' : kind === 'attack' ? 'xG conceded' : 'xG scored' }))),
        el('tbody', {}, ...list.map((x, i) => el('tr', { title: `${data.names[x.short] || x.short} ${x.home ? 'at home' : 'away'}: ${STRENGTH[kind].text(x.s)}, FDR ${x.tier}` },
          el('td', { className: 'num', textContent: String(i + 1) }),
          el('td', {}, el('span', { className: `fdr-m r${x.tier}` }, el('b', { textContent: `${x.short} (${x.home ? 'A' : 'H'})` }), el('small', { textContent: String(x.tier) }))),
          el('td', { className: 'num', textContent: STRENGTH[kind].show(x.v) }))))));
    }));
  }

  function render() {
    document.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === state.kind)));
    const ranking = state.kind === 'ranking';
    $('#ranking').hidden = !ranking;
    $('.fdr-wrap').hidden = ranking;
    $('#range').closest('label').hidden = ranking;
    store.set('fdr-view', JSON.stringify(state));
    if (ranking) { renderRanking(); return; }
    const k = KIND[state.kind];
    const gws = data.gws.slice(0, state.range);
    const { tier } = strength(state.kind);
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
    if (!KIND[state.kind] && state.kind !== 'ranking') state.kind = 'overall';
    state.range = Math.min(Math.max(1, Number(state.range) || 6), data.gws.length);
    $('#range').replaceChildren(...data.gws.map((g, i) => el('option', { value: String(i + 1), textContent: String(i + 1) })));
    $('#range').value = String(state.range);
    $('#range').addEventListener('change', (e) => { state.range = Number(e.target.value); render(); });
    document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { state.kind = b.dataset.kind; render(); }));
    $('#status').textContent = `GW${data.gws[0]}-${data.gws[data.gws.length - 1]}, from our own model`;
    render();
  }).catch((e) => { $('#status').textContent = 'Not loaded'; $('#error').textContent = String(e.message || e); $('#error').hidden = false; });
})();
