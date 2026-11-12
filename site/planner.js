(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const KEY = 'planner-entry';
  const S = window.PlannerSolve;
  const CHIP_LABEL = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' };
  const POS_LABEL = { GK: 'GKP', DEF: 'DEF', MID: 'MID', FWD: 'FWD' };
  const state = { data: null, team: null, entry: null, plan: null, week: 0, overrides: XMin.load(), worker: null };

  // Club colours for the shirts: body, sleeves, stripes (or null).
  const KIT = {
    ARS: ['#db0007', '#ffffff', null], AVL: ['#7a1e3e', '#94bee5', null], BOU: ['#d71920', '#d71920', '#111111'], BRE: ['#e30613', '#e30613', '#ffffff'],
    BHA: ['#0057b8', '#0057b8', '#ffffff'], BUR: ['#6c1d45', '#99d6ea', null], CHE: ['#034694', '#034694', null], COV: ['#68b6e8', '#68b6e8', null],
    CRY: ['#1b458f', '#1b458f', '#c4122e'], EVE: ['#003399', '#003399', null], FUL: ['#ffffff', '#ffffff', null], HUL: ['#f5a12d', '#f5a12d', '#111111'],
    IPS: ['#0044a9', '#ffffff', null], LEE: ['#ffffff', '#ffffff', null], LEI: ['#003090', '#003090', null], LIV: ['#c8102e', '#c8102e', null],
    MCI: ['#6cabdd', '#6cabdd', null], MUN: ['#da291c', '#da291c', null], NEW: ['#111111', '#111111', '#ffffff'], NFO: ['#dd0000', '#dd0000', null],
    SOU: ['#d71920', '#d71920', '#ffffff'], SUN: ['#eb172b', '#eb172b', '#ffffff'], TOT: ['#ffffff', '#ffffff', null], WHU: ['#7a263a', '#1bb1e7', null],
    WOL: ['#fdb913', '#fdb913', null], NOR: ['#fff200', '#00a650', null], WAT: ['#fbee23', '#ed2127', null], SHU: ['#ee2737', '#ee2737', '#ffffff'],
  };
  const GK_KITS = ['#e83e8c', '#2bb673', '#f2c200', '#7a5cff', '#00a6c8'];

  function shirt(team, gk) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const make = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); Object.entries(attrs).forEach(([k, val]) => n.setAttribute(k, val)); return n; };
    let [body, sleeve, stripe] = KIT[team] || ['#9aa5a0', '#9aa5a0', null];
    if (gk) { const h = [...(team || 'x')].reduce((a, c) => a + c.charCodeAt(0), 0); body = sleeve = GK_KITS[h % GK_KITS.length]; stripe = null; }
    const svg = make('svg', { viewBox: '0 0 40 40', class: 'shirt', 'aria-hidden': 'true' });
    const outline = '#00000033';
    svg.append(make('path', { d: 'M12 4 L16 2 Q20 6 24 2 L28 4 L30 16 L30 38 L10 38 L10 16 Z', fill: body, stroke: outline, 'stroke-width': '.6' }));
    if (stripe) [12.5, 18.5, 24.5].forEach((x) => svg.append(make('rect', { x, y: x === 18.5 ? 5.5 : 4.5, width: 3, height: x === 18.5 ? 32.5 : 33.5, fill: stripe })));
    svg.append(make('path', { d: 'M12 4 L2 10 L6 18 L10.4 15.6 Z', fill: sleeve, stroke: outline, 'stroke-width': '.6' }));
    svg.append(make('path', { d: 'M28 4 L38 10 L34 18 L29.6 15.6 Z', fill: sleeve, stroke: outline, 'stroke-width': '.6' }));
    svg.append(make('path', { d: 'M16 2 Q20 6 24 2', fill: 'none', stroke: '#00000055', 'stroke-width': '1' }));
    return svg;
  }

  // "HUL (A)" style: FPL's labels are upper case at home.
  const fixture = (opp) => (opp && opp.length ? opp.map((o) => `${o.toUpperCase()} (${o === o.toUpperCase() ? 'H' : 'A'})`).join(', ') : 'Blank');

  // ---- inputs ----
  function horizonGws() { return state.data.gws.slice(0, Number($('horizon').value)); }

  function chipChoices() {
    const box = $('chips');
    const before = {};
    box.querySelectorAll('select').forEach((s) => { before[s.dataset.key] = s.value; });
    box.replaceChildren();
    if (!state.team) return;
    const gws = horizonGws();
    const list = (state.team.chipsAvailable || []).filter((c) => c.to >= gws[0] && c.from <= gws[gws.length - 1]);
    if (!list.length) { box.append(el('span', { className: 'meta', textContent: 'No chips left for these gameweeks' })); return; }
    const count = {};
    list.forEach((c) => { count[c.name] = (count[c.name] || 0) + 1; });
    list.forEach((c) => {
      const key = `${c.name}-${c.from}`;
      const s = el('select', {}, el('option', { value: '', textContent: 'Not used' }),
        ...gws.filter((g) => g >= c.from && g <= c.to).map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
      s.dataset.key = key;
      s.dataset.chip = c.name;
      if (before[key] && [...s.options].some((o) => o.value === before[key])) s.value = before[key];
      box.append(el('label', {}, `${CHIP_LABEL[c.name] || c.label}${count[c.name] > 1 ? ` (GW${c.from}-${c.to})` : ''}`, s));
    });
  }

  function chosenChips() {
    const gws = horizonGws();
    const chips = {}, seen = {};
    let clash = null;
    $('chips').querySelectorAll('select').forEach((s) => {
      if (!s.value) return;
      const t = gws.indexOf(Number(s.value));
      if (seen[t]) clash = `Only one chip a gameweek: ${seen[t]} and ${CHIP_LABEL[s.dataset.chip]} are both set for GW${s.value}.`;
      seen[t] = CHIP_LABEL[s.dataset.chip];
      (chips[s.dataset.chip] = chips[s.dataset.chip] || []).push(t);
    });
    return { chips, clash };
  }

  // ---- data for the solver ----
  function players(gws) {
    const own = new Map(state.team.squad.map((s) => [s.id, s]));
    const byId = new Map(state.data.players.map((p) => [p.id, p]));
    const out = state.data.players.map((p) => {
      const xp = [], p1 = [], opp = [];
      gws.forEach((g) => {
        const d = XMin.view(state.overrides, p, g);
        xp.push(d ? Math.max(0, d.xpts) : 0);
        opp.push(d ? d.opp : []);
        // with the viewer's own minutes he plays if they are above 0
        p1.push(!d ? 0 : d.edited && d.edited !== 'model' ? (d.mins.some((m) => m > 0) ? 1 : 0) : (d.pApp1 ?? 1));
      });
      return { id: p.id, name: p.name, team: p.team, position: p.position, price: p.price, owned: own.has(p.id), sell: own.get(p.id)?.sell, xp, p1, opp };
    });
    // an owned player with no prediction (left the league): kept with no points
    own.forEach((s, id) => {
      if (!byId.has(id)) out.push({ id, name: s.name, team: s.team, position: s.position, price: s.price, owned: true, sell: s.sell, xp: gws.map(() => 0), p1: gws.map(() => 0), opp: gws.map(() => []) });
    });
    return out;
  }

  // Keeping the squad: best 11 and captain each week, no transfers or chips, with auto-subs.
  function holdPoints(P, T) {
    const squad = P.map((p, i) => i).filter((i) => P[i].owned);
    let total = 0;
    for (let t = 0; t < T; t++) {
      const ps = P.map((p) => ({ position: p.position, xp: p.xp[t], p1: p.p1[t] }));
      let best = null;
      for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) {
        const f = 10 - d - m;
        if (f < 1 || f > 3) continue;
        let xi = [];
        [['GK', 1], ['DEF', d], ['MID', m], ['FWD', f]].forEach(([pos, k]) => { xi = xi.concat(squad.filter((i) => P[i].position === pos).sort((a, b) => P[b].xp[t] - P[a].xp[t]).slice(0, k)); });
        const s = xi.reduce((a, i) => a + P[i].xp[t], 0);
        if (xi.length === 11 && (!best || s > best.s)) best = { xi, s };
      }
      if (!best) continue;
      const byXp = best.xi.slice().sort((a, b) => P[b].xp[t] - P[a].xp[t]);
      const rest = squad.filter((i) => !best.xi.includes(i));
      const gk = rest.find((i) => P[i].position === 'GK');
      const bench = [gk].concat(rest.filter((i) => i !== gk).sort((a, b) => P[b].xp[t] - P[a].xp[t]));
      total += S.expectedWithSubs(ps, best.xi, bench, byXp[0], byXp[1], 2, false, 2000).xpts;
    }
    return total;
  }

  function solve(lp) {
    return new Promise((resolve, reject) => {
      if (state.worker) state.worker.terminate();
      const w = new Worker('planner-worker.js');
      state.worker = w;
      const timer = setTimeout(() => { w.terminate(); reject(new Error('The solver took too long. Try fewer gameweeks.')); }, 150000);
      w.onmessage = (e) => { clearTimeout(timer); w.terminate(); if (e.data.ok) resolve(e.data); else reject(new Error(e.data.error)); };
      w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'The solver could not load. Check your connection and try again.')); };
      w.postMessage({ lp, options: { time_limit: 60, mip_rel_gap: 0.005, presolve: 'on' } });
    });
  }

  async function makePlan() {
    const { chips, clash } = chosenChips();
    if (clash) { showError(clash); return; }
    $('error').hidden = true;
    const gws = horizonGws();
    const all = players(gws);
    const P = S.pool(all, state.team.squad.map((s) => s.id));
    const input = { players: P, T: gws.length, ft: state.team.ft, bank: state.team.bank, chips };
    const model = S.build(input);
    $('go').disabled = true;
    $('out').replaceChildren(el('p', { className: 'working', textContent: `Working out the best plan for GW${gws[0]}-${gws[gws.length - 1]} (usually a few seconds, up to a minute)…` }));
    try {
      const sol = await solve(S.toLP(model));
      if (!sol.values || !Object.keys(sol.values).length) throw new Error(`No plan found (${sol.status}).`);
      const weeks = S.decode(input, model, sol.values);
      state.plan = { gws, P, weeks, chips, status: sol.status, hold: holdPoints(P, gws.length) };
      state.week = 0;
      render();
    } catch (e) {
      showError(`Could not work out a plan: ${e.message}`);
      $('out').replaceChildren();
    } finally {
      $('go').disabled = false;
    }
  }

  // ---- display ----
  function card(P, i, t, w, isNew) {
    const p = P[i];
    const pts = p.xp[t] * (i === w.cap ? w.mult : 1);
    const badges = [];
    if (i === w.cap) badges.push(el('span', { className: 'pp-badge cap', textContent: w.mult === 3 ? 'TC' : 'C', title: w.mult === 3 ? 'Triple captain' : 'Captain' }));
    else if (i === w.vice) badges.push(el('span', { className: 'pp-badge vice', textContent: 'V', title: 'Vice-captain' }));
    if (isNew) badges.push(el('span', { className: 'pp-badge new', textContent: 'IN', title: 'Bought this gameweek' }));
    return el('div', { className: 'pp-card', title: `${p.name}, ${p.team} ${p.position} £${p.price.toFixed(1)}: ${f1(p.xp[t])} xPts${i === w.cap ? ` × ${w.mult}` : ''}, plays ${Math.round(p.p1[t] * 100)}%` },
      el('div', { className: 'pp-badges' }, ...badges), shirt(p.team, p.position === 'GK'),
      el('span', { className: 'pp-name', textContent: p.name }),
      el('span', { className: 'pp-pts', textContent: f1(pts) }),
      el('span', { className: 'pp-opp', textContent: fixture(p.opp[t]) }));
  }

  function weekView(w) {
    const { P, gws } = state.plan;
    const t = w.t;
    const newIn = new Set(w.ins);
    const rows = ['GK', 'DEF', 'MID', 'FWD'].map((pos) => el('div', { className: 'pp-row' }, ...w.xi.filter((i) => P[i].position === pos).map((i) => card(P, i, t, w, newIn.has(i)))));
    const bench = el('div', { className: 'pp-bench' }, ...w.bench.map((i, k) => el('div', { className: 'pp-slot' },
      el('span', { className: 'pp-slot-label', textContent: k === 0 ? 'GKP' : `${k}. ${POS_LABEL[P[i].position]}` }), card(P, i, t, w, newIn.has(i)))));
    let moves;
    if (!w.transfersAllowed) moves = el('p', { className: 'meta', textContent: 'No transfers planned this far ahead: things change too fast. Plan again nearer the time.' });
    else if (!w.ins.length) moves = el('p', { className: 'meta', textContent: w.chip === 'freehit' ? 'Free Hit: keep the same squad.' : 'No transfer: save it.' });
    else {
      moves = el('table', { className: 'moves-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Out' }), el('th', { scope: 'col', textContent: 'In' }))),
        el('tbody', {}, ...w.outs.map((o, k) => {
          const n = w.ins[k];
          return el('tr', {},
            el('td', { className: 'outp' }, el('b', { textContent: P[o].name }), el('small', { textContent: ` ${P[o].team} ${P[o].position} £${(P[o].owned ? P[o].sell : P[o].price).toFixed(1)} · ${f1(P[o].xp[t])} xPts` })),
            el('td', { className: 'inp' }, n !== undefined ? el('b', { textContent: P[n].name }) : '', n !== undefined ? el('small', { textContent: ` ${P[n].team} ${P[n].position} £${P[n].price.toFixed(1)} · ${f1(P[n].xp[t])} xPts` }) : ''));
        })));
    }
    const facts = [];
    if (w.transfersAllowed && !w.chip) facts.push(`${w.freeTransfers} free transfer${w.freeTransfers === 1 ? '' : 's'}`, w.hits ? `${w.hits} hit${w.hits > 1 ? 's' : ''} (−${w.hits * S.HIT})` : 'no hit');
    if (w.chip === 'wildcard') facts.push('unlimited free transfers');
    if (w.chip === 'freehit') facts.push('unlimited transfers for this gameweek only; your squad comes back next week');
    if (w.bank !== null && w.transfersAllowed && w.chip !== 'freehit') facts.push(`bank £${w.bank.toFixed(1)} after`);
    return el('section', { className: 'week-view' },
      el('div', { className: 'week-head' },
        el('h2', {}, `GW${gws[t]}`, w.chip ? el('span', { className: 'chip-tag', textContent: CHIP_LABEL[w.chip] }) : ''),
        el('div', { className: 'week-pts' }, el('b', { textContent: f1(w.xpts) }), el('span', { textContent: ' xPts' }))),
      el('p', { className: 'meta', textContent: facts.join(', ') + (facts.length ? '. ' : '') + (w.subs > 0.05 ? `Auto-subs add about ${f1(w.subs)}.` : '') }),
      moves,
      el('div', { className: 'pp-pitch' }, el('div', { className: 'pp-lines', 'aria-hidden': 'true' }), ...rows),
      bench);
  }

  function render() {
    const { gws, weeks, hold } = state.plan;
    const total = weeks.reduce((a, w) => a + w.xpts, 0);
    const moves = weeks.reduce((a, w) => a + (w.chip === 'freehit' ? 0 : w.ins.length), 0);
    const hits = weeks.reduce((a, w) => a + w.hits, 0);
    const gain = total - hold;
    const tabs = el('div', { className: 'seg week-tabs', role: 'tablist' }, ...weeks.map((w, k) => {
      const b = el('button', { type: 'button', role: 'tab', onclick: () => { state.week = k; render(); } },
        el('span', { textContent: `GW${gws[k]}` }), el('small', { textContent: f1(w.xpts) + (w.chip ? ` · ${w.chip === '3xc' ? 'TC' : w.chip === 'bboost' ? 'BB' : w.chip === 'freehit' ? 'FH' : 'WC'}` : '') }));
      b.setAttribute('aria-selected', String(k === state.week));
      b.setAttribute('aria-pressed', String(k === state.week));
      return b;
    }));
    const summary = el('section', { className: 'summary' },
      el('p', {}, el('b', { textContent: `${f1(total)} xPts` }), ` over GW${gws[0]}-${gws[gws.length - 1]}, auto-subs included: `,
        el('b', { textContent: `${gain >= 0 ? '+' : ''}${f1(gain)}` }), ` on keeping your squad without chips (${f1(hold)}). ${moves} transfer${moves === 1 ? '' : 's'}, ${hits ? `${hits} hit${hits > 1 ? 's' : ''}` : 'no hits'}.`),
      state.team.madeAlready && state.team.madeAlready.length ? el('p', { className: 'meta', textContent: `Already made for GW${state.team.lastGw + 1}: ${state.team.madeAlready.join(', ')} (counted in your squad and free transfers).` }) : '',
      Object.keys(state.overrides).length ? el('p', { className: 'meta', textContent: `Uses your minutes edits from the Minutes page (${Object.keys(state.overrides).length} players).` }) : '',
      /optimal/i.test(state.plan.status) ? '' : el('p', { className: 'meta', textContent: `The search stopped at its time limit (${state.plan.status}); the plan is good but may not be the very best.` }));
    $('out').replaceChildren(summary, tabs, weekView(weeks[state.week]));
  }

  function showError(text) { $('error').textContent = text; $('error').hidden = false; }

  // ---- loading ----
  async function loadTeam(entry) {
    $('error').hidden = true;
    $('status').textContent = `Loading team ${entry}`;
    const r = await fetch(`plans/${entry}.json`, { cache: 'no-store' });
    if (r.status === 404) throw new Error(`No data for team ${entry} yet. Add ${entry} to planner_ids.txt in the GitHub repo; it appears after the next update.`);
    if (!r.ok) throw new Error('Could not load the team. Reload the page to try again.');
    const team = await r.json();
    if (!Array.isArray(team.squad) || !team.squad[0] || typeof team.squad[0] !== 'object') throw new Error('The team data is from an older version of the site. It is refreshed at the next update.');
    state.team = team;
    state.entry = entry;
    try { localStorage.setItem(KEY, entry); } catch (e) { /* fine */ }
    const when = team.updatedAt ? new Date(team.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';
    $('status').textContent = `${team.name}${team.manager ? ' · ' + team.manager : ''} · bank £${team.bank.toFixed(1)}, ${team.ft} free transfer${team.ft === 1 ? '' : 's'}${when ? ' · read ' + when : ''}`;
    chipChoices();
  }

  async function go() {
    const entry = $('entry').value.trim();
    if (!/^\d+$/.test(entry) || !state.data) return;
    try {
      if (entry !== state.entry) await loadTeam(entry);
      await makePlan();
    } catch (e) {
      showError(e.message);
      $('status').textContent = 'Enter an FPL team ID';
      $('out').replaceChildren();
    }
  }

  $('pick').addEventListener('submit', (e) => { e.preventDefault(); go(); });
  $('horizon').addEventListener('change', chipChoices);
  $('entry').addEventListener('change', () => { if ($('entry').value.trim() !== state.entry) { state.team = null; state.entry = null; chipChoices(); } });
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') state.overrides = XMin.load(); });

  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch (e) { saved = ''; }
  $('entry').value = new URLSearchParams(location.search).get('id') || saved || '11081';
  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => { state.data = data; XMin.setPlayers(data.players); go(); })
    .catch(() => showError('Could not load the xPoints data. Reload the page to try again.'));
})();
