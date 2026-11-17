(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
  const KEY = 'planner-entry';
  const S = window.PlannerSolve;
  const CHIP_LABEL = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' };
  const POS_LABEL = { GK: 'GKP', DEF: 'DEF', MID: 'MID', FWD: 'FWD' };
  // Address of the Cloudflare Worker that reads FPL for the page (tools/cloudflare-worker.js). Empty: only teams the
  // site build read (planner_ids.txt). ?proxy=https://... on the page address tries another one and remembers it.
  const PROXY_DEFAULT = 'https://fpl-proxy.ntp2503.workers.dev';
  const PROXY = (() => {
    const q = new URLSearchParams(location.search).get('proxy');
    try { if (q) localStorage.setItem('planner-proxy', q); return (q || localStorage.getItem('planner-proxy') || PROXY_DEFAULT).replace(/\/+$/, ''); } catch (e) { return (q || PROXY_DEFAULT).replace(/\/+$/, ''); }
  })();
  const state = { settings: null, data: null, team: null, entry: null, plan: null, week: 0, overrides: XMin.load(), worker: null };

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
      return { id: p.id, name: p.name, team: p.team, position: p.position, price: p.price, owned: own.has(p.id), sell: own.get(p.id)?.sell, xp, p1, opp, status: p.status || 'a' };
    });
    // an owned player with no prediction (left the league): kept with no points
    own.forEach((s, id) => {
      if (!byId.has(id)) out.push({ id, name: s.name, team: s.team, position: s.position, price: s.price, owned: true, sell: s.sell, xp: gws.map(() => 0), p1: gws.map(() => 0), opp: gws.map(() => []) });
    });
    return out;
  }

  // Keeping the squad: best 11 and captain each week, no transfers or chips, with auto-subs.
  function bestXI(P, squad, t) {
    let best = null;
    for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) {
      const f = 10 - d - m;
      if (f < 1 || f > 3) continue;
      let xi = [];
      [['GK', 1], ['DEF', d], ['MID', m], ['FWD', f]].forEach(([pos, k]) => { xi = xi.concat(squad.filter((i) => P[i].position === pos).sort((a, b) => P[b].xp[t] - P[a].xp[t]).slice(0, k)); });
      const s = xi.reduce((a, i) => a + P[i].xp[t], 0);
      if (xi.length === 11 && (!best || s > best.s)) best = { xi, s };
    }
    return best;
  }

  // How much of a bench player's points the search counts each week: the chance he is needed, from how many of the
  // squad's likely starters may not play (an outfield bench player covers a third of the expected absences).
  function benchWeights(P, T) {
    const squad = P.map((p, i) => i).filter((i) => P[i].owned);
    const out = [], gk = [];
    for (let t = 0; t < T; t++) {
      const best = bestXI(P, squad, t);
      if (!best) { out.push(0.1); gk.push(0.1); continue; }
      const missing = best.xi.filter((i) => P[i].position !== 'GK').reduce((a, i) => a + (1 - Math.min(1, P[i].p1[t])), 0);
      const keeper = best.xi.find((i) => P[i].position === 'GK');
      out.push(Math.max(0.05, Math.min(0.8, missing / 3)));
      gk.push(Math.max(0.02, Math.min(0.9, 1 - Math.min(1, P[keeper].p1[t]))));
    }
    return { out, gk };
  }

  // The gameweeks after the transfer weeks, for a squad that stays: best 11, captain, vice and bench each week.
  function heldWeeks(P, merged, from, T) {
    const squad = merged.xi.concat(merged.bench);
    let ft = merged.freeTransfers;
    const out = [];
    for (let t = from; t < T; t++) {
      const ps = P.map((p) => ({ position: p.position, xp: p.xp[t], p1: p.p1[t] }));
      const best = bestXI(P, squad, t) || { xi: merged.xi };
      const xi = best.xi.slice().sort((a, b) => ['GK', 'DEF', 'MID', 'FWD'].indexOf(P[a].position) - ['GK', 'DEF', 'MID', 'FWD'].indexOf(P[b].position) || P[b].xp[t] - P[a].xp[t]);
      const byXp = xi.slice().sort((a, b) => P[b].xp[t] - P[a].xp[t]);
      const rest = squad.filter((i) => !xi.includes(i));
      const gk = rest.find((i) => P[i].position === 'GK');
      const bench = [gk].concat(rest.filter((i) => i !== gk).sort((a, b) => P[b].xp[t] - P[a].xp[t])).filter((i) => i !== undefined);
      const r = S.expectedWithSubs(ps, xi, bench, byXp[0], byXp[1], 2, false);
      ft = t === from ? ft : Math.min(S.MAX_FT, ft + 1);
      out.push({ t, chip: null, transfersAllowed: false, freeTransfers: ft, hits: 0, bank: null, xi, bench, cap: byXp[0], vice: byXp[1],
        ins: [], outs: [], mult: 2, xpts: r.xpts, subs: r.subs, raw: xi.reduce((a, i) => a + P[i].xp[t], 0) + P[byXp[0]].xp[t] });
    }
    return out;
  }

  // Expected points of the squad as it is, each gameweek (best 11, captain, auto-subs).
  function holdWeeks(P, T) {
    const squad = P.map((p, i) => i).filter((i) => P[i].owned);
    const out = [];
    for (let t = 0; t < T; t++) {
      out.push(0);
      const ps = P.map((p) => ({ position: p.position, xp: p.xp[t], p1: p.p1[t] }));
      const best = bestXI(P, squad, t);
      if (!best) continue;
      const byXp = best.xi.slice().sort((a, b) => P[b].xp[t] - P[a].xp[t]);
      const rest = squad.filter((i) => !best.xi.includes(i));
      const gk = rest.find((i) => P[i].position === 'GK');
      const bench = [gk].concat(rest.filter((i) => i !== gk).sort((a, b) => P[b].xp[t] - P[a].xp[t]));
      out[t] = S.expectedWithSubs(ps, best.xi, bench, byXp[0], byXp[1], 2, false, 2000).xpts;
    }
    return out;
  }
  const holdPoints = (P, T) => holdWeeks(P, T).reduce((a, b) => a + b, 0);

  // Expected points of a given 15 in gameweek t (best 11, captain, auto-subs).
  function squadPts(P, squad, t) {
    const best = bestXI(P, squad, t);
    if (!best) return 0;
    const ps = P.map((p) => ({ position: p.position, xp: p.xp[t], p1: p.p1[t] }));
    const byXp = best.xi.slice().sort((a, b) => P[b].xp[t] - P[a].xp[t]);
    const rest = squad.filter((i) => !best.xi.includes(i));
    const gk = rest.find((i) => P[i].position === 'GK');
    const bench = [gk].concat(rest.filter((i) => i !== gk).sort((a, b) => P[b].xp[t] - P[a].xp[t]));
    return S.expectedWithSubs(ps, best.xi, bench, byXp[0], byXp[1], 2, false, 2000).xpts;
  }

  // What each gameweek's moves are worth on their own: the squad after them against the squad before them, that
  // gameweek (hits taken off) and over the rest of the plan, each gameweek weighed as in xPts Decay (0.85 a week from
  // the first gameweek of the plan). The moves' figures then add up to the plan's Gain Decay.
  function moveGains(P, weeks, depth, T) {
    const out = [];
    let before = P.map((p, i) => i).filter((i) => P[i].owned);
    weeks.slice(0, depth).forEach((w, t) => {
      const after = w.xi.concat(w.bench);
      if (!w.ins.length || w.chip === 'freehit' || w.chip === 'wildcard') {
        out.push(null);
        if (w.chip !== 'freehit') before = after;
        return;
      }
      const hit = (w.hits || 0) * S.HIT;
      let now = 0, dec = 0, raw = 0;
      for (let u = t; u < T; u++) {
        const d = squadPts(P, after, u) - squadPts(P, before, u);
        if (u === t) now = d - hit;
        dec += Math.pow(PLAN.decay, u) * d;
        raw += d;
      }
      out.push({ now, dec: dec - Math.pow(PLAN.decay, t) * hit, raw: raw - hit });
      before = after;
    });
    return out;
  }

  // ---- settings ----
  const SET_KEY = 'planner-settings-v5';  // v5: kept free transfers worth less each, least gain per transfer
  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(SET_KEY)) || null;
      // carry settings over from the previous version, apart from the old saved-transfer value
      if (!saved) { saved = JSON.parse(localStorage.getItem('planner-settings-v4')) || JSON.parse(localStorage.getItem('planner-settings-v3')) || {}; }
      delete saved.ftValue;
    } catch (e) { saved = {}; }
    const st = { ...S.DEFAULTS, keep: [], avoid: [], forceIn: [], forceOut: [], forceGw: null, ...saved };
    // forced transfers only hold for the gameweek they were set for
    if (state.data && st.forceGw !== state.data.gws[0]) { st.forceIn = []; st.forceOut = []; st.forceGw = state.data.gws[0]; }
    return st;
  }
  function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(state.settings)); } catch (e) { /* fine */ } }

  function countsForm() {
    const box = $('planCounts');
    if (!box) return;
    const st = state.settings;
    const total = (arr) => arr.reduce((a, b) => a + b, 0);
    box.replaceChildren(...[1, 2, 3, 4, 5].map((ft) => {
      const arr = countsFor(ft);
      const sum = el('b', { className: 'pc-total', textContent: String(total(arr)) });
      const row = el('div', { className: 'pc-row' }, el('span', { className: 'pc-ft', textContent: `${ft} FT` }));
      arr.forEach((n, k) => {
        const name = k === 0 ? 'Save' : k <= ft ? `${k} FT` : `${ft} FT + ${k - ft} hit`;
        const input = el('input', { type: 'number', min: k === 0 ? '1' : '0', max: '5', step: '1', value: String(n), 'aria-label': `${ft} free transfers: plans for ${name}` });
        input.addEventListener('change', () => {
          const cur = countsFor(ft);
          let v = Math.max(k === 0 ? 1 : 0, Math.min(5, Math.round(Number(input.value) || 0)));
          const rest = total(cur) - cur[k];
          let warn = '';
          if (rest + v > MAX_PLANS) { v = Math.max(k === 0 ? 1 : 0, MAX_PLANS - rest); warn = `Up to ${MAX_PLANS} plans in all: each one takes a few seconds to work out, so more would make the planner slow (about a minute for 10 on a phone).`; }
          cur[k] = v;
          st.planCounts = { ...(st.planCounts || {}), [ft]: cur };
          saveSettings();
          countsForm();
          $('pcWarn').textContent = warn;
          $('pcWarn').hidden = !warn;
        });
        row.append(el('label', { className: 'pc-cell' }, el('span', { textContent: name }), input));
      });
      row.append(el('span', { className: 'pc-sum' }, 'Total ', sum));
      return row;
    }));
  }

  function settingsForm() {
    countsForm();
    const st = state.settings;
    const T = Number($('horizon').value);
    $('forceGw').textContent = `GW${state.data.gws[0]}`;
    ['keep', 'avoid', 'forceIn', 'forceOut'].forEach((kind) => {
      $(`${kind}List`).replaceChildren(...st[kind].map((id) => {
        const p = state.data.players.find((x) => x.id === id) || (state.team && state.team.squad.find((x) => x.id === id));
        return el('span', { className: 'pick-tag' }, p ? `${p.name} (${p.team})` : id,
          el('button', { type: 'button', textContent: '×', title: 'Remove', 'aria-label': `Remove ${p ? p.name : id}`, onclick: () => { st[kind] = st[kind].filter((x) => x !== id); saveSettings(); settingsForm(); } }));
      }));
    });
  }

  function readSettings() {
    const st = state.settings;
    saveSettings();
  }

  function addPick(kind, quiet) {
    const text = $(`${kind}Pick`).value.trim();
    if (!text) return;
    const label = (p) => `${p.name} (${p.team} ${p.position})`;
    const p = state.data.players.find((x) => label(x) === text) || state.data.players.find((x) => x.name.toLowerCase() === text.toLowerCase());
    if (!p) { if (!quiet) showError(`No player called "${text}". Pick one from the list.`); return; }
    $('error').hidden = true;
    const owned = state.team && state.team.squad.some((x) => x.id === p.id);
    if (kind === 'forceIn' && owned) { showError(`${p.name} is already in your squad.`); return; }
    if (kind === 'forceOut' && state.team && !owned) { showError(`${p.name} is not in your squad.`); return; }
    // a player can only be in one list that makes sense together
    const clash = { keep: ['avoid', 'forceOut'], avoid: ['keep', 'forceIn'], forceIn: ['avoid', 'forceOut'], forceOut: ['keep', 'forceIn'] }[kind];
    clash.forEach((other) => { state.settings[other] = state.settings[other].filter((x) => x !== p.id); });
    state.settings.forceGw = state.data.gws[0];
    if (!state.settings[kind].includes(p.id)) state.settings[kind].push(p.id);
    $(`${kind}Pick`).value = '';
    saveSettings();
    settingsForm();
  }

  // ---- solving ----
  // One worker for the whole tree of plans; each solve gets a fresh HiGHS inside it.
  // A fresh worker for every solve: HiGHS in WebAssembly does not give memory back, and after several solves in one
  // worker it can run out and abort. A solve that aborts is tried once more in a new worker.
  function openSolver() {
    let current = null;
    const once = (lp, options) => new Promise((resolve, reject) => {
      const w = new Worker(`planner-worker.js?v=${state.data.updatedAt}`);
      current = w;
      const done = (fn, arg) => { clearTimeout(timer); w.terminate(); if (current === w) current = null; fn(arg); };
      const timer = setTimeout(() => done(reject, new Error('The solver took too long. Try fewer gameweeks.')), 120000);
      w.onmessage = (e) => (e.data.ok ? done(resolve, e.data) : done(reject, new Error(e.data.error)));
      w.onerror = (e) => done(reject, new Error(e.message || 'The solver could not load. Check your connection and try again.'));
      w.postMessage({ id: 1, lp, options });
    });
    // HiGHS in WebAssembly sometimes aborts on a long search; a looser stopping point avoids it
    const LADDER = [{ time_limit: 25, mip_rel_gap: 0.001, presolve: 'on' }, { time_limit: 20, mip_rel_gap: 0.01, presolve: 'on' },
      { time_limit: 10, mip_rel_gap: 0.03, presolve: 'on' }, { time_limit: 10, mip_rel_gap: 0.03, presolve: 'off' }];
    return {
      solve: async (lp) => {
        let last;
        for (const options of LADDER) {
          try { return await once(lp, options); } catch (e) {
            last = e;
            if (!/abort|memory|unreachable|unable to solve/i.test(e.message)) throw e;
          }
        }
        throw last;
      },
      close: () => { if (current) current.terminate(); },
    };
  }

  // How plans are judged (fixed for now). Transfers are planned for 4 gameweeks, each later gameweek weighed 0.85
  // times the one before. A free transfer used costs X (weighed like its gameweek), scaled by how many free transfers
  // are left in hand after it: 100% when it is the last one, then 75%, 50%, 25%, 0% (with 5 in hand one would be lost
  // anyway). So a move is only made early when it gains more than that. Free transfers left after the last transfer
  // week are worth Y each, the 1st 100%, then 75%, 50%, 25%, 0%; Y is 4 points weighed like that gameweek.
  // Prices can change before a later week's transfers, so a buy in the n-th gameweek from now leaves 0.1m x n in the bank.
  const BANK_BUFFER = 0.1;
  const PLAN = { depth: 4, decay: 0.85, X: 0.5, ftPts: 4, steps: [1, 0.75, 0.5, 0.25, 0] };
  const stepSum = (k) => PLAN.steps.slice(0, Math.max(0, k)).reduce((a, b) => a + b, 0);
  // FT bonus: every transfer week, each free transfer left after that week's transfers is worth 0.5 (4 at most, so 2
  // points), weighed like its gameweek; those left after the last transfer week earn it in every gameweek to the end.
  // A week's moves must still gain 0.5 per free transfer they use.
  const FTB = true; // the FT bonus way of judging plans (the older transfer cost and end value are kept below for reference)
  const FTB_X = 0.5, FTB_CAP = 4;
  // The weight of each transfer week's bonus. The free transfers left after the last transfer week also earn it in every
  // gameweek after (no transfers then); the free transfers gained in those weeks are the same for every plan, so they
  // are left out.
  const ftbWeights = (depth, T) => [...Array(depth).keys()].map((t) => FTB_X * (t < depth - 1 ? Math.pow(PLAN.decay, t)
    : [...Array(Math.max(1, T - t)).keys()].reduce((a, j) => a + Math.pow(PLAN.decay, t + j), 0)));
  const ftLeft = (w) => (w.chip === 'wildcard' || w.chip === 'freehit' ? w.freeTransfers : Math.max(w.freeTransfers - Math.min(w.ins.length, w.freeTransfers), 0));

  // the transfer cost and the value of free transfers kept, for a plan's weeks
  function planExtras(weeks, depth) {
    if (FTB) {
      let kept = 0, keptRaw = 0;
      const wts = ftbWeights(depth, weeks.length);
      weeks.slice(0, depth).forEach((w, t) => {
        const n = Math.min(ftLeft(w), FTB_CAP), weeksCounted = t < depth - 1 ? 1 : Math.max(1, weeks.length - t);
        kept += wts[t] * n; keptRaw += FTB_X * n * weeksCounted;
      });
      const last = weeks[depth - 1];
      const left = weeks[depth] ? weeks[depth].freeTransfers : Math.min(S.MAX_FT, ftLeft(last) + (last.chip === 'wildcard' || last.chip === 'freehit' ? 0 : 1));
      return { cost: 0, left, kept, costRaw: 0, keptRaw };
    }
    let cost = 0, costRaw = 0;
    weeks.slice(0, depth).forEach((w, t) => {
      if (w.chip === 'wildcard' || w.chip === 'freehit') return;
      const used = Math.min(w.ins.length, w.freeTransfers);
      const c = PLAN.X * (stepSum(w.freeTransfers) - stepSum(w.freeTransfers - used));
      cost += Math.pow(PLAN.decay, t) * c;
      costRaw += c;
    });
    const last = weeks[depth - 1];
    const left = weeks[depth] ? weeks[depth].freeTransfers
      : last.chip === 'wildcard' || last.chip === 'freehit' ? last.freeTransfers : Math.min(S.MAX_FT, Math.max(last.freeTransfers - last.ins.length, 0) + 1);
    const Y = PLAN.ftPts * Math.pow(PLAN.decay, depth - 1);
    // the same without the weekly 0.85 weighing, for the table's plain view
    return { cost, left, kept: Y * stepSum(left), costRaw, keptRaw: PLAN.ftPts * stepSum(left) };
  }

  // How many plans to look at, by free transfers in hand: plans for saving now (each with different moves the next
  // gameweek), for using 1, 2, ... free transfers now, and for one more with a hit. Set in Settings, 10 at most.
  const DEFAULT_COUNTS = { 1: [3, 3, 2], 2: [2, 2, 2, 2], 3: [2, 2, 2, 2, 1], 4: [1, 2, 2, 2, 1], 5: [1, 2, 2, 2, 1, 1] };
  const MAX_PLANS = 10;
  const countsFor = (ft) => {
    const own = state.settings.planCounts && state.settings.planCounts[ft];
    const def = DEFAULT_COUNTS[ft] || DEFAULT_COUNTS[1];
    return own && own.length === def.length ? own.slice() : def.slice();
  };
  function planCounts(ft, forcedN) {
    if (!forcedN && DEFAULT_COUNTS[ft]) return countsFor(ft).map((n, k) => [k, k === 0 ? 1 : n]).filter(([k, n]) => n > 0);
    const top = Math.max(ft, forcedN, 1);
    const out = [];
    for (let k = forcedN; k <= top; k++) out.push([k, k === forcedN ? 1 : top >= 4 && k >= top - 1 ? 1 : 2]);
    const total = () => out.reduce((a, [, n]) => a + n, 0);
    const want = top - forcedN <= 1 ? 5 : 7;
    const fill = want === 5 ? 4 : want; // with a single free transfer, keep one plan for a hit
    for (let round = 0; total() < fill && round < 2; round++) out.forEach((g) => { if (g[0] > forcedN && total() < fill) g[1]++; });
    if (total() < want && top < S.MAX_FT) out.push([top + 1, want - total()]);
    while (total() < want) out[out.length - 1][1]++;
    while (total() > 10) { const g = out.filter(([k, n]) => k > forcedN && n > 1).pop(); if (!g) break; g[1]--; }
    return out;
  }

  async function makePlan() {
    const { chips, clash } = chosenChips();
    if (clash) { showError(clash); return; }
    readSettings();
    $('error').hidden = true;
    const gws = horizonGws();
    const T = gws.length;
    const all = players(gws);
    const st = state.settings;
    const P = S.pool(all, state.team.squad.map((s) => s.id).concat(st.keep, st.avoid, st.forceIn, st.forceOut));
    const index = new Map(P.map((p, i) => [p.id, i]));
    // After the transfer weeks the squad stays, so those gameweeks are searched as one (their points summed, each
    // weighed as usual) to keep the search small; their starting 11, captain and bench are picked afterwards.
    const depth = Math.min(PLAN.depth, T);
    const merge = T > depth + 1 && !Object.values(chips).some((arr) => (arr || []).some((t) => t >= depth));
    const Tm = merge ? depth + 1 : T;
    const Pm = merge ? P.map((p) => ({ ...p, xp: p.xp.slice(0, depth).concat([p.xp.slice(depth).reduce((a, x, j) => a + Math.pow(PLAN.decay, j) * x, 0)]),
      p1: p.p1.slice(0, depth + 1) })) : P;
    const Y = PLAN.ftPts * Math.pow(PLAN.decay, depth - 1);
    const base = { players: Pm, T: Tm, ft: state.team.ft, bank: state.team.bank, chips,
      settings: { ...S.DEFAULTS, depth, decay: PLAN.decay, reserve: FTB ? [0, 0, 0, 0, 0] : PLAN.steps.map((m) => m * Y), minGain: 0, bankValue: 0, maxHits: null },
      ftMult: 1 / Math.pow(PLAN.decay, depth),
      bankBuffer: BANK_BUFFER,
      useCost: FTB ? null : { x: [...Array(depth).keys()].map((t) => PLAN.X * Math.pow(PLAN.decay, t)), steps: PLAN.steps },
      ftBonus: FTB ? { x: ftbWeights(depth, T), cap: FTB_CAP } : null,
      keep: st.keep.filter((id) => index.has(id)).map((id) => index.get(id)), avoid: st.avoid.filter((id) => index.has(id)).map((id) => index.get(id)) };
    const ownedIds = new Set(state.team.squad.map((x) => x.id));
    const fIn = st.forceIn.filter((id) => index.has(id) && !ownedIds.has(id)), fOut = st.forceOut.filter((id) => index.has(id) && ownedIds.has(id));
    const forcedN = Math.max(fIn.length, fOut.length);
    if (forcedN) base.force = { buys: fIn.map((id) => index.get(id)), sells: fOut.map((id) => index.get(id)) };
    const bw = benchWeights(P, T);
    base.benchW = bw.out.slice(0, Tm);
    base.benchWgk = bw.gk.slice(0, Tm);
    // The options this gameweek: the best plan for each number of transfers used now (saving them, 1, 2, ... up to
    // all free transfers); each plan then makes its own best moves for the next 3 gameweeks.
    const week0Chip = (chips.wildcard || []).includes(0) || (chips.freehit || []).includes(0);
    const groups = [];
    if (week0Chip) groups.push({ count: null, n: 3 });
    else planCounts(state.team.ft, forcedN).forEach(([k, n]) => groups.push({ count: k, n }));
    const saveBranches = depth > 1 && !week0Chip && !forcedN ? Math.max(1, countsFor(state.team.ft)[0]) : 1;
    let planned = groups.reduce((a, g) => a + g.n, 0) + saveBranches - 1;
    let done = 0;
    const progress = (text) => $('out').replaceChildren(el('p', { className: 'working', textContent: text }),
      el('div', { className: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(planned), 'aria-valuenow': String(done) }, el('span', { style: `width:${Math.round((100 * done) / planned)}%` })));
    $('go').disabled = true;
    progress(`Working out the plans for GW${gws[0]}-${gws[gws.length - 1]}…`);
    const solver = openSolver();
    let worst = 'Optimal', skipped = 0;
    const solveWith = async (extra) => {
      const input = { ...base, ...extra };
      const model = S.build(input);
      let sol;
      try { sol = await solver.solve(S.toLP(model)); } catch (e) {
        // the solver crashed on this one plan even after retries: leave it out rather than stop everything
        done++;
        if (!/abort|memory|unreachable|unable to solve/i.test(e.message)) throw e;
        skipped++;
        return null;
      }
      done++;
      progress(`Working out the plans: ${done} of ${planned}…`);
      if (!sol.values || !Object.keys(sol.values).length || /infeasible/i.test(sol.status)) return null;
      if (!/optimal/i.test(sol.status)) worst = sol.status;
      let weeks = S.decode(input, model, sol.values);
      if (merge) weeks = weeks.slice(0, depth).concat(heldWeeks(P, weeks[depth], depth, T));
      return { input, model, values: sol.values, score: sol.objective, weeks };
    };
    // The rule for each gameweek's moves: what they gain that gameweek (hits taken off) must be at least what the
    // free transfers they use cost (0.5 for the last one in hand, 75% with 1 left, ...). A later gameweek that breaks
    // it is planned again with no transfers that week; a plan whose first-gameweek moves break it is left out.
    const weekCost = (w) => {
      if (w.chip === 'wildcard' || w.chip === 'freehit') return 0;
      const used = Math.min(w.ins.length, w.freeTransfers);
      // the 5th free transfer cannot be saved (5 is the most you can hold), so using it needs no gain
      if (FTB) return FTB_X * Math.max(0, used - Math.max(0, w.freeTransfers - FTB_CAP));
      return PLAN.X * (stepSum(w.freeTransfers) - stepSum(w.freeTransfers - used));
    };
    const breaks = (sol, from) => {
      const g = moveGains(P, sol.weeks, depth, T);
      // a week with a hit is exempt: a hit rarely pays back in its own gameweek, it is taken for the weeks after
      for (let t = from; t < depth; t++) if (g[t] && !(sol.weeks[t].hits > 0) && g[t].now < weekCost(sol.weeks[t]) - 1e-6) return t;
      return -1;
    };
    const solveRule = async (extra) => {
      let x = { ...extra };
      let sol = await solveWith(x);
      for (let k = 0; sol && k < depth; k++) {
        const t = breaks(sol, 1);
        if (t < 0) break;
        planned++;
        x = { ...x, roll: [...(x.roll || []), t] };
        const again = await solveWith(x);
        if (!again) break;
        sol = again;
      }
      if (sol) sol.firstBreaks = breaks(sol, 0) === 0;
      return sol;
    };
    let dropped = 0;
    try {
      const options = [];
      for (const g of groups) {
        const cuts = [];
        // a plan left out by the rule makes room for the next best one (a few extra tries at most)
        for (let r = 0, shown = 0; shown < g.n && r < g.n + 3; r++) {
          if (r >= g.n) planned++;
          const extra = { cut: cuts.slice() };
          if (g.count !== null) extra.count = [{ t: 0, n: g.count }];
          const sol = await solveRule(extra);
          if (!sol) continue;
          const opt = S.option(sol.input, sol.values, 0);
          cuts.push(opt);
          if (options.some((o) => S.sameOption(o.opt, opt))) continue;
          if (sol.firstBreaks && g.count !== null && g.count > forcedN) { dropped++; continue; }
          options.push({ t: 0, opt, sol, count: g.count, rank: options.filter((o) => o.count === g.count).length + 1, roll: g.count !== null && g.count === forcedN });
          shown++;
        }
        // Saving now: more branches with different moves next gameweek, so one strong move there does not hide the
        // rest (3 with 1-2 free transfers, 2 with 3, none more with 4-5).
        const save = options.find((o) => o.roll && o.count === g.count && o.rank === 1);
        if (save && g.count === forcedN && depth > 1) {
          const nextCuts = [S.option(save.sol.input, save.sol.values, 1)];
          for (let r = 2; r <= saveBranches; r++) {
            const sol = await solveRule({ count: [{ t: 0, n: g.count }], cut: nextCuts.slice() });
            if (!sol) break;
            options.push({ t: 0, opt: S.option(sol.input, sol.values, 0), sol, count: g.count, rank: r, roll: true });
            nextCuts.push(S.option(sol.input, sol.values, 1));
          }
        }
      }
      if (!options.length) throw new Error(skipped ? 'The solver ran out of memory on this device. Try fewer gameweeks to plan.' : 'No plan fits these settings (check the players to keep and the chips).');
      const wt = (t) => Math.pow(PLAN.decay, t);
      options.forEach((o) => {
        o.pts = planPts(o.sol);
        o.dpts = o.sol.weeks.reduce((a, w, t) => a + wt(t) * w.xpts, 0);
        Object.assign(o, planExtras(o.sol.weeks, depth));
        o.total = o.dpts - o.cost + o.kept;
        o.totalRaw = o.pts - o.costRaw + o.keptRaw;
      });
      progress('Simulating 5,000 scenarios to compare the plans…');
      await new Promise((r) => setTimeout(r, 30));
      const res = simulateAll(P, gws, options.map((o) => o.sol));
      const N = res[0].total.length;
      // each run scored like the plans: weighed points, less the transfer cost, plus the free transfers kept
      const scored = res.map((r, k) => { const out = new Float32Array(N); r.week.forEach((arr, t) => { for (let s = 0; s < N; s++) out[s] += wt(t) * arr[s]; });
        for (let s = 0; s < N; s++) out[s] += options[k].kept - options[k].cost; return out; });
      const wins = options.map(() => 0);
      for (let s = 0; s < N; s++) {
        let best = -Infinity, win = [];
        scored.forEach((arr, k) => { const v = arr[s]; if (v > best + 1e-6) { best = v; win = [k]; } else if (Math.abs(v - best) <= 1e-6) win.push(k); });
        win.forEach((k) => { wins[k] += 1 / win.length / N; });
      }
      options.forEach((o, k) => { o.win = wins[k]; });
      const rec = options.reduce((b, o) => (o.total > b.total ? o : b), options[0]);
      const holdW = holdWeeks(P, T);
      options.forEach((o) => { o.gainDecay = o.dpts - holdW.reduce((a, x, t) => a + wt(t) * x, 0); });
      state.plan = { gws, P, options, chips, skipped, dropped, force: base.force, status: worst, hold: holdW.reduce((a, b) => a + b, 0), holdW, pick: options.indexOf(rec), rec, depth };
      state.week = 0;
      render();
    } catch (e) {
      showError(`Could not work out a plan: ${e.message}`);
      $('out').replaceChildren();
    } finally {
      solver.close();
      $('go').disabled = false;
    }
  }

  // Scenario inputs for every player in any of the plans.
  function simulateAll(P, gws, sols) {
    const used = new Set();
    sols.forEach((s) => s.weeks.forEach((w) => w.xi.concat(w.bench).forEach((i) => used.add(i))));
    const ids = [...used];
    const local = new Map(ids.map((i, k) => [i, k]));
    const byId = new Map(state.data.players.map((p) => [p.id, p]));
    // expected goals each team scores in each match: what the other side is expected to concede
    const lambda = new Map();
    state.data.players.forEach((p) => gws.forEach((g) => {
      const d = p.byGw[g];
      if (!d || !d.fx) return;
      d.fx.forEach((fx, j) => { const opp = String(d.opp[j]).toUpperCase(); const k = `${fx}|${opp}`; if (!lambda.has(k)) lambda.set(k, d.xConceded / d.fx.length); });
    }));
    const simPlayers = ids.map((i) => {
      const q = P[i], p = byId.get(q.id);
      return {
        position: q.position, xp: q.xp,
        weeks: gws.map((g) => {
          const d = p && p.byGw[g];
          if (!d || !d.fx) return [];
          const v = XMin.view(state.overrides, p, g);
          const n = d.fx.length;
          const per = (x) => (x || 0) / n;
          const perP = (x) => 1 - Math.pow(1 - Math.min(0.999, x || 0), 1 / n);
          const edited = v && v.edited && v.edited !== 'model';
          return d.fx.map((fx, j) => ({
            fx, team: p.team, opp: String(d.opp[j]).toUpperCase(), fixed: edited ? v.mins[j] : null,
            p1: perP(d.pApp1), p60: perP(d.pApp60), mins: d.mins[j] ?? d.xmin / n,
            g: per(d.xGoals), a: per(d.xAssists), saves: per(d.xSaves), bonus: per(d.bonus), dc: perP(d.pDefcon),
            ps: perP(d.pPenSave), pm: perP(d.pPenMiss), og: perP(d.pOwnGoal), y: perP(d.pYellow), r: perP(d.pRed),
          }));
        }),
      };
    });
    const remap = (w) => ({ ...w, xi: w.xi.map((i) => local.get(i)), bench: w.bench.map((i) => local.get(i)), cap: local.get(w.cap), vice: local.get(w.vice), bb: w.chip === 'bboost' });
    return S.simulate({ T: gws.length, players: simPlayers, lambda, paths: sols.map((s) => s.weeks.map(remap)), sims: 5000, seed: 7 });
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

  const pct = (x) => `${Math.round(x * 100)}%`;
  const optionText = (P, n) => {
    if (n.opt.z) return 'Free Hit squad';
    if (!n.opt.buys.length && !n.opt.sells.length) return 'Save the transfer';
    const forcedOnly = n.roll && n.t === 0;
    const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
    const byPos = (a, b) => order[P[a].position] - order[P[b].position] || P[a].name.localeCompare(P[b].name);
    // forced transfers first, paired as the viewer set them, then the rest by position
    const fo = n.t === 0 && state.plan.force ? state.plan.force : { buys: [], sells: [] };
    const outs = fo.sells.filter((i) => n.opt.sells.includes(i)).concat(n.opt.sells.filter((i) => !fo.sells.includes(i)).sort(byPos));
    const ins = fo.buys.filter((i) => n.opt.buys.includes(i)).concat(n.opt.buys.filter((i) => !fo.buys.includes(i)).sort(byPos));
    return outs.map((o, k) => `${P[o].name} → ${ins[k] !== undefined ? P[ins[k]].name : ''}`).join(', ') + (forcedOnly ? ' (forced only)' : '');
  };
  const planPts = (sol) => sol.weeks.reduce((a, w) => a + w.xpts, 0);

  // The options in one table: what each plan does in each of the 3 transfer gameweeks, its expected points (as they
  // are, and weighed 0.85 a week further ahead, which picks the best) and how often it scores the most.
  function optionsView(P, options, gws) {
    const depth = state.plan.depth;
    const bestRaw = Math.max(...options.map((o) => o.totalRaw ?? -Infinity)), bestT = Math.max(...options.map((o) => o.total)), bestWin = Math.max(...options.map((o) => o.win));
    const label = (o) => (o.count === null ? (state.plan.chips.wildcard || []).includes(0) ? 'Wildcard' : 'Free Hit'
      : o.roll ? (o.count ? 'Forced only' : 'Save') : o.count > state.team.ft ? `${state.team.ft} FT + ${o.count - state.team.ft} hit` : `${o.count} FT`);
    const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
    const byPos = (a, b) => order[P[a].position] - order[P[b].position] || P[b].price - P[a].price;
    const holdW = state.plan.holdW || [];
    const sign = (x) => `${x >= 0 ? '+' : '−'}${f1(Math.abs(x))}`;
    // under each gameweek's moves: money left, and that gameweek's expected points against keeping the squad
    if (state.decayView === undefined) { try { state.decayView = localStorage.getItem('planner-decay') !== '0'; } catch (e) { state.decayView = true; } }
    const decayOn = state.decayView;
    const T = gws.length;
    // under each gameweek's moves: money left, what the moves gain that gameweek and over the rest of the plan
    const facts = (w, g) => {
      const out = [];
      if (w.chip !== 'wildcard' && w.chip !== 'freehit') out.push(el('small', { className: 'itb ft-saved', textContent: `FT saved: ${ftLeft(w)}` }));
      if (w.bank !== null && w.bank !== undefined) out.push(el('small', { className: w.t > 0 && w.bank < BANK_BUFFER * (w.t + 1) - 1e-6 ? 'itb tight' : 'itb', textContent: `ITB ${f1(w.bank)}m` }));
      if (g) {
        out.push(el('small', { className: 'itb gw-gain', textContent: `${sign(g.now)} GW${gws[w.t]}` }));
        out.push(el('small', { className: 'itb gw-gain', textContent: decayOn ? `${sign(g.dec)} decay to GW${gws[T - 1]}` : `${sign(g.raw)} to GW${gws[T - 1]}` }));
      }
      return out;
    };
    const moves = (w, g) => {
      if (w.chip === 'freehit') return [el('span', { textContent: 'Free Hit' })].concat(facts(w, null));
      if (!w.ins.length) return [el('span', { className: 'muted', textContent: 'Save' })].concat(facts(w, null));
      const outs = w.outs.slice().sort(byPos), ins = w.ins.slice().sort(byPos);
      return outs.map((x, k) => el('span', { textContent: `${P[x].name} → ${ins[k] !== undefined ? P[ins[k]].name : ''}` }))
        .concat(w.hits ? [el('small', { className: 'hit', textContent: `−${w.hits * S.HIT}` })] : [])
        .concat(facts(w, g));
    };
    const rows = options.map((o, k) => {
      const tr = el('tr', { className: k === state.plan.pick ? 'on' : '', tabIndex: 0, onclick: () => { state.plan.pick = k; state.week = 0; render(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.plan.pick = k; state.week = 0; render(); } } },
        el('td', { className: 'opt-count' }, el('b', { textContent: label(o) }), o.rank > 1 ? el('small', { textContent: ` #${o.rank}` }) : '',
          o === state.plan.rec ? el('span', { className: 'rec-tag', textContent: 'Best' }) : ''),
        ...(() => {
          if (!o.gains) {
            o.gains = moveGains(P, o.sol.weeks, depth, T);
            // a Free Hit or Wildcard week has no single move to credit: its change against the week before counts here
            const chipGain = o.sol.weeks.slice(0, depth).reduce((a, w, t) => a + (w.chip === 'freehit' ? Math.pow(PLAN.decay, t) * (squadPts(P, w.xi.concat(w.bench), t) - squadPts(P, (t ? o.sol.weeks[t - 1].xi.concat(o.sol.weeks[t - 1].bench) : P.map((q, i) => i).filter((i) => P[i].owned)), t)) : 0), 0);
            o.gainDecay = o.gains.reduce((a, g) => a + (g ? g.dec : 0), 0) + chipGain;
            const chipRaw = o.sol.weeks.slice(0, depth).reduce((a, w, t) => a + (w.chip === 'freehit' ? squadPts(P, w.xi.concat(w.bench), t) - squadPts(P, (t ? o.sol.weeks[t - 1].xi.concat(o.sol.weeks[t - 1].bench) : P.map((q, i) => i).filter((i) => P[i].owned)), t) : 0), 0);
            o.gainRaw = o.gains.reduce((a, g) => a + (g ? g.raw : 0), 0) + chipRaw;
          }
          return o.sol.weeks.slice(0, depth).map((w, t) => el('td', { className: 'route-moves' }, ...moves(w, o.gains[t])));
        })(),
        el('td', { className: 'num', textContent: f1(decayOn ? o.dpts : o.pts) }),
        el('td', { className: 'num', textContent: sign((decayOn ? o.gainDecay : o.gainRaw) || 0) }),
        el('td', { className: 'num', textContent: `+${f2(decayOn ? o.kept : o.keptRaw)}` }),
        el('td', { className: `num${(decayOn ? o.total === bestT : o.totalRaw === bestRaw) ? ' best' : ''}`, textContent: f2(decayOn ? o.total : o.totalRaw) }),
        el('td', { className: `num${o.win === bestWin ? ' best' : ''}` }, pctFine(o.win)));
      tr.setAttribute('aria-selected', String(k === state.plan.pick));
      return tr;
    });
    const rec = state.plan.rec;
    const mostWins = options.reduce((b, o) => (o.win > b.win ? o : b), options[0]);
    const say = (o) => `${label(o)}${o.rank > 1 ? ` #${o.rank}` : ''}`;
    return el('section', { className: 'options' },
      el('div', { className: 'opt-head' }, el('h3', {}, `Plans from GW${gws[0]}: tap one to see it week by week`),
        el('label', { className: 'decay-toggle' }, el('input', { type: 'checkbox', checked: decayOn, onchange: (e) => { state.decayView = e.target.checked; try { localStorage.setItem('planner-decay', e.target.checked ? '1' : '0'); } catch (err) { /* ignore */ } render(); } }), ' Decay')),
      el('p', { className: 'opt-verdict rec' }, 'Best plan: ', el('b', { textContent: say(rec) }), (decayOn ? ` (score ${f2(rec.total)}: ${f1(rec.dpts)} xPts decay + ${f2(rec.kept)} FT bonus).`
          : ` (score ${f2(rec.totalRaw)}: ${f1(rec.pts)} xPts + ${f2(rec.keptRaw)} FT bonus; picked on the weighed score).`),
        mostWins === rec ? ' It is also the top scorer most often.' : el('span', {}, ' Top scorer most often: ', el('b', { textContent: say(mostWins) }), ` (${pctFine(mostWins.win)}).`)),
      el('div', { className: 'wrap' }, el('table', { className: 'opt-table route-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Uses now' }),
          ...gws.slice(0, depth).map((g) => el('th', { scope: 'col', textContent: `GW${g}` })),
          el('th', { scope: 'col', className: 'num', textContent: decayOn ? 'xPts Decay' : 'xPts' }), el('th', { scope: 'col', className: 'num', textContent: decayOn ? 'Gain Decay' : 'Gain' }),
          el('th', { scope: 'col', className: 'num', textContent: 'FT bonus' }),
          el('th', { scope: 'col', className: 'num', textContent: 'Score' }), el('th', { scope: 'col', className: 'num', textContent: 'Best' }))),
        el('tbody', {}, ...rows))),
      el('p', { className: 'meta', textContent: `Each plan uses that many free transfers in GW${gws[0]}, then makes its own best moves for the next ${Math.max(0, depth - 1)} gameweek${depth - 1 === 1 ? '' : 's'}; after that the squad stays. Decay switch (on by default): every figure (xPts, Gain, FT bonus, Score) with each later gameweek counting ${PLAN.decay} times the one before; off: plain sums. The Best plan is always picked on the weighed Score. xPts (Decay): expected points over GW${gws[0]}-${gws[gws.length - 1]}, auto-subs and hits included. Gain (Decay): the plan's expected points against keeping your squad as it is; it is the sum of the figures under each gameweek's moves. Under each gameweek's moves: FT saved, the free transfers left after that gameweek's transfers; ITB, the money left after them; what those moves gain that gameweek (hits taken off); and what they gain from that gameweek to the end of the plan against the squad before them (weighed 0.85 a week from the first gameweek when Decay is on). FT bonus: in every transfer gameweek each free transfer saved is worth ${FTB_X} (${FTB_CAP} at most, so ${FTB_X * FTB_CAP} points), and those saved after GW${gws[depth - 1]} earn it again in every gameweek to GW${gws[gws.length - 1]} (not the free transfers gained in those weeks, which are the same for every plan). Score: xPts + FT bonus; the plan with the most is marked Best. Rule for every gameweek without a hit: its moves must gain at least ${FTB_X} for each free transfer they use, in that same gameweek, except the 5th free transfer with 5 in hand, which cannot be saved anyway (a week with a hit is exempt, since a hit pays back over the weeks after); a later gameweek that does not is planned with no transfers, and a plan whose GW${gws[0]} moves do not is left out and the next best takes its place. Save #2, #3: saving now as well, with different moves in the next gameweek. How many plans of each kind: Settings. A buy n gameweeks ahead must leave 0.1m × n in the bank, in case prices move; its ITB shows in orange when it leaves no more than that. Best (last column): share of 5,000 simulated runs in which the plan has the highest score.` }));
  }

  const pctFine = (x) => (x < 0.1 ? `${(Math.round(x * 1000) / 10).toFixed(1)}%` : pct(x));

  function render() {
    const { gws, hold, P } = state.plan;
    const options = state.plan.options;
    const pick = options[Math.min(state.plan.pick, options.length - 1)];
    const weeks = pick.sol.weeks;
    state.plan.weeks = weeks;
    const total = pick.pts;
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
      el('p', {}, 'This plan: ', el('b', { textContent: `${f1(total)} xPts` }), ` over GW${gws[0]}-${gws[gws.length - 1]}, auto-subs included: `,
        el('b', { textContent: `${gain >= 0 ? '+' : ''}${f1(gain)}` }), ` on keeping your squad without chips (${f1(hold)}). ${moves} transfer${moves === 1 ? '' : 's'}, ${hits ? `${hits} hit${hits > 1 ? 's' : ''}` : 'no hits'}.`),
      el('p', { className: 'meta', textContent: 'The last column is the share of 5,000 simulated runs of every match in which that plan has the highest score of all the plans in the table (they add up to 100%). A plan can have the best expected score and still come top less often, when its points come from rarer big hauls.' }),
      tightNote(P, weeks, gws),
      state.team.madeAlready && state.team.madeAlready.length ? el('p', { className: 'meta', textContent: `Already made for GW${state.team.lastGw + 1}: ${state.team.madeAlready.join(', ')} (counted in your squad and free transfers).` }) : '',
      Object.keys(state.overrides).length ? el('p', { className: 'meta', textContent: `Uses your minutes edits from the Minutes page (${Object.keys(state.overrides).length} players).` }) : '',
      state.plan.dropped ? el('p', { className: 'meta', textContent: `${state.plan.dropped} plan${state.plan.dropped > 1 ? 's were' : ' was'} left out: ${state.plan.dropped > 1 ? 'their' : 'its'} GW${gws[0]} moves gain less that gameweek than the free transfers they use cost.` }) : '',
      state.plan.skipped ? el('p', { className: 'meta', textContent: `${state.plan.skipped} of the plans could not be worked out (the solver ran out of memory on this device) and are left out.` }) : '',
      /optimal/i.test(state.plan.status) ? '' : el('p', { className: 'meta', textContent: `Some searches stopped at their time limit (${state.plan.status}); the plans are good but may not be the very best.` }));
    $('out').replaceChildren(optionsView(P, options, gws), fhView(P, pick, gws), summary, tabs, weekView(weeks[Math.min(state.week, weeks.length - 1)]));
  }

  // Later-week transfers that leave little money: they fail if prices move by more than what is left.
  function tightNote(P, weeks, gws) {
    const tight = weeks.filter((w) => w.t > 0 && w.ins.length && w.chip !== 'freehit' && w.bank !== null && w.bank < BANK_BUFFER * (w.t + 1) - 1e-6);
    if (!tight.length) return '';
    return el('p', { className: 'meta warn-note', textContent: 'Tight money: ' + tight.map((w) => `GW${gws[w.t]} (${w.ins.map((i) => P[i].name).join(', ')}) leaves ${f1(w.bank)}m, so it no longer fits if ${w.ins.length > 1 ? 'their prices' : 'the price'} rise${w.ins.length > 1 ? '' : 's'} (or the players sold drop) by more than that before then`).join('; ') + '. Prices are taken as they are now.' });
  }

  // ---- Free Hit week ----
  // For the plan picked: in each gameweek, the best squad for that week alone (within the plan's squad selling value
  // and bank that week, at most 3 per club) against the plan's own squad that week. The best gain is the week to use it.
  function fhView(P, pick, gws) {
    const box = el('section', { className: 'options fh-box' });
    const fh = (state.team.chipsAvailable || []).find((c) => c.name === 'freehit');
    const fill = () => {
      const res = pick.fh;
      box.replaceChildren(el('h3', {}, 'Free Hit: best week for this plan'));
      if (!res) {
        box.append(el('p', { className: 'meta', textContent: fh ? `Free Hit available GW${fh.from}-${fh.to}.` : 'No Free Hit left this season (or none in these gameweeks); the gains are shown anyway.' }),
          el('button', { type: 'button', className: 'update', onclick: () => run() }, 'Find the best Free Hit week'));
        return;
      }
      if (res.working) { box.append(el('p', { className: 'working', textContent: res.working })); return; }
      if (res.error) { box.append(el('p', { className: 'error', textContent: res.error })); return; }
      const ok = (g) => !fh || (g >= fh.from && g <= fh.to);
      const best = res.rows.filter((r) => ok(r.gw)).reduce((b, r) => (!b || r.gain > b.gain ? r : b), null);
      box.append(
        best ? el('p', { className: 'opt-verdict rec' }, 'Best week: ', el('b', { textContent: `GW${best.gw}` }), ` (+${f1(best.gain)} xPts on this plan's squad that week).`) : '',
        el('div', { className: 'wrap' }, el('table', { className: 'opt-table' },
          el('thead', {}, el('tr', {}, ...['GW', 'Plan squad', 'Free Hit squad', 'Gain', 'Free Hit starting 11'].map((h, k) => el('th', { scope: 'col', className: k && k < 4 ? 'num' : '', textContent: h })))),
          el('tbody', {}, ...res.rows.map((r) => el('tr', { className: best && r.gw === best.gw ? 'on' : '' },
            el('td', { textContent: `GW${r.gw}${ok(r.gw) ? '' : ' (not available)'}` }),
            el('td', { className: 'num', textContent: f1(r.plan) }), el('td', { className: 'num', textContent: f1(r.fh) }),
            el('td', { className: 'num' + (best && r.gw === best.gw ? ' best' : ''), textContent: `${r.gain >= 0 ? '+' : ''}${f1(r.gain)}` }),
            el('td', { className: 'route-moves', textContent: r.xi.join(', ') })))))),
        el('p', { className: 'meta', textContent: "Plan squad: this plan's expected points that week (hits not counted). Free Hit squad: the best 15 for that week alone, within the plan's squad selling value and bank that week, at most 3 per club, auto-subs included. Using the Free Hit puts that week's planned transfers off; this is not counted." }));
    };
    const run = async () => {
      pick.fh = { working: 'Working out the best Free Hit squad for each gameweek…' };
      fill();
      const weeks = pick.sol.weeks;
      const solver = openSolver();
      const rows = [];
      try {
        let bank = state.team.bank;
        for (let t = 0; t < weeks.length; t++) {
          const w = weeks[t];
          if (w.bank !== null && w.bank !== undefined) bank = w.bank;
          const squad = new Set(w.chip === 'freehit' ? (t ? weeks[t - 1].xi.concat(weeks[t - 1].bench) : P.map((p, i) => i).filter((i) => P[i].owned)) : w.xi.concat(w.bench));
          const Pt = P.map((p, i) => ({ ...p, owned: squad.has(i), sell: p.owned ? p.sell : p.price, xp: [p.xp[t]], p1: [p.p1[t]], opp: p.opp ? [p.opp[t]] : p.opp }));
          const input = { players: Pt, T: 1, ft: 1, bank, chips: { freehit: [0] },
            settings: { ...S.DEFAULTS, depth: 1, decay: 1, reserve: [0, 0, 0, 0, 0], minGain: 0, bankValue: 0, maxHits: 0 } };
          const model = S.build(input);
          pick.fh = { working: `Working out the best Free Hit squad: GW${gws[t]} (${t + 1} of ${weeks.length})…` };
          fill();
          const sol = await solver.solve(S.toLP(model));
          const fw = S.decode(input, model, sol.values)[0];
          const planPts = w.xpts + (w.hits || 0) * S.HIT;
          rows.push({ gw: gws[t], plan: planPts, fh: fw.xpts, gain: fw.xpts - planPts, xi: fw.xi.map((i) => P[i].name) });
        }
        pick.fh = { rows };
      } catch (e) {
        pick.fh = { error: `Could not work out the Free Hit weeks: ${e.message}` };
      } finally {
        solver.close();
      }
      if (state.plan && state.plan.options.includes(pick)) fill();
    };
    fill();
    return box;
  }

  function showError(text) { $('error').textContent = text; $('error').hidden = false; }

  // ---- loading ----
  // The team straight from FPL through the site's proxy (tools/cloudflare-worker.js); same rules as planner.py.
  async function teamFromFpl(entry) {
    const get = async (path) => {
      const r = await fetch(`${PROXY}/api/${path}`);
      if (r.status === 404) { const e = new Error(`There is no FPL team with ID ${entry}.`); e.final = true; throw e; }
      if (!r.ok) throw new Error(`FPL answered ${r.status}`);
      return r.json();
    };
    const [boot, history, info, transfers] = await Promise.all([get('bootstrap-static/'), get(`entry/${entry}/history/`), get(`entry/${entry}/`), get(`entry/${entry}/transfers/`)]);
    const played = history.current || [];
    if (!played.length) { const e = new Error(`Team ${entry} has not played a gameweek yet.`); e.final = true; throw e; }
    const elements = new Map(boot.elements.map((e) => [e.id, e]));
    const teams = new Map(boot.teams.map((t) => [t.id, t.short_name]));
    const last = played[played.length - 1].event;
    const used = (history.chips || []).map((c) => ({ name: c.name, event: c.event }));
    const chipAt = new Map(used.map((c) => [c.event, c.name]));
    const picks = await get(`entry/${entry}/event/${chipAt.get(last) === 'freehit' && last > 1 ? last - 1 : last}/picks/`);
    const squad = picks.picks.map((p) => p.element);
    // free transfers: 1 after GW1, +1 a gameweek up to 5, less the transfers made; a wildcard or free hit adds none
    let ft = 1;
    played.forEach((e) => {
      if (e.event === 1 || ['wildcard', 'freehit'].includes(chipAt.get(e.event))) return;
      ft = Math.min(S.MAX_FT, Math.max(ft - e.event_transfers, 0) + 1);
    });
    let bank = played[played.length - 1].bank / 10;
    // selling price: half the rise since he was bought (rounded down to 0.1), the full fall
    const sorted = transfers.slice().sort((a, b) => (a.time < b.time ? -1 : 1));
    const bought = new Map();
    sorted.forEach((t) => bought.set(t.element_in, t.element_in_cost));
    const selling = new Map(squad.map((e) => {
      const now = elements.get(e).now_cost, paid = bought.has(e) ? bought.get(e) : now - (elements.get(e).cost_change_start || 0);
      return [e, (now > paid ? paid + Math.floor((now - paid) / 2) : now) / 10];
    }));
    // transfers already made for the coming gameweek
    const made = [];
    sorted.filter((t) => t.event > last).forEach((t) => {
      const k = squad.indexOf(t.element_out);
      if (k < 0) return;
      squad[k] = t.element_in;
      selling.delete(t.element_out);
      selling.set(t.element_in, t.element_in_cost / 10);
      bank += (t.element_out_cost - t.element_in_cost) / 10;
      made.push(`${elements.get(t.element_out).web_name} -> ${elements.get(t.element_in).web_name}`);
    });
    ft = Math.max(ft - made.length, 0);
    // chips not yet played in their window (from 2025-26 each chip comes once per half of the season)
    const defs = boot.chips && boot.chips.length ? boot.chips.filter((c) => CHIP_LABEL[c.name]) : Object.keys(CHIP_LABEL).map((name) => ({ name, start_event: 1, stop_event: 38 }));
    const chipsAvailable = defs.map((c) => ({ name: c.name, label: CHIP_LABEL[c.name], from: Math.max(c.start_event || 1, last + 1), to: c.stop_event || 38, start: c.start_event || 1 }))
      .filter((c) => c.to >= last + 1 && !used.some((u) => u.name === c.name && u.event >= c.start && u.event <= c.to));
    const POSN = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
    return {
      entry: Number(entry), name: info.name || '', manager: `${info.player_first_name || ''} ${info.player_last_name || ''}`.trim(),
      lastGw: last, bank: Math.round(bank * 10) / 10, ft, madeAlready: made, live: true,
      squad: squad.map((e) => { const el2 = elements.get(e); return { id: `c${el2.code}`, name: el2.web_name, team: teams.get(el2.team), position: POSN[el2.element_type], price: el2.now_cost / 10, sell: selling.get(e) }; }),
      chipsUsed: used, chipsAvailable, updatedAt: new Date().toISOString(),
    };
  }

  async function teamFromSite(entry) {
    const r = await fetch(`plans/${entry}.json`, { cache: 'no-store' });
    if (r.status === 404) throw new Error(`Could not read team ${entry} from FPL right now, and the site has no saved copy of it. Try again in a minute.`);
    if (!r.ok) throw new Error('Could not load the team. Reload the page to try again.');
    return r.json();
  }

  async function loadTeam(entry) {
    $('error').hidden = true;
    $('status').textContent = `Loading team ${entry}`;
    let team = null;
    if (PROXY) {
      try { team = await teamFromFpl(entry); } catch (e) { if (e.final) throw e; team = null; }
    }
    if (!team) team = await teamFromSite(entry);
    if (!Array.isArray(team.squad) || !team.squad[0] || typeof team.squad[0] !== 'object') throw new Error('The team data is from an older version of the site. It is refreshed at the next update.');
    state.team = team;
    state.entry = entry;
    try { localStorage.setItem(KEY, entry); } catch (e) { /* fine */ }
    const when = team.updatedAt ? new Date(team.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';
    $('status').textContent = `${team.name}${team.manager ? ' · ' + team.manager : ''} · bank £${team.bank.toFixed(1)}, ${team.ft} free transfer${team.ft === 1 ? '' : 's'}${team.live ? ' · read from FPL just now' : when ? ' · read ' + when : ''}`;
    chipChoices();
  }

  async function go() {
    const entry = $('entry').value.trim();
    if (!/^\d+$/.test(entry) || !state.data) return;
    try {
      await loadTeam(entry);  // read the team again each time, so the plan starts from FPL's latest data
      // a name typed in a Keep, Avoid or Force box counts even if Add was not pressed
      ['keep', 'avoid', 'forceIn', 'forceOut'].forEach((kind) => addPick(kind));
      if (!$('error').hidden) return;
      await makePlan();
    } catch (e) {
      showError(e.message);
      $('status').textContent = 'Enter an FPL team ID';
      $('out').replaceChildren();
    }
  }

  $('pick').addEventListener('submit', (e) => { e.preventDefault(); go(); });
  $('horizon').addEventListener('change', () => { chipChoices(); readSettings(); settingsForm(); });
  ['keep', 'avoid', 'forceIn', 'forceOut'].forEach((kind) => {
    $(`${kind}Add`).addEventListener('click', () => addPick(kind));
    $(`${kind}Pick`).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPick(kind); } });
    // picking a name from the list adds it straight away, no need to press Add
    $(`${kind}Pick`).addEventListener('change', () => addPick(kind, true));
  });
  $('resetSettings').addEventListener('click', () => { state.settings = { ...S.DEFAULTS, keep: [], avoid: [], forceIn: [], forceOut: [], forceGw: state.data.gws[0] }; saveSettings(); settingsForm(); $('pcWarn').hidden = true; });
  state.settings = loadSettings();
  $('entry').addEventListener('change', () => { if ($('entry').value.trim() !== state.entry) { state.team = null; state.entry = null; chipChoices(); } });
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') state.overrides = XMin.load(); });

  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch (e) { saved = ''; }
  $('entry').value = new URLSearchParams(location.search).get('id') || saved || '';
  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      state.data = data;
      XMin.setPlayers(data.players);
      state.settings = loadSettings();
      $('playerNames').replaceChildren(...data.players.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => el('option', { value: `${p.name} (${p.team} ${p.position})` })));
      settingsForm();
      // read the team so its chips show, but only plan when asked: a plan takes a while
      const entry = $('entry').value.trim();
      $('out').replaceChildren(el('p', { className: 'working', textContent: entry ? 'Choose the gameweeks, chips and settings, then press Make plan.' : 'Enter your FPL team ID to start. Not sure what it is? Open "Where do I find my ID?" above.' }));
      if (!entry) { const h = document.querySelector('.id-help'); if (h) h.open = true; }
      if (/^\d+$/.test(entry)) loadTeam(entry).catch((e) => { showError(e.message); $('status').textContent = 'Enter an FPL team ID'; });
    })
    .catch(() => showError('Could not load the xPoints data. Reload the page to try again.'));
})();
