(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
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

  // ---- settings ----
  const SET_KEY = 'planner-settings-v4';  // v4: a saved transfer is worth 2 by default
  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(SET_KEY)) || null;
      // carry settings over from the previous version, apart from the old saved-transfer value
      if (!saved) { saved = JSON.parse(localStorage.getItem('planner-settings-v3')) || {}; delete saved.ftValue; }
    } catch (e) { saved = {}; }
    const st = { ...S.DEFAULTS, keep: [], avoid: [], forceIn: [], forceOut: [], forceGw: null, ...saved };
    // forced transfers only hold for the gameweek they were set for
    if (state.data && st.forceGw !== state.data.gws[0]) { st.forceIn = []; st.forceOut = []; st.forceGw = state.data.gws[0]; }
    return st;
  }
  function saveSettings() { try { localStorage.setItem(SET_KEY, JSON.stringify(state.settings)); } catch (e) { /* fine */ } }

  function settingsForm() {
    const st = state.settings;
    const T = Number($('horizon').value);
    $('depth').replaceChildren(...Array.from({ length: T }, (_, k) => el('option', { value: String(k + 1), textContent: String(k + 1) })));
    $('depth').value = String(Math.min(st.depth, T));
    $('decay').value = String(st.decay);
    $('ftValue').value = String(st.ftValue);
    $('bankValue').value = String(st.bankValue);
    $('maxHits').value = st.maxHits == null ? '' : String(st.maxHits);
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
    const num = (id, lo, hi, dflt) => { const n = Number($(id).value); return Number.isFinite(n) && $(id).value !== '' ? Math.max(lo, Math.min(hi, n)) : dflt; };
    st.depth = Number($('depth').value) || S.DEFAULTS.depth;
    st.decay = num('decay', 0.5, 1, S.DEFAULTS.decay);
    st.ftValue = num('ftValue', 0, 5, S.DEFAULTS.ftValue);
    st.bankValue = num('bankValue', 0, 1, S.DEFAULTS.bankValue);
    st.maxHits = $('maxHits').value === '' ? null : Number($('maxHits').value);
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

  // transfer options at each gameweek (plus saving the transfer at every step); one path after these
  // best plans for each number of transfers this gameweek: 3, or 2 when there are 3+ free transfers (more rows)
  const perCount = (ft) => (ft >= 3 ? 2 : 3);

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
    const base = { players: P, T, ft: state.team.ft, bank: state.team.bank, chips, settings: st,
      keep: st.keep.filter((id) => index.has(id)).map((id) => index.get(id)), avoid: st.avoid.filter((id) => index.has(id)).map((id) => index.get(id)) };
    const ownedIds = new Set(state.team.squad.map((x) => x.id));
    const fIn = st.forceIn.filter((id) => index.has(id) && !ownedIds.has(id)), fOut = st.forceOut.filter((id) => index.has(id) && ownedIds.has(id));
    const forcedN = Math.max(fIn.length, fOut.length);
    if (forcedN) base.force = { buys: fIn.map((id) => index.get(id)), sells: fOut.map((id) => index.get(id)) };
    // The options this gameweek: the best 3 plans using each number of transfers, from all free transfers down to 1,
    // and the best plan saving them (or making only the forced ones). Later gameweeks follow each plan's own path.
    const week0Chip = (chips.wildcard || []).includes(0) || (chips.freehit || []).includes(0);
    const groups = [];
    if (week0Chip) groups.push({ count: null, n: 3 });
    else {
      const top = Math.max(state.team.ft, forcedN, 1);
      for (let k = top; k > forcedN; k--) groups.push({ count: k, n: perCount(state.team.ft) });
      groups.push({ count: forcedN, n: 1 });
    }
    const planned = groups.reduce((a, g) => a + g.n, 0);
    let done = 0;
    const progress = (text) => $('out').replaceChildren(el('p', { className: 'working', textContent: text }),
      el('div', { className: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(planned), 'aria-valuenow': String(done) }, el('span', { style: `width:${Math.round((100 * done) / planned)}%` })));
    $('go').disabled = true;
    progress(`Working out the options for GW${gws[0]}-${gws[gws.length - 1]}…`);
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
      progress(`Working out the options: ${done} of ${planned} plans…`);
      if (!sol.values || !Object.keys(sol.values).length || /infeasible/i.test(sol.status)) return null;
      if (!/optimal/i.test(sol.status)) worst = sol.status;
      return { input, model, values: sol.values, weeks: S.decode(input, model, sol.values) };
    };
    try {
      const options = [];
      for (const g of groups) {
        const cuts = [];
        for (let r = 0; r < g.n; r++) {
          const extra = { cut: cuts.slice() };
          if (g.count !== null) extra.count = [{ t: 0, n: g.count }];
          const sol = await solveWith(extra);
          if (!sol) continue;
          const opt = S.option(sol.input, sol.values, 0);
          if (options.some((o) => S.sameOption(o.opt, opt))) continue;
          options.push({ t: 0, opt, sol, count: g.count, rank: r + 1, roll: g.count !== null && g.count === forcedN });
          cuts.push(opt);
        }
      }
      if (!options.length) throw new Error(skipped ? 'The solver ran out of memory on this device. Try fewer gameweeks to plan.' : 'No plan fits these settings (check the players to keep and the chips).');
      progress('Simulating 5,000 scenarios to compare the options…');
      await new Promise((r) => setTimeout(r, 30));
      const res = simulateAll(P, gws, options.map((o) => o.sol));
      const N = res[0].total.length;
      const share = (get) => {
        const out = options.map(() => 0);
        for (let s = 0; s < N; s++) {
          let best = -Infinity, win = [];
          options.forEach((o, k) => { const v = get(res[k])[s]; if (v > best + 1e-6) { best = v; win = [k]; } else if (Math.abs(v - best) <= 1e-6) win.push(k); });
          win.forEach((k) => { out[k] += 1 / win.length / N; });
        }
        return out;
      };
      const tot = share((r) => r.total), first = share((r) => r.week[0]);
      options.forEach((o, k) => { o.win = tot[k]; o.winFirst = first[k]; o.pts = planPts(o.sol); });
      // within each number of transfers, list by expected points
      const groupOf = (o) => groups.findIndex((g) => g.count === o.count);
      options.sort((a, b) => groupOf(a) - groupOf(b) || b.pts - a.pts);
      options.forEach((o, k) => { o.rank = k > 0 && options[k - 1].count === o.count ? options[k - 1].rank + 1 : 1; });
      state.plan = { gws, P, options, chips, skipped, force: base.force, status: worst, hold: holdPoints(P, T), pick: 0 };
      // open the plan with the most expected points
      state.plan.pick = options.reduce((bi, o, k) => (o.pts > options[bi].pts ? k : bi), 0);
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

  // The options as a tree: each gameweek's options branch out from the one chosen before it.
  // The options in one table: each row is a plan; the best expected points and the most wins are marked.
  function optionsView(P, options, gws) {
    const bestPts = Math.max(...options.map((o) => o.pts)), bestWin = Math.max(...options.map((o) => o.win));
    const label = (o) => (o.count === null ? (state.plan.chips.wildcard || []).includes(0) ? 'Wildcard' : 'Free Hit'
      : o.roll ? (o.count ? 'Forced only' : 'Save') : `${o.count} transfer${o.count > 1 ? 's' : ''}`);
    const rows = options.map((o, k) => {
      const w = o.sol.weeks[0];
      const tr = el('tr', { className: k === state.plan.pick ? 'on' : '', tabIndex: 0, onclick: () => { state.plan.pick = k; state.week = 0; render(); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); state.plan.pick = k; state.week = 0; render(); } } },
        el('td', { className: 'opt-count' }, el('b', { textContent: label(o) }), o.rank > 1 ? el('small', { textContent: ` #${o.rank}` }) : ''),
        el('td', { className: 'opt-moves', textContent: (o.roll && !o.count ? 'Save the transfer' : optionText(P, o)) + (w.hits ? ` (−${w.hits * S.HIT})` : '') }),
        el('td', { className: `num${o.pts === bestPts ? ' best' : ''}`, textContent: f1(o.pts) }),
        el('td', { className: `num${o.win === bestWin ? ' best' : ''}` }, el('span', { className: 'tn-bar' }, el('span', { style: `width:${Math.round(o.win * 100)}%` })), ' ', pctFine(o.win)),
        el('td', { className: 'num muted', textContent: pctFine(o.winFirst) }));
      tr.setAttribute('aria-selected', String(k === state.plan.pick));
      return tr;
    });
    const top = (key) => options.reduce((bi, o, k) => (o[key] > options[bi][key] ? k : bi), 0);
    const pBest = options[top('pts')], wBest = options[top('win')];
    const say = (o) => `${label(o)}${o.rank > 1 ? ` #${o.rank}` : ''}: ${o.roll && !o.count ? 'save' : optionText(P, o)}`;
    return el('section', { className: 'options' },
      el('h3', {}, `Options for GW${gws[0]}: tap one to see its plan`),
      el('p', { className: 'opt-verdict' }, 'Most expected points: ', el('b', { textContent: say(pBest) }),
        pBest === wBest ? ' (also best most often).' : '. Best most often: ', pBest === wBest ? '' : el('b', { textContent: say(wBest) })),
      el('div', { className: 'wrap' }, el('table', { className: 'opt-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Uses' }), el('th', { scope: 'col', textContent: 'Transfers' }),
          el('th', { scope: 'col', className: 'num', textContent: 'xPts plan' }), el('th', { scope: 'col', className: 'num', textContent: 'Best' }),
          el('th', { scope: 'col', className: 'num', textContent: `GW${gws[0]}` }))),
        el('tbody', {}, ...rows))));
  }

  const pctFine = (x) => (x < 0.1 ? `${(Math.round(x * 1000) / 10).toFixed(1)}%` : pct(x));

  function render() {
    const { gws, options, hold, P } = state.plan;
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
      el('p', { className: 'meta', textContent: '"Best" is the share of 5,000 simulated runs of every match in which that plan scores the most of all the plans in the table (they add up to 100%); the last column counts the first gameweek alone. A plan can have the most expected points and still be best less often, when its points come from rarer big hauls.' }),
      state.team.madeAlready && state.team.madeAlready.length ? el('p', { className: 'meta', textContent: `Already made for GW${state.team.lastGw + 1}: ${state.team.madeAlready.join(', ')} (counted in your squad and free transfers).` }) : '',
      Object.keys(state.overrides).length ? el('p', { className: 'meta', textContent: `Uses your minutes edits from the Minutes page (${Object.keys(state.overrides).length} players).` }) : '',
      state.plan.skipped ? el('p', { className: 'meta', textContent: `${state.plan.skipped} of the plans could not be worked out (the solver ran out of memory on this device) and are left out.` }) : '',
      /optimal/i.test(state.plan.status) ? '' : el('p', { className: 'meta', textContent: `Some searches stopped at their time limit (${state.plan.status}); the plans are good but may not be the very best.` }));
    $('out').replaceChildren(optionsView(P, options, gws), summary, tabs, weekView(weeks[Math.min(state.week, weeks.length - 1)]));
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
  ['depth', 'decay', 'ftValue', 'bankValue', 'maxHits'].forEach((id) => $(id).addEventListener('change', readSettings));
  ['keep', 'avoid', 'forceIn', 'forceOut'].forEach((kind) => {
    $(`${kind}Add`).addEventListener('click', () => addPick(kind));
    $(`${kind}Pick`).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPick(kind); } });
    // picking a name from the list adds it straight away, no need to press Add
    $(`${kind}Pick`).addEventListener('change', () => addPick(kind, true));
  });
  $('resetSettings').addEventListener('click', () => { state.settings = { ...S.DEFAULTS, keep: [], avoid: [], forceIn: [], forceOut: [], forceGw: state.data.gws[0] }; saveSettings(); settingsForm(); });
  state.settings = loadSettings();
  $('entry').addEventListener('change', () => { if ($('entry').value.trim() !== state.entry) { state.team = null; state.entry = null; chipChoices(); } });
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') state.overrides = XMin.load(); });

  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch (e) { saved = ''; }
  $('entry').value = new URLSearchParams(location.search).get('id') || saved || '11081';
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
      $('out').replaceChildren(el('p', { className: 'working', textContent: 'Choose the gameweeks, chips and settings, then press Make plan.' }));
      if (/^\d+$/.test(entry)) loadTeam(entry).catch((e) => { showError(e.message); $('status').textContent = 'Enter an FPL team ID'; });
    })
    .catch(() => showError('Could not load the xPoints data. Reload the page to try again.'));
})();
