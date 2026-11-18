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
  // coming matches at that venue); as in FPL's own table, the 2 strongest are 5, the next 10 are 4, the next 17 are 3 and the last 11 are 2
  // (the spread of FPL's own ratings).
  // A club's strength: the model's expected goals for and against a match over its coming matches at that venue.
  // The model mixes real goals (70%) and xG (30%), recent matches weighing more.
  const STRENGTH = {
    overall: { f: (s) => s.xgf - s.xga, show: (v) => (v >= 0 ? '+' : '') + v.toFixed(2), head: 'For − against' }, // scores more, concedes less
    attack: { f: (s) => -s.xga, show: (v) => (-v).toFixed(2), head: 'Concedes' }, // our goals depend on their defence
    defence: { f: (s) => s.xgf, show: (v) => v.toFixed(2), head: 'Scores' }, // our clean sheet depends on their attack
  };
  // A side's strength = the club's average over all its coming matches (so who it happens to meet at home or away
  // does not skew it), plus or minus half the league's home edge. The model's full home edge put 10 of the top 12
  // sides as away trips; half of it gives about FPL's own mix (7 of its top 12 are away trips).
  const VENUE_WEIGHT = 0.5;
  const avgOf = (ms) => ({ xgf: ms.reduce((a, m) => a + (m.xgf || 0), 0) / (ms.length || 1), xga: ms.reduce((a, m) => a + m.xga, 0) / (ms.length || 1) });
  let edgeMemo = null;
  function homeEdge() {
    if (edgeMemo) return edgeMemo;
    const all = Object.values(data.teams).flatMap((t) => data.gws.flatMap((g) => t[g] || []));
    const h = avgOf(all.filter((m) => m.home)), a = avgOf(all.filter((m) => !m.home));
    edgeMemo = { xgf: (h.xgf - a.xgf) / 2, xga: (h.xga - a.xga) / 2 }; // half the home-away gap each way
    return edgeMemo;
  }
  function sideStrength(short, home) {
    const t = data.teams[short];
    const base = avgOf(data.gws.flatMap((g) => t[g] || []));
    const e = homeEdge();
    const k = (home ? 1 : -1) * VENUE_WEIGHT;
    const xgf = base.xgf + k * e.xgf, xga = base.xga + k * e.xga;
    return { xgf, xga, text: `expected goals a match ${home ? 'at home' : 'away'}: ${xgf.toFixed(2)} scored, ${xga.toFixed(2)} conceded (all its coming matches, half the league's home edge ${home ? 'added' : 'taken off'}; model: real goals 70%, xG 30%, recent matches weigh more)` };
  }
  function strength(kind) {
    const list = [];
    Object.keys(data.teams).forEach((short) => {
      [true, false].forEach((home) => {
        const s = sideStrength(short, home);
        list.push({ short, home, s, v: STRENGTH[kind].f(s) });
      });
    });
    list.sort((x, y) => y.v - x.v);
    const tier = {};
    list.forEach((x, i) => { x.tier = i < 2 ? 5 : i < 12 ? 4 : i < 29 ? 3 : 2; tier[`${x.short}|${x.home}`] = x.tier; });
    return { list, tier };
  }

  // Ranking: the 40 sides from hardest to easiest to face, for each table. "ARS (A)" is a trip to Arsenal.
  function renderRanking() {
    $('#ranking').replaceChildren(...[['overall', 'Overall'], ['attack', 'Attack'], ['defence', 'Defence']].map(([kind, name]) => {
      const { list } = strength(kind);
      return el('div', { className: 'fdr-rank' }, el('table', { className: 'minutes' },
        el('caption', { textContent: name }),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', className: 'num', textContent: '#' }), el('th', { scope: 'col', textContent: 'Opponent' }),
          el('th', { scope: 'col', className: 'num', textContent: STRENGTH[kind].head, title: 'Expected goals a match (model: real goals 70%, xG 30%)' }))),
        el('tbody', {}, ...list.map((x, i) => el('tr', { title: `${data.names[x.short] || x.short} ${x.home ? 'at home' : 'away'}, FDR ${x.tier}. ${x.s.text}` },
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
