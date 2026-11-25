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

  // Bench weights are fixed (planner-solve.js BENCH_SLOTS, from real bench use of top managers)
  function benchWeights() { return { out: [], gk: [] }; }

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
  function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(state.settings)); } catch (e) { /* fine */ } settingsCount(); }

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
        const name = k === 0 ? 'Save' : k <= ft ? `${k} FT` : `${ft} FT + ${k - ft} hit${k - ft > 1 ? 's' : ''}`;
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

  // "Settings (2 settings)": how many are set away from the defaults, shown on the closed Settings box
  function settingsCount() {
    const st = state.settings;
    if (!st) return;
    let n = ['keep', 'avoid', 'forceIn', 'forceOut'].reduce((a, k) => a + (st[k] || []).length, 0);
    n += [1, 2, 3, 4, 5].filter((ft) => countsFor(ft).join() !== (DEFAULT_COUNTS[ft] || []).join()).length;
    const sum = document.querySelector('.plan-settings > summary');
    if (sum) sum.textContent = n ? `Settings (${n} setting${n > 1 ? 's' : ''})` : 'Settings';
  }

  function settingsForm() {
    settingsCount();
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
  const PARALLEL_MAX = 3;  // solves at once at most (each HiGHS worker needs its own memory; phones have little)
  function openSolver() {
    const running = new Set();  // several solves can run at once, each in its own worker
    const once = (lp, options) => new Promise((resolve, reject) => {
      const w = new Worker(`planner-worker.js?v=${state.data.updatedAt}`);
      running.add(w);
      const done = (fn, arg) => { clearTimeout(timer); w.terminate(); running.delete(w); fn(arg); };
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
      close: () => { running.forEach((w) => w.terminate()); running.clear(); },
    };
  }

  // How plans are judged (fixed for now). Transfers are planned for PLAN.depth (5) gameweeks, each later gameweek weighed 0.85
  // times the one before. A free transfer used costs X (weighed like its gameweek), scaled by how many free transfers
  // are left in hand after it: 100% when it is the last one, then 75%, 50%, 25%, 0% (with 5 in hand one would be lost
  // anyway). So a move is only made early when it gains more than that. Free transfers left after the last transfer
  // week are worth Y each, the 1st 100%, then 75%, 50%, 25%, 0%; Y is 4 points weighed like that gameweek.
  // Prices can change before a later week's transfers, so a buy in the n-th gameweek from now leaves 0.1m x n in the bank.
  const BANK_BUFFER = 0.1;
  const PLAN = { depth: 5, decay: 0.85, X: 0.5, ftPts: 4, steps: [1, 0.75, 0.5, 0.25, 0] };
  const stepSum = (k) => PLAN.steps.slice(0, Math.max(0, k)).reduce((a, b) => a + b, 0);
  // FT bonus: every transfer week, each free transfer left after that week's transfers is worth 0.5 (4 at most, so 2
  // points), weighed like its gameweek; those left after the last transfer week earn it in every gameweek to the end.
  // A week's moves must still gain 0.5 per free transfer they use.
  const FTB = true; // the FT bonus way of judging plans (the older transfer cost and end value are kept below for reference)
  const FTB_X = 0.5, FTB_CAP = 4;
  // The weight of each transfer week's bonus. The free transfers left after the last transfer week also earn it in every
  // gameweek after (no transfers then); the free transfers gained in those weeks are the same for every plan, so they
  // are left out.
  // The last transfer week's free transfers (week 5 at most) count in it and in the 3 gameweeks after it, Normal or
  // Decay, never past GW38.
  const ftbAfter = (depth) => { const g = (horizonGws()[depth - 1]) || 0; return Math.max(0, Math.min(3, 38 - g)); };
  const ftbWeights = (depth, T, d = PLAN.decay) => [...Array(depth).keys()].map((t) => FTB_X * (t < depth - 1 ? Math.pow(d, t)
    : [...Array(1 + ftbAfter(depth)).keys()].reduce((a, j) => a + Math.pow(d, t + j), 0)));
  // What the plans are optimised for, chosen before Auto plan: Decay (each later gameweek 0.85 times the one before)
  // or Normal (every gameweek the same). The switch over the results still shows either kind of figure.
  state.optMode = (() => { try { return localStorage.getItem('planner-opt-v3') === 'normal' ? 'normal' : 'decay'; } catch (e) { return 'decay'; } })();  // Decay unless chosen
  const optDecay = () => (state.optMode === 'normal' ? 1 : PLAN.decay);
  const ftLeft = (w) => (w.chip === 'wildcard' || w.chip === 'freehit' ? w.freeTransfers : Math.max(w.freeTransfers - Math.min(w.ins.length, w.freeTransfers), 0));

  // the transfer cost and the value of free transfers kept, for a plan's weeks
  function planExtras(weeks, depth) {
    if (FTB) {
      let kept = 0, keptRaw = 0;
      const wts = ftbWeights(depth, weeks.length);
      weeks.slice(0, depth).forEach((w, t) => {
        const n = Math.min(ftLeft(w), FTB_CAP), weeksCounted = t < depth - 1 ? 1 : 1 + ftbAfter(depth);
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
  const DEFAULT_COUNTS = { 1: [3, 3, 2, 1], 2: [2, 2, 2, 1, 1], 3: [2, 2, 2, 2, 1], 4: [1, 2, 2, 2, 1], 5: [1, 2, 2, 2, 1, 1] };
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

  async function makePlan(manual) {
    const { chips, clash } = chosenChips();
    if (clash) { showError(clash); return; }
    readSettings();
    $('error').hidden = true;
    const gws = horizonGws();
    const T = gws.length;
    const all = players(gws);
    const st = state.settings;
    const manualIds = manual ? Object.values(manual).flat().flatMap((m) => [m.out, m.in]) : [];
    const P = S.pool(all, state.team.squad.map((s) => s.id).concat(st.keep, st.avoid, st.forceIn, st.forceOut, manualIds));
    const index = new Map(P.map((p, i) => [p.id, i]));
    // After the transfer weeks the squad stays, so those gameweeks are searched as one (their points summed, each
    // weighed as usual) to keep the search small; their starting 11, captain and bench are picked afterwards.
    const depth = Math.min(PLAN.depth, T); // transfers in the first 5 gameweeks, then the squad stays (own plan too)
    const merge = T > depth + 1 && !Object.values(chips).some((arr) => (arr || []).some((t) => t >= depth));
    const Tm = merge ? depth + 1 : T;
    const OD = optDecay();
    const Pm = merge ? P.map((p) => ({ ...p, xp: p.xp.slice(0, depth).concat([p.xp.slice(depth).reduce((a, x, j) => a + Math.pow(OD, j) * x, 0)]),
      p1: p.p1.slice(0, depth + 1) })) : P;
    const Y = PLAN.ftPts * Math.pow(PLAN.decay, depth - 1);
    const base = { players: Pm, T: Tm, ft: state.team.ft, bank: state.team.bank, chips,
      settings: { ...S.DEFAULTS, depth, decay: OD, reserve: FTB ? [0, 0, 0, 0, 0] : PLAN.steps.map((m) => m * Y), minGain: 0, bankValue: 0, maxHits: null },
      ftMult: 1 / Math.pow(OD, depth),
      bankBuffer: BANK_BUFFER,
      useCost: FTB ? null : { x: [...Array(depth).keys()].map((t) => PLAN.X * Math.pow(PLAN.decay, t)), steps: PLAN.steps },
      ftBonus: FTB ? { x: ftbWeights(depth, T, OD), cap: FTB_CAP } : null,
      keep: st.keep.filter((id) => index.has(id)).map((id) => index.get(id)), avoid: st.avoid.filter((id) => index.has(id)).map((id) => index.get(id)) };
    const ownedIds = new Set(state.team.squad.map((x) => x.id));
    const fIn = st.forceIn.filter((id) => index.has(id) && !ownedIds.has(id)), fOut = st.forceOut.filter((id) => index.has(id) && ownedIds.has(id));
    const forcedN = Math.max(fIn.length, fOut.length);
    if (forcedN && !manual) base.force = { buys: fIn.map((id) => index.get(id)), sells: fOut.map((id) => index.get(id)) };
    if (manual) {
      // a manual plan: exactly the moves chosen, each in its gameweek, and no others
      base.forceWeeks = {};
      Object.entries(manual).forEach(([t, ms]) => { if (Number(t) < depth && ms.length) base.forceWeeks[t] = { buys: ms.map((m) => index.get(m.in)), sells: ms.map((m) => index.get(m.out)) }; });
      base.roll = [...Array(depth).keys()];
      delete base.keep; delete base.avoid;
    }
    const bw = benchWeights(P, T);
    base.benchW = bw.out.slice(0, Tm);
    base.benchWgk = bw.gk.slice(0, Tm);
    // The options this gameweek: the best plan for each number of transfers used now (saving them, 1, 2, ... up to
    // all free transfers); each plan then makes its own best moves for the next PLAN.depth - 1 gameweeks.
    const week0Chip = (chips.wildcard || []).includes(0) || (chips.freehit || []).includes(0);
    const groups = [];
    if (week0Chip) groups.push({ count: null, n: 3 });
    else planCounts(state.team.ft, forcedN).forEach(([k, n]) => groups.push({ count: k, n }));
    const saveBranches = depth > 1 && !week0Chip && !forcedN ? Math.max(1, countsFor(state.team.ft)[0]) : 1;
    let planned = manual ? 1 : groups.reduce((a, g) => a + g.n, 0) + saveBranches - 1;
    const nPlans = planned; // the plans asked for; planned also grows when a plan is worked out again for the 0.5 rule
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
      progress(`Working out ${nPlans} plans: step ${done} of ${planned}${planned > nPlans ? ' (some plans worked out again to keep the 0.5-a-transfer rule)' : ''}…`);
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
      if (manual) {
        const sol = await solveWith({});
        if (!sol) throw new Error('These moves do not fit: check the money in the bank, at most 3 players per club, and that each player in is the same position as the one out.');
        options.push({ t: 0, opt: S.option(sol.input, sol.values, 0), sol, count: (manual[0] || []).length, rank: 1, roll: false, manual: true });
      }
      // Each kind of plan (save, 1 FT, 2 FT, a hit, ...) is worked out on its own, several at once on devices with
      // more cores (each solve in its own worker); within a kind the plans follow one another (each rules out the last).
      const runGroup = async (g) => {
        const local = [];
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
          if (local.some((o) => S.sameOption(o.opt, opt))) continue;
          if (sol.firstBreaks && g.count !== null && g.count > forcedN) { dropped++; continue; }
          local.push({ t: 0, opt, sol, count: g.count, roll: g.count !== null && g.count === forcedN });
          shown++;
        }
        // Saving now: more branches with different moves next gameweek, so one strong move there does not hide the
        // rest (3 with 1-2 free transfers, 2 with 3, none more with 4-5).
        const save = local.find((o) => o.roll && o.count === g.count);
        if (save && g.count === forcedN && depth > 1) {
          const nextCuts = [S.option(save.sol.input, save.sol.values, 1)];
          for (let r = 2; r <= saveBranches; r++) {
            const sol = await solveRule({ count: [{ t: 0, n: g.count }], cut: nextCuts.slice() });
            if (!sol) break;
            local.push({ t: 0, opt: S.option(sol.input, sol.values, 0), sol, count: g.count, roll: true, branch: true });
            nextCuts.push(S.option(sol.input, sol.values, 1));
          }
        }
        return local;
      };
      const todo = manual ? [] : groups.slice();
      const found = new Array(todo.length);
      const lanes = Math.max(1, Math.min(PARALLEL_MAX, navigator.hardwareConcurrency || 2));
      let next = 0;
      await Promise.all([...Array(Math.min(lanes, todo.length)).keys()].map(async () => {
        while (next < todo.length) { const k = next++; found[k] = await runGroup(todo[k]); }
      }));
      found.forEach((list) => list.forEach((o) => {
        // the saving branches share their first gameweek by design (they differ the week after)
        if (!o.branch && options.some((x) => S.sameOption(x.opt, o.opt))) return;
        const { branch, ...rest } = o;
        options.push({ ...rest, rank: options.filter((x) => x.count === o.count).length + 1 });
      }));
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
      // the runs are scored the way the plans were optimised (Decay or Normal)
      const normal = state.optMode === 'normal';
      const owt = (t) => Math.pow(OD, t);
      const scored = res.map((r, k) => { const out = new Float32Array(N); r.week.forEach((arr, t) => { for (let s = 0; s < N; s++) out[s] += owt(t) * arr[s]; });
        const extra = normal ? options[k].keptRaw - options[k].costRaw : options[k].kept - options[k].cost;
        for (let s = 0; s < N; s++) out[s] += extra; return out; });
      const wins = options.map(() => 0);
      for (let s = 0; s < N; s++) {
        let best = -Infinity, win = [];
        scored.forEach((arr, k) => { const v = arr[s]; if (v > best + 1e-6) { best = v; win = [k]; } else if (Math.abs(v - best) <= 1e-6) win.push(k); });
        win.forEach((k) => { wins[k] += 1 / win.length / N; });
      }
      options.forEach((o, k) => { o.win = wins[k]; });
      const score = (o) => (normal ? o.totalRaw : o.total);
      const rec = options.reduce((b, o) => (score(o) > score(b) ? o : b), options[0]);
      const holdW = holdWeeks(P, T);
      options.forEach((o) => { o.gainDecay = o.dpts - holdW.reduce((a, x, t) => a + wt(t) * x, 0); });
      state.plan = { gws, P, options, chips, skipped, dropped, force: base.force, status: worst, hold: holdW.reduce((a, b) => a + b, 0), holdW, pick: options.indexOf(rec), rec, depth, mode: state.optMode, manual: !!manual };
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
  // Weekly figures on the pitch, shown as set in Show & optimise: Decay (week t × 0.85^t) or Normal
  const weekF = (t, mode) => (mode === 'normal' ? 1 : Math.pow(PLAN.decay, t));
  // A gameweek's total: normal points and decay points (week t × 0.85^t) side by side
  const weekPts = (x, t) => el('div', { className: 'week-pts' }, el('b', { textContent: f1(x) }), el('span', { textContent: ' xPts' }),
    el('span', { className: 'week-dec' }, ' · ', el('b', { textContent: f1(x * weekF(t, 'decay')) }), ' Decay'));
  function card(P, i, t, w, isNew) {
    const p = P[i];
    const pts = p.xp[t] * (i === w.cap ? w.mult : 1) * weekF(t, state.plan.mode);
    const badges = [];
    if (i === w.cap) badges.push(el('span', { className: 'pp-badge cap', textContent: w.mult === 3 ? 'TC' : 'C', title: w.mult === 3 ? 'Triple captain' : 'Captain' }));
    else if (i === w.vice) badges.push(el('span', { className: 'pp-badge vice', textContent: 'V', title: 'Vice-captain' }));
    if (isNew) badges.push(el('span', { className: 'pp-badge new', textContent: 'IN', title: 'Bought this gameweek' }));
    const c = el('div', { className: 'pp-card', tabIndex: 0, role: 'button', title: `${p.name}, ${p.team} ${p.position} £${p.price.toFixed(1)}: ${f1(p.xp[t])} xPts${i === w.cap ? ` × ${w.mult}` : ''}, plays ${Math.round(p.p1[t] * 100)}%. Tap for the details` },
      el('div', { className: 'pp-badges' }, ...badges), shirt(p.team, p.position === 'GK'),
      el('span', { className: 'pp-name', textContent: p.name }),
      el('span', { className: 'pp-pts', textContent: f1(pts) }),
      el('span', { className: 'pp-opp', textContent: fixture(p.opp[t]) }));
    // tap or Enter: the same figures as on the xPoints page for this gameweek
    const open = () => showDetail(p.id, state.plan.gws[t]);
    c.addEventListener('click', open);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return c;
  }
  // How later gameweeks count: as chosen before planning (Normal: all the same; Decay: 0.85 times the one before).
  const modeDecay = (mode) => ((mode || state.optMode) === 'normal' ? 1 : PLAN.decay);
  const xpOf = (p, g) => { const v = XMin.view(state.overrides, p, String(g)); return v ? v.xpts : 0; };
  // A tapped player: Replace / Remove first, then his row from the xPoints table (every gameweek planned, with the
  // opponents), the total as the plans count it, and the breakdown of the gameweek on show.
  function playerPopup(p, gws, t, acts, mode) {
    const d = modeDecay(mode);
    const cells = gws.map((g) => { const v = XMin.view(state.overrides, p, String(g)); return { g, xp: v ? v.xpts : 0, opp: v ? v.opp.join(', ') : 'Blank' }; });
    const total = cells.reduce((a, c, k) => a + Math.pow(d, k) * c.xp, 0);
    let shown = t;
    const pick = (k) => {  // tap a gameweek to see its figures; the plan's gameweek stays marked
      shown = k;
      $('detail-row').querySelectorAll('[data-k]').forEach((x) => x.classList.toggle('pick', Number(x.dataset.k) === k));
      $('detail-gw').textContent = `GW${gws[k]} in detail`;
      $('detail-text').textContent = XMin.detailText(state.overrides, p, String(gws[k]));
    };
    const cell = (tag, k, kids) => { const x = el(tag, { className: `${k === t ? 'now' : ''}${k === shown ? ' pick' : ''}`, title: `GW${gws[k]}: tap for the details` }, ...kids); x.dataset.k = k; x.addEventListener('click', () => pick(k)); return x; };
    const row = el('div', { className: 'xp-row-wrap' }, el('table', { className: 'xp-row' },
      el('thead', {}, el('tr', {}, ...cells.map((c, k) => cell('th', k, [`GW${c.g}`])), el('th', { textContent: d === 1 ? 'Total' : 'Total (decay)' }))),
      el('tbody', {}, el('tr', {}, ...cells.map((c, k) => cell('td', k, [el('b', { textContent: f1(c.xp) }), el('small', { textContent: c.opp })])),
        el('td', {}, el('b', { textContent: f1(total) }))))));
    $('detail-acts').replaceChildren(...acts);
    $('detail-row').replaceChildren(el('p', { className: 'xp-who' }, el('b', { textContent: p.name }), ` ${p.team} ${p.position} £${(p.price || 0).toFixed(1)}`), row);
    $('detail').hidden = false;
    pick(t);
  }
  function showDetail(id, g) {
    const p = state.data && state.data.players.find((x) => x.id === id);
    if (!p) return;
    const gws = state.plan ? state.plan.gws : [g];
    const t = state.plan ? gws.indexOf(Number(g)) : -1;
    const w = t >= 0 && state.plan.weeks ? state.plan.weeks[t] : null;
    const P = state.plan ? state.plan.P : [];
    const k = w ? w.ins.findIndex((i) => P[i].id === id) : -1;
    const acts = [];
    if (t >= 0 && t < state.plan.depth) {
      acts.push(el('button', { type: 'button', className: 'update', textContent: 'Replace', onclick: () => editPlan(t, id, k, false) }));
      if (k >= 0) acts.push(el('button', { type: 'button', className: 'update alt', textContent: 'Remove', onclick: () => editPlan(t, id, k, true) }));
    }
    playerPopup(p, gws, Math.max(0, t), acts, state.plan && state.plan.mode);
  }
  // The plan on show as Manual plan moves, then Replace or Remove this player in gameweek t.
  async function editPlan(t, id, k, remove) {
    const { P, weeks } = state.plan;
    state.manual = {};
    weeks.slice(0, state.plan.depth).forEach((w, j) => {
      if (w.chip === 'freehit' || w.chip === 'wildcard') return;
      const moves = w.outs.map((o, n) => (w.ins[n] !== undefined ? { out: P[o].id, in: P[w.ins[n]].id } : null)).filter(Boolean);
      if (moves.length) state.manual[j] = moves;
    });
    let outId = id;
    if (k >= 0) {  // he was bought this week: take that move back; replacing him means another player for the one sold
      const m = (state.manual[t] || []).find((x) => x.in === id);
      if (m) { outId = m.out; state.manual[t] = state.manual[t].filter((x) => x !== m); }
    }
    saveManual();
    $('detail').hidden = true;
    $('out').replaceChildren();
    $('manual').hidden = false;
    $('manualOpen').setAttribute('aria-expanded', 'true');
    state.mt = t;
    ownSig = '';
    state.replacing = remove ? null : outId;
    manualWeeks();
    const ch = document.querySelector('.chooser');
    if (ch) ch.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        })),
        // Total under the players in: what this gameweek's moves gain, free transfers left and money left (as in the plans table)
        (() => {
          const o = state.plan.options[Math.min(state.plan.pick, state.plan.options.length - 1)];
          const g = o && o.gains ? o.gains[t] : null;
          const T = gws.length, decayOn = state.plan.mode !== 'normal';
          const sign = (x) => `${x >= 0 ? '+' : '−'}${f1(Math.abs(x))}`;
          const lines = [];
          if (g) {
            lines.push(`${sign(g.now)} GW${gws[t]}`);
            lines.push(decayOn ? `${sign(g.dec)} decay to GW${gws[T - 1]}` : `${sign(g.raw)} to GW${gws[T - 1]}`);
          }
          if (w.hits) lines.push(`${w.hits} hit${w.hits > 1 ? 's' : ''}`);
          if (w.chip !== 'wildcard' && w.chip !== 'freehit') lines.push(`FT saved: ${ftLeft(w)}`);
          if (w.bank !== null && w.bank !== undefined) lines.push(`Budget saved: £${f1(w.bank)}m`);
          return el('tfoot', {}, el('tr', { className: 'moves-total' }, el('td', {}),
            el('td', { className: 'inp' }, el('b', { textContent: 'Total' }), ...lines.map((x) => el('small', { textContent: x })))));
        })());
    }
    const facts = [];
    if (w.transfersAllowed && !w.chip) facts.push(`${w.freeTransfers} free transfer${w.freeTransfers === 1 ? '' : 's'}`);
    if (w.chip === 'wildcard') facts.push('unlimited free transfers');
    if (w.chip === 'freehit') facts.push('unlimited transfers for this gameweek only; your squad comes back next week');
    // the bank at the start of the gameweek, before its transfers (what is left after them is in Total)
    let k = t - 1;
    while (k >= 0 && state.plan.weeks[k].chip === 'freehit') k--;  // a Free Hit week's squad and bank do not carry on
    const prevBank = k >= 0 ? state.plan.weeks[k].bank : state.team.bank;
    if (prevBank !== null && prevBank !== undefined && w.transfersAllowed && w.chip !== 'freehit') facts.push(`budget £${prevBank.toFixed(1)}m`);
    return el('section', { className: 'week-view' },
      el('div', { className: 'week-head' },
        el('h2', {}, `GW${gws[t]}`, w.chip ? el('span', { className: 'chip-tag', textContent: CHIP_LABEL[w.chip] }) : ''),
        weekPts(w.xpts, t)),
      el('p', { className: 'meta', textContent: (facts.length ? `Beginning: ${facts.join(', ')}. ` : '') + (w.subs > 0.05 ? benchText(w.subs, t) : '') }),
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
    const label = (o) => (o.manual ? 'My transfers' : o.count === null ? (state.plan.chips.wildcard || []).includes(0) ? 'Wildcard' : 'Free Hit'
      : o.roll ? (o.count ? 'Forced only' : 'Save') : o.count > state.team.ft ? `${state.team.ft} FT + ${o.count - state.team.ft} hit${o.count - state.team.ft > 1 ? 's' : ''}` : `${o.count} FT`);
    const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
    const byPos = (a, b) => order[P[a].position] - order[P[b].position] || P[b].price - P[a].price;
    const holdW = state.plan.holdW || [];
    const sign = (x) => `${x >= 0 ? '+' : '−'}${f1(Math.abs(x))}`;
    // under each gameweek's moves: money left, and that gameweek's expected points against keeping the squad
    const decayOn = state.plan.mode !== 'normal'; // figures as the plans were optimised: Decay or Normal
    const T = gws.length;
    // under each gameweek's moves: money left, what the moves gain that gameweek and over the rest of the plan
    const facts = (w, g) => {
      const out = [];
      if (w.chip !== 'wildcard' && w.chip !== 'freehit') out.push(el('small', { className: 'itb ft-saved', textContent: `FT saved: ${ftLeft(w)}` }));
      if (w.bank !== null && w.bank !== undefined) out.push(el('small', { className: w.t > 0 && w.ins.length && w.chip !== 'freehit' && w.bank < BANK_BUFFER * (w.t + 1) - 1e-6 ? 'itb tight' : 'itb', textContent: `Budget saved £${f1(w.bank)}m` }));
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
        .concat(w.hits ? [el('small', { className: 'hit', textContent: `${w.hits} hit${w.hits > 1 ? 's' : ''}` })] : [])
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
      el('div', { className: 'opt-head' }, el('h3', {}, `Plans from GW${gws[0]}: tap one to see it week by week`)),
      el('div', { className: 'wrap' }, el('table', { className: 'opt-table route-table' },
        el('thead', {}, el('tr', {}, thI('Uses now', 'col-uses'),
          ...gws.slice(0, depth).map((g, k) => thI(`GW${g}`, k ? '' : 'col-gw')),
          thI(decayOn ? 'xPts Decay' : 'xPts', 'col-xpts', 'num'), thI(decayOn ? 'Gain Decay' : 'Gain', 'col-gain', 'num'),
          thI('FT bonus', 'col-ftb', 'num'),
          thI('Score', 'col-score', 'num'), thI('Best', 'col-best', 'num'))),
        el('tbody', {}, ...rows))));
  }

  // a column heading with an (i) for its explanation (a hidden block in planner.html)
  function thI(text, info, cls) {
    const th = el('th', { scope: 'col', className: cls || '' }, el('span', { className: 'lbl-i' }, text,
      info ? el('button', { type: 'button', className: 'info-btn', 'aria-label': `About ${text}` }, 'i') : ''));
    if (info) th.querySelector('.info-btn').dataset.info = `info-${info}`;
    return th;
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
        el('span', { textContent: `GW${gws[k]}` }), el('small', { textContent: f1(w.xpts * weekF(k, state.plan.mode)) + (w.chip ? ` · ${w.chip === '3xc' ? 'TC' : w.chip === 'bboost' ? 'BB' : w.chip === 'freehit' ? 'FH' : 'WC'}` : '') }));
      b.setAttribute('aria-selected', String(k === state.week));
      b.setAttribute('aria-pressed', String(k === state.week));
      return b;
    }));
    const summary = el('section', { className: 'summary' },
      tightNote(P, weeks, gws),
      state.team.madeAlready && state.team.madeAlready.length ? el('p', { className: 'meta', textContent: `Already made for GW${state.team.lastGw + 1}: ${state.team.madeAlready.join(', ')} (counted in your squad and free transfers).` }) : '',
      Object.keys(state.overrides).length ? el('p', { className: 'meta', textContent: `Uses your minutes edits from the Minutes page (${Object.keys(state.overrides).length} players).` }) : '',
      state.plan.dropped ? el('p', { className: 'meta', textContent: `${state.plan.dropped} plan${state.plan.dropped > 1 ? 's were' : ' was'} left out: ${state.plan.dropped > 1 ? 'their' : 'its'} GW${gws[0]} moves gain less that gameweek than the free transfers they use cost.` }) : '',
      state.plan.skipped ? el('p', { className: 'meta', textContent: `${state.plan.skipped} of the plans could not be worked out (the solver ran out of memory on this device) and are left out.` }) : '',
      /optimal/i.test(state.plan.status) ? '' : el('p', { className: 'meta', textContent: `Some searches stopped at their time limit (${state.plan.status}); the plans are good but may not be the very best.` }));
    if (state.plan.manual) { $('out').replaceChildren(optionsView(P, options, gws), fhView(P, pick, gws)); return; }
    $('out').replaceChildren(optionsView(P, options, gws), fhView(P, pick, gws), ...(summary.children.length ? [summary] : []), tabs, weekView(weeks[Math.min(state.week, weeks.length - 1)]));
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
    const r = await fetch(`plans/${entry}.json`, { cache: 'no-cache' });
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
    $('manual').hidden = true;  // Suggest transfers: the own-transfers pitch is put away
    $('manualOpen').setAttribute('aria-expanded', 'false');
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

  // Manual plan: the viewer's own transfers, gameweek by gameweek ({t: [{out, in}]}), kept in this browser.
  state.manual = (() => { try { return JSON.parse(localStorage.getItem('planner-manual') || '{}'); } catch (e) { return {}; } })();
  const saveManual = () => { try { localStorage.setItem('planner-manual', JSON.stringify(state.manual)); } catch (e) { /* private mode */ } };
  const pname = (p) => `${p.name} (${p.team} ${p.position})`;
  const findPlayer = (text) => state.data.players.find((x) => pname(x) === text) || state.data.players.find((x) => x.name.toLowerCase() === String(text).trim().toLowerCase());
  // his squad (player ids) at the start of transfer week t, after the manual moves before it
  function squadAt(t) {
    const ids = new Set(state.team ? state.team.squad.map((x) => x.id) : []);
    for (let k = 0; k < t; k++) (state.manual[k] || []).forEach((m) => { ids.delete(m.out); ids.add(m.in); });
    return ids;
  }
  // Manual plan on the pitch, as on FPL's transfers page: one tab per transfer gameweek showing the squad that week;
  // tap a player for his figures, then Replace (pick who comes in: same position, affordable, best first) or, for one
  // bought that week, Remove (take the move back). Your moves are scored as a plan below as soon as they change.
  const ORDER = (p) => 'GKDEFMIDFWD'.indexOf(p.position);
  state.mt = 0;          // the gameweek tab on show in Manual plan
  state.replacing = null; // the player being replaced (id), while the list of players to bring in is open
  function manualCtx() {
    const gws = horizonGws();
    const depth = Math.min(PLAN.depth, gws.length); // transfers in the first 5 gameweeks, as in Suggest transfers; later ones locked
    const byId = new Map(state.data.players.map((p) => [p.id, p]));
    const sellNow = new Map(state.team.squad.map((x) => [x.id, x.sell !== undefined ? x.sell : x.price]));
    const sellOf = (id) => (sellNow.has(id) ? sellNow.get(id) : (byId.get(id) || {}).price || 0);
    const priceOf = (id) => (byId.get(id) || {}).price || 0;
    const bankAt = (t) => { let b = state.team.bank; for (let k = 0; k < t; k++) (state.manual[k] || []).forEach((m) => { b += sellOf(m.out) - priceOf(m.in); }); return b; };
    const bankAfter = (t) => bankAt(t) + (state.manual[t] || []).reduce((a, m) => a + sellOf(m.out) - priceOf(m.in), 0);
    const view = (p, g) => XMin.view(state.overrides, p, String(g));
    const xpAt = (p, g) => { const v = view(p, g); return v ? v.xpts : 0; };
    const longXp = (p) => gws.reduce((a, g, k) => a + Math.pow(PLAN.decay, k) * xpAt(p, g), 0);
    const tidy = (from) => { for (let k = from; k < depth; k++) state.manual[k] = (state.manual[k] || []).filter((m) => squadAt(k).has(m.out) && !squadAt(k).has(m.in)); };
    return { gws, depth, all: gws.length, byId, sellOf, priceOf, bankAt, bankAfter, view, xpAt, longXp, tidy };
  }
  // the squad in week t, after that week's own moves
  const squadAfter = (t) => { const ids = squadAt(t); (state.manual[t] || []).forEach((m) => { ids.delete(m.out); ids.add(m.in); }); return ids; };

  // The best starting 11 of a squad for gameweek g (1 GK, at least 3 DEF, 2 MID, 1 FWD), the bench in order
  // (goalkeeper first) and the captain and vice-captain: highest expected points first.
  function lineUp(players, g) {
    const xp = new Map(players.map((p) => [p.id, xpOf(p, g)]));
    const by = (a, b) => xp.get(b.id) - xp.get(a.id);
    const gks = players.filter((p) => p.position === 'GK').sort(by);
    const out = players.filter((p) => p.position !== 'GK').sort(by);
    const xi = [gks[0]].filter(Boolean);
    const need = { DEF: 3, MID: 2, FWD: 1 };
    Object.entries(need).forEach(([pos, n]) => out.filter((p) => p.position === pos).slice(0, n).forEach((p) => xi.push(p)));
    out.filter((p) => !xi.includes(p)).forEach((p) => { if (xi.length < 11) xi.push(p); });
    const bench = gks.slice(1).concat(out.filter((p) => !xi.includes(p)));
    const caps = xi.slice().sort(by);
    return { xi, bench, cap: caps[0], vice: caps[1], xp };
  }
  // a line-up's expected points as the plans count them (starters 97% / 95.5%, bench 28-12-5% and 3%, captain)
  function lineScore(L, part) {
    const all = L.xi.concat(L.bench);
    const ps = all.map((p) => ({ position: p.position, xp: L.xp.get(p.id) }));
    const ix = (p) => (p ? all.indexOf(p) : null);
    const r = S.expectedWithSubs(ps, L.xi.map(ix), L.bench.map(ix), ix(L.cap), ix(L.vice), 2, false);
    return part === 'subs' ? r.subs : r.xpts;
  }
  // "Bench adds about 1.8 (1.5 decay)": the bench's share of a gameweek, and the same with that week's decay
  const benchText = (x, t) => `Bench adds about ${f1(x)} (${f1(x * Math.pow(PLAN.decay, t))} decay).`;

  function manualWeeks() {
    const box = $('manualWeeks');
    if (!state.data || !state.team) {
      const load = el('button', { type: 'button', className: 'update', textContent: 'Load my team' });
      load.addEventListener('click', async () => {
        const entry = $('entry').value.trim();
        if (!/^\d+$/.test(entry)) { showError('Enter your FPL team ID at the top first.'); return; }
        try { await loadTeam(entry); manualWeeks(); } catch (e) { showError(e.message); }
      });
      box.replaceChildren(el('p', { className: 'set-note', textContent: 'Your squad is loaded from FPL first; then make your transfers on the pitch, gameweek by gameweek.' }), load);
      return;
    }
    const c = manualCtx();
    Object.keys(state.manual).forEach((t) => { if (Number(t) >= c.depth) delete state.manual[t]; });
    state.mt = Math.min(state.mt, c.all - 1);
    const t = state.mt, g = c.gws[t];
    // free transfers and hits, week by week (one more each week, 5 at most)
    let ft = state.team.ft, hits = 0;
    for (let k = 0; k <= t; k++) { const n = (state.manual[k] || []).length; if (k === t) hits = Math.max(0, n - ft); else ft = Math.min(S.MAX_FT, Math.max(0, ft - n) + 1); }
    const tabs = el('div', { className: 'seg week-tabs', role: 'tablist' }, ...[...Array(c.all).keys()].map((k) => {
      const n = (state.manual[k] || []).length;
      const b = el('button', { type: 'button', role: 'tab', onclick: () => { state.mt = k; state.replacing = null; manualWeeks(); } },
        el('span', { textContent: `GW${c.gws[k]}` }), el('small', { textContent: k >= c.depth ? 'locked' : n ? `${n} move${n > 1 ? 's' : ''}` : 'save' }));
      b.setAttribute('aria-pressed', String(k === t));
      return b;
    }));
    const moves = state.manual[t] || [];
    const bought = new Set(moves.map((m) => m.in));
    const squad = [...squadAfter(t)].map((id) => c.byId.get(id)).filter(Boolean);
    const L = lineUp(squad, g);
    const total = lineScore(L) - hits * S.HIT;
    const mcard = (p) => {
      const v = c.view(p, g);
      const isCap = L.cap && p.id === L.cap.id;
      const badges = [];
      if (isCap) badges.push(el('span', { className: 'pp-badge cap', textContent: 'C', title: 'Captain' }));
      else if (L.vice && p.id === L.vice.id) badges.push(el('span', { className: 'pp-badge vice', textContent: 'V', title: 'Vice-captain' }));
      if (bought.has(p.id)) badges.push(el('span', { className: 'pp-badge new', textContent: 'IN', title: 'Bought this gameweek' }));
      const cardEl = el('div', { className: `pp-card${state.replacing === p.id ? ' on' : ''}`, tabIndex: 0, role: 'button', title: `${p.name}: tap to replace him or see his figures` },
        el('div', { className: 'pp-badges' }, ...badges), shirt(p.team, p.position === 'GK'),
        el('span', { className: 'pp-name', textContent: p.name }),
        el('span', { className: 'pp-pts', textContent: f1((v ? v.xpts : 0) * (isCap ? 2 : 1) * weekF(t, state.optMode)) }),
        el('span', { className: 'pp-opp', textContent: v ? fixture(v.opp) : 'Blank' }));
      const open = () => manualDetail(p.id);
      cardEl.addEventListener('click', open);
      cardEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      return cardEl;
    };
    const rows = ['GK', 'DEF', 'MID', 'FWD'].map((pos) => el('div', { className: 'pp-row' }, ...L.xi.filter((p) => p.position === pos).map(mcard)));
    const bench = el('div', { className: 'pp-bench' }, ...L.bench.map((p, k) => el('div', { className: 'pp-slot' },
      el('span', { className: 'pp-slot-label', textContent: k === 0 ? 'GKP' : `${k}. ${POS_LABEL[p.position]}` }), mcard(p))));
    const d = modeDecay();
    let movesEl;
    if (!moves.length) movesEl = t >= c.depth ? '' : el('p', { className: 'meta', textContent: 'No transfer: save it. Tap a player to replace him.' });
    else {
      // the same figures as the plan row below once it is worked out (until then, worked out here)
      const solved = state.plan && state.plan.manual && state.plan.sig === ownSig && ownSig === ownKey() && state.plan.options[0].gains ? state.plan.options[0].gains[t] : null;
      const wg = solved ? { week: solved.now, total: d === 1 ? solved.raw : solved.dec } : weekGain(c, t, d);
      const last = c.gws[c.gws.length - 1];
      const lines = [`${signed(wg.week)} GW${g}`, d === 1 ? `${signed(wg.total)} to GW${last}` : `${signed(wg.total)} decay to GW${last}`];
      if (hits) lines.push(`${hits} hit${hits > 1 ? 's' : ''}`);
      lines.push(`FT saved: ${Math.max(0, ft - moves.length)}`, `Budget saved: £${f1(c.bankAfter(t))}m`);
      movesEl = el('table', { className: 'moves-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Out' }), el('th', { scope: 'col', textContent: 'In' }), el('th', { textContent: '' }))),
        el('tbody', {}, ...moves.map((m, k) => {
          const o = c.byId.get(m.out), n = c.byId.get(m.in);
          const undo = el('button', { type: 'button', className: 'linkbtn', textContent: 'Remove', title: 'Take this move back' });
          undo.addEventListener('click', () => { state.manual[t].splice(k, 1); c.tidy(t + 1); saveManual(); manualWeeks(); });
          return el('tr', {},
            el('td', { className: 'outp' }, el('b', { textContent: o.name }), el('small', { textContent: ` ${o.team} ${o.position} £${c.sellOf(o.id).toFixed(1)} · ${f1(xpOf(o, g))} xPts` })),
            el('td', { className: 'inp' }, el('b', { textContent: n.name }), el('small', { textContent: ` ${n.team} ${n.position} £${n.price.toFixed(1)} · ${f1(xpOf(n, g))} xPts` })),
            el('td', {}, undo));
        })),
        el('tfoot', {}, el('tr', { className: 'moves-total' }, el('td', {}),
          el('td', { className: 'inp' }, el('b', { textContent: 'Total' }), ...lines.map((x) => el('small', { textContent: x }))), el('td', {}))));
    }
    const facts = t >= c.depth ? `No transfers from GW${c.gws[c.depth]}: the squad stays, best 11 and captain each week (as in Suggest transfers).`
      : `Beginning: ${ft} free transfer${ft === 1 ? '' : 's'}, budget £${c.bankAt(t).toFixed(1)}m.`;
    const view = el('section', { className: 'week-view' },
      el('div', { className: 'week-head' }, el('h2', {}, `GW${g}`), weekPts(total, t)),
      el('p', { className: 'meta', textContent: facts + (lineScore(L, 'subs') > 0.05 ? ` ${benchText(lineScore(L, 'subs'), t)}` : '') }), movesEl,
      el('div', { className: 'pp-pitch' }, el('div', { className: 'pp-lines', 'aria-hidden': 'true' }), ...rows), bench);
    const parts = [tabs, view];
    if (state.replacing) parts.splice(1, 0, chooser(c, t, state.replacing));
    box.replaceChildren(...parts);
    scheduleOwnPlan();
  }
  // My own transfers are scored as a plan (shown below, with the Free Hit week) whenever they change.
  let ownSig = '', ownBusy = false, ownAgain = false, ownTimer = null;
  const ownKey = () => JSON.stringify([state.manual, $('horizon').value, state.optMode, state.entry]);
  function scheduleOwnPlan(force) {
    if ($('manual').hidden || !state.team) return;
    const sig = ownKey();
    if (!force && sig === ownSig) return;
    clearTimeout(ownTimer);
    ownTimer = setTimeout(async () => {
      if (ownBusy) { ownAgain = true; return; }
      ownBusy = true; ownSig = sig;
      try { await makePlan(state.manual); if (state.plan && state.plan.manual) state.plan.sig = sig; } finally { ownBusy = false; }
      if (ownAgain) { ownAgain = false; scheduleOwnPlan(); } else if (!$('manual').hidden && state.plan && state.plan.manual) manualWeeks();  // Total from the plan's figures
    }, 500);
  }
  // What a gameweek's moves gain together: the team's points with them minus without them (best starting 11 and
  // captain each week), that gameweek and from it to the last one planned, hits taken off.
  function weekGain(c, t, d) {
    const team = (ids, g) => lineScore(lineUp([...ids].map((id) => c.byId.get(id)).filter(Boolean), g));
    const ms = state.manual[t] || [];
    let total = 0, week = 0;
    for (let k = t; k < c.gws.length; k++) {
      const withIt = squadAfter(k);
      const without = new Set(withIt);
      ms.forEach((m) => { if (without.has(m.in) && !without.has(m.out)) { without.delete(m.in); without.add(m.out); } });
      const diff = team(withIt, c.gws[k]) - team(without, c.gws[k]);
      total += Math.pow(d, k) * diff;
      if (k === t) week = diff;
    }
    let ft = state.team.ft;
    for (let k = 0; k < t; k++) ft = Math.min(S.MAX_FT, Math.max(0, ft - (state.manual[k] || []).length) + 1);
    const hit = Math.max(0, ms.length - ft) * S.HIT;
    return { total: total - Math.pow(d, t) * hit, week: week - hit };
  }
  // The real gain of a move in week t: the team's points with it minus without it (best starting 11 and captain each
  // week, so a player who only sits on the bench adds little), from week t to the last gameweek planned, counted as
  // the plans count (Normal or Decay), while the player bought is still in the squad; a hit it causes is taken off.
  function realGain(c, t, m, d) {
    const team = (ids, g) => lineScore(lineUp([...ids].map((id) => c.byId.get(id)).filter(Boolean), g));
    let total = 0, week = 0;
    for (let k = t; k < c.gws.length; k++) {
      const withIt = k < c.depth ? squadAfter(k) : squadAfter(c.depth - 1);
      if (!withIt.has(m.in)) break;
      const without = new Set(withIt); without.delete(m.in); without.add(m.out);
      const diff = team(withIt, c.gws[k]) - team(without, c.gws[k]);
      total += Math.pow(d, k) * diff;
      if (k === t) week = diff;
    }
    // a hit: the moves of week t beyond its free transfers cost 4 each, charged to the last ones made
    let ft = state.team.ft;
    for (let k = 0; k < t; k++) ft = Math.min(S.MAX_FT, Math.max(0, ft - (state.manual[k] || []).length) + 1);
    const idx = (state.manual[t] || []).indexOf(m);
    const hit = idx >= ft ? S.HIT : 0;
    return { total: total - Math.pow(d, t) * hit, week: week - hit, hit };
  }
  // What a swap gains from gameweek t to the last one planned, counted as the plans count (Normal or Decay).
  const swapGain = (c, t, o, n, d) => c.gws.slice(t).reduce((a, g, k) => a + Math.pow(d, t + k) * (xpOf(n, g) - xpOf(o, g)), 0);
  const signed = (x) => `${x >= 0 ? '+' : '−'}${f1(Math.abs(x))}`;

  // Replace Player, laid out like FPL's: the bank, a search, the player going out, then everyone who can come in
  // (same position, not in the squad, affordable that week) with the gain this gameweek and to the last gameweek;
  // tap a column to sort by it.
  state.chooseSort = 'total';
  function chooser(c, t, outId) {
    const o = c.byId.get(outId);
    const have = squadAfter(t);
    const money = c.bankAfter(t) + c.sellOf(outId);
    const d = modeDecay();
    const g = c.gws[t], last = c.gws[c.gws.length - 1];
    const outNow = xpOf(o, g);
    const outLong = c.gws.slice(t).reduce((a, gg, k) => a + Math.pow(d, t + k) * xpOf(o, gg), 0);
    const search = el('input', { type: 'search', placeholder: 'Search by name or club', ariaLabel: 'Search' });
    const cands = state.data.players.filter((p) => p.position === o.position && !have.has(p.id) && (p.price || 0) <= money + 1e-6)
      .map((p) => ({ p, now: xpOf(p, g), week: xpOf(p, g) - outNow, total: swapGain(c, t, o, p, d) }));
    const body = el('tbody');
    const pill = (x) => el('span', { className: `gain-pill ${x >= 0.05 ? 'up' : x <= -0.05 ? 'down' : 'flat'}`, textContent: signed(x) });
    const head = (key, label) => {
      const th = el('th', { scope: 'col', className: `num sortable${state.chooseSort === key ? ' on' : ''}`, textContent: label });
      th.addEventListener('click', () => { state.chooseSort = key; manualWeeks(); });
      return th;
    };
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      const key = state.chooseSort;
      const list = cands.filter(({ p }) => !q || p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q) || (p.fullName || '').toLowerCase().includes(q))
        .sort((x, y) => (key === 'price' ? y.p.price - x.p.price : y[key] - x[key])).slice(0, 50);
      body.replaceChildren(...list.map(({ p, now, week, total }) => {
        const tr = el('tr', { tabIndex: 0, title: `Bring ${p.name} in for ${o.name}` },
          el('td', { className: 'who' }, shirt(p.team, p.position === 'GK'), el('span', {}, el('b', { textContent: p.name }), el('small', { textContent: `${p.team} ${p.position} · GW${g} ${f1(now)} xPts` }))),
          el('td', { className: 'num', textContent: `£${p.price.toFixed(1)}` }),
          el('td', { className: 'num' }, pill(week)),
          el('td', { className: 'num' }, pill(total)));
        const choose = () => {
          (state.manual[t] = state.manual[t] || []).push({ out: outId, in: p.id });
          c.tidy(t + 1); saveManual(); state.replacing = null; $('error').hidden = true; manualWeeks();
        };
        tr.addEventListener('click', choose);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') choose(); });
        return tr;
      }));
    };
    search.addEventListener('input', fill);
    fill();
    const back = el('button', { type: 'button', className: 'choose-back', textContent: '←', title: 'Back', ariaLabel: 'Back', onclick: () => { state.replacing = null; manualWeeks(); } });
    return el('section', { className: 'chooser' },
      el('div', { className: 'choose-top' }, back, el('h3', { textContent: 'Replace Player' })),
      el('div', { className: 'choose-bank', textContent: `Bank £${c.bankAfter(t).toFixed(1)}m · up to £${money.toFixed(1)}m with his sale` }),
      search,
      el('p', { className: 'choose-label', textContent: 'Outgoing player' }),
      el('div', { className: 'choose-out' }, shirt(o.team, o.position === 'GK'),
        el('span', {}, el('b', { textContent: o.name }), el('small', { textContent: `${o.team} ${o.position} · sells £${c.sellOf(outId).toFixed(1)}m` })),
        el('span', { className: 'num' }, el('small', { textContent: `GW${g}` }), el('b', { textContent: f1(outNow) })),
        el('span', { className: 'num' }, el('small', { textContent: `GW${g}-${last}` }), el('b', { textContent: f1(outLong) }))),
      el('div', { className: 'choose-wrap' }, el('table', { className: 'choose-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Player' }), head('price', 'Price'), head('week', `GW${g} gain`), head('total', `Gain to GW${last}`))),
        body)),
      el('p', { className: 'set-note', textContent: `Gain = his expected points minus ${o.name}'s, in GW${g} and from GW${g} to GW${last}${d === 1 ? '' : ' (each later gameweek × 0.85, as you chose)'}.` }));
  }

  // A player tapped in Manual plan: Replace (and Remove for one bought this week), then his xPoints row.
  function manualDetail(id) {
    const c = manualCtx();
    const t = state.mt;
    const p = c.byId.get(id);
    if (!p) return;
    const move = (state.manual[t] || []).find((m) => m.in === id);
    // Replace, or Remove: both take him out and open the list of players to bring in (Remove on a player bought
    // this week just takes that transfer back)
    const out = () => {
      $('detail').hidden = true;
      let outId = id;
      if (move) { outId = move.out; state.manual[t] = state.manual[t].filter((m) => m !== move); c.tidy(t + 1); saveManual(); }
      state.replacing = outId; manualWeeks();
      const ch = document.querySelector('.chooser');
      if (ch) ch.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const acts = t >= c.depth ? [el('p', { className: 'meta', textContent: `No transfers from GW${c.gws[c.depth]}: the squad stays, as in Suggest transfers.` })]
      : [el('button', { type: 'button', className: 'update', textContent: 'Replace', onclick: out }),
      el('button', { type: 'button', className: 'update alt', textContent: move ? 'Remove (undo this transfer)' : 'Remove', onclick: move ? () => {
        state.manual[t] = state.manual[t].filter((m) => m !== move); c.tidy(t + 1); saveManual(); $('detail').hidden = true; manualWeeks();
      } : out })];
    playerPopup(p, c.gws, t, acts);
  }

  $('manualOpen').addEventListener('click', async () => {
    const open = $('manual').hidden;
    $('manual').hidden = !open;
    $('manualOpen').setAttribute('aria-expanded', String(open));
    if (open) {
      $('out').replaceChildren();  // Plan my own transfers: the suggested plans are put away
      ownSig = '';
      const entry = $('entry').value.trim();
      if (/^\d+$/.test(entry) && (!state.team || state.entry !== entry)) { try { await loadTeam(entry); } catch (e) { showError(e.message); } }
      manualWeeks();
    }
  });
  $('manualClear').addEventListener('click', () => { state.manual = {}; saveManual(); manualWeeks(); });

  // (i) buttons: the explanation in a pop-up (a fresh copy, so live figures such as the gameweek are current)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.info-btn');
    const pop = $('infoPop');
    if (b) {
      e.preventDefault();
      const src = $(b.dataset.info).cloneNode(true);
      src.removeAttribute('id'); src.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
      pop.querySelector('.info-body').replaceChildren(src);
      pop.hidden = false;
      return;
    }
    if (!pop.hidden && (e.target.closest('.info-close') || !e.target.closest('#infoPop'))) pop.hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('infoPop').hidden = true; });
  $('pick').addEventListener('submit', (e) => { e.preventDefault(); go(); });
  $('optMode').value = state.optMode;
  $('optMode').addEventListener('change', () => { state.optMode = $('optMode').value; try { localStorage.setItem('planner-opt-v3', state.optMode); } catch (e) { /* private mode */ } if (!$('manual').hidden) manualWeeks(); });
  $('horizon').addEventListener('change', () => { chipChoices(); readSettings(); settingsForm(); if (!$('manual').hidden) manualWeeks(); });
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
  fetch('data.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      state.data = data;
      XMin.setPlayers(data.players, data.penPatterns);
      state.settings = loadSettings();
      $('playerNames').replaceChildren(...data.players.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => el('option', { value: `${p.name} (${p.team} ${p.position})` })));
      settingsForm();
      // read the team so its chips show, but only plan when asked: a plan takes a while
      const entry = $('entry').value.trim();
      $('out').replaceChildren(el('p', { className: 'working', textContent: entry ? 'Choose the gameweeks, chips and settings, then press Suggest transfers or Plan my own transfers.' : 'Enter your FPL team ID to start. Not sure what it is? Open "Where do I find my ID?" above.' }));
      if (!entry) { const h = document.querySelector('.id-help'); if (h) h.open = true; }
      if (/^\d+$/.test(entry)) loadTeam(entry).catch((e) => { showError(e.message); $('status').textContent = 'Enter an FPL team ID'; });
    })
    .catch(() => showError('Could not load the xPoints data. Reload the page to try again.'));
})();
