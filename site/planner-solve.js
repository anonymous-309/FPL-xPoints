// Planner model: the transfers, chips, starting 11 and captain that give the most expected points.
// Written as a mixed-integer programme in CPLEX LP format for the HiGHS solver (run in planner-worker.js),
// then read back into a plan per gameweek with auto-subs worked out by simulation.
// Shared by the page, the worker and the Node tests.
(function (root) {
  'use strict';
  const HIT = 4;
  const MAX_FT = 5;
  const DEPTH = 3;           // transfers are planned in the first 3 gameweeks only (plus wildcard and free hit weeks)
  const BENCH_W = 0.1;       // share of a bench player's points the search counts, a rough stand-in for auto-subs
  const CHURN = 0.1;         // small cost per transfer so it does not swap players for nothing
  const SQUAD = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  const XI = { GK: [1, 1], DEF: [3, 5], MID: [2, 5], FWD: [1, 3] };
  const POS = ['GK', 'DEF', 'MID', 'FWD'];

  // Candidates: owned players, and anyone not beaten on points by more than his position's squad size of players
  // costing no more. players: [{id, position, price, xp: [per week]}]
  function pool(players, ownedIds) {
    const owned = new Set(ownedIds);
    const keep = new Set(ownedIds);
    POS.forEach((pos) => {
      const k = SQUAD[pos];
      const list = players.filter((p) => p.position === pos).map((p) => ({ p, tot: p.xp.reduce((a, b) => a + b, 0) }))
        .sort((a, b) => a.p.price - b.p.price || b.tot - a.tot);
      let best = [];
      list.forEach(({ p, tot }) => {
        if (tot > 0 && best.filter((b) => b > tot).length < k) keep.add(p.id);
        best = best.concat(tot).sort((a, b) => b - a).slice(0, k);
      });
    });
    return players.filter((p) => keep.has(p.id) || owned.has(p.id));
  }

  // input: {players: [{id, position, team, price, sell (owned only), owned, xp: [T]}], T, ft, bank,
  //         chips: {wildcard: [t], freehit: [t], bboost: [t], '3xc': [t]} (week indexes), depth}
  function build(input) {
    const { players: P, T, ft, bank } = input;
    const depth = Math.min(input.depth ?? DEPTH, T);
    const chips = input.chips || {};
    const has = (name, t) => (chips[name] || []).includes(t);
    const n = P.length;
    const vars = new Map(); // name -> {type: B|I|C, lo, hi}
    const obj = new Map();
    const rows = [];
    const v = (name, type = 'B', lo = 0, hi = 1) => { if (!vars.has(name)) vars.set(name, { type, lo, hi }); return name; };
    const addObj = (name, c) => { if (c) obj.set(name, (obj.get(name) || 0) + c); };
    const row = (terms, lo, hi) => rows.push({ terms: terms.filter(([c]) => c !== 0), lo, hi });
    const sellValue = (i) => (P[i].owned ? P[i].sell : P[i].price);

    const transferWeek = (t) => !has('freehit', t) && (t < depth || has('wildcard', t));
    let bankPrev = null;      // name of the bank variable after the last transfer week, null = starting bank
    let ftVar = null;         // free transfers available this week
    for (let t = 0; t < T; t++) {
      const x = (i) => `x${t}_${i}`;
      const xPrev = (i) => (t ? `x${t - 1}_${i}` : null);
      // regular squad
      for (let i = 0; i < n; i++) {
        v(x(i));
        if (transferWeek(t)) {
          v(`b${t}_${i}`); v(`s${t}_${i}`);
          const terms = [[1, x(i)], [-1, `b${t}_${i}`], [1, `s${t}_${i}`]];
          if (t) { terms.push([-1, xPrev(i)]); row(terms, 0, 0); } else row(terms, P[i].owned ? 1 : 0, P[i].owned ? 1 : 0);
          row([[1, `b${t}_${i}`], [1, `s${t}_${i}`]], -Infinity, 1);
          addObj(`b${t}_${i}`, -CHURN);
        } else if (t) row([[1, x(i)], [-1, xPrev(i)]], 0, 0);
        else row([[1, x(i)]], P[i].owned ? 1 : 0, P[i].owned ? 1 : 0);
      }
      squadRules(x);
      if (transferWeek(t)) {
        const bk = v(`bank${t}`, 'C', 0, 1000);
        const terms = [[1, bk]];
        for (let i = 0; i < n; i++) { terms.push([-sellValue(i), `s${t}_${i}`]); terms.push([P[i].price, `b${t}_${i}`]); }
        if (bankPrev) { terms.push([-1, bankPrev]); row(terms, 0, 0); } else row(terms, bank, bank);
        bankPrev = bk;
      }
      // free transfers and hits, only in the first weeks (later weeks have no paid transfers)
      if (t < depth) {
        const f = v(`f${t}`, 'I', 0, MAX_FT);
        if (t === 0) row([[1, f]], ft, ft);
        else {
          const prevFree = has('wildcard', t - 1) || has('freehit', t - 1);
          if (prevFree) row([[1, f], [-1, ftVar]], -Infinity, 0);
          else row([[1, f], [-1, ftVar], [1, `u${t - 1}`]], -Infinity, 1);
        }
        ftVar = f;
        if (!has('wildcard', t) && !has('freehit', t)) {
          const nn = v(`n${t}`, 'I', 0, 15), u = v(`u${t}`, 'I', 0, MAX_FT), h = v(`h${t}`, 'I', 0, 15);
          const terms = [[1, nn]];
          for (let i = 0; i < n; i++) terms.push([-1, `b${t}_${i}`]);
          row(terms, 0, 0);
          row([[1, u], [-1, nn]], -Infinity, 0);
          row([[1, u], [-1, f]], -Infinity, 0);
          row([[1, h], [-1, nn], [1, u]], 0, Infinity);
          addObj(h, -HIT);
        }
      }
      // free hit: a separate squad for this week, paid for with the squad's selling value and the bank
      let sq = x;
      if (has('freehit', t)) {
        const z = (i) => `z${t}_${i}`;
        for (let i = 0; i < n; i++) v(z(i));
        squadRules(z);
        const terms = [];
        for (let i = 0; i < n; i++) {
          terms.push([P[i].price, z(i)]);
          if (t) terms.push([-sellValue(i), xPrev(i)]);
        }
        const fixed = (t ? 0 : P.reduce((a, p, i) => a + (p.owned ? sellValue(i) : 0), 0)) + (bankPrev ? 0 : bank);
        if (bankPrev) terms.push([-1, bankPrev]);
        row(terms, -Infinity, fixed);
        sq = z;
      }
      // starting 11 and captain
      const bb = has('bboost', t), tc = has('3xc', t);
      const yTerms = [], cTerms = [];
      for (let i = 0; i < n; i++) {
        const y = v(`y${t}_${i}`), c = v(`c${t}_${i}`);
        row([[1, y], [-1, sq(i)]], -Infinity, 0);
        row([[1, c], [-1, y]], -Infinity, 0);
        yTerms.push([1, y]); cTerms.push([1, c]);
        const xp = P[i].xp[t];
        const benchW = bb ? 1 : BENCH_W;
        addObj(y, xp * (1 - benchW));
        addObj(sq(i), xp * benchW);
        addObj(c, xp * (tc ? 2 : 1));
      }
      row(yTerms, 11, 11);
      row(cTerms, 1, 1);
      POS.forEach((pos) => row(P.map((p, i) => [p.position === pos ? 1 : 0, `y${t}_${i}`]), XI[pos][0], XI[pos][1]));
    }
    return { vars, obj, rows, depth };

    function squadRules(sq) {
      row(P.map((p, i) => [1, sq(i)]), 15, 15);
      POS.forEach((pos) => row(P.map((p, i) => [p.position === pos ? 1 : 0, sq(i)]), SQUAD[pos], SQUAD[pos]));
      [...new Set(P.map((p) => p.team))].forEach((team) => row(P.map((p, i) => [p.team === team ? 1 : 0, sq(i)]), -Infinity, 3));
    }
  }

  // CPLEX LP text. Long sums are split over several lines.
  function toLP(model) {
    const num = (c) => { const s = Math.abs(c) < 1e-9 ? '0' : String(Math.round(c * 1e6) / 1e6); return s.includes('e') ? Number(c).toFixed(6) : s; };
    const expr = (terms) => {
      const out = [];
      let line = '';
      terms.forEach(([c, name]) => {
        const piece = `${c < 0 ? '-' : '+'} ${num(Math.abs(c))} ${name}`;
        if (line.length + piece.length > 200) { out.push(line); line = ''; }
        line += (line ? ' ' : '') + piece;
      });
      out.push(line || '0 x0_0');
      return out.join('\n  ');
    };
    const lines = ['Maximize', ' obj: ' + expr([...model.obj].map(([name, c]) => [c, name])), 'Subject To'];
    let k = 0;
    model.rows.forEach((r) => {
      if (!r.terms.length) return;
      const e = expr(r.terms);
      if (r.lo === r.hi) lines.push(` r${k++}: ${e} = ${num(r.lo)}`);
      else {
        if (r.lo > -Infinity) lines.push(` r${k++}: ${e} >= ${num(r.lo)}`);
        if (r.hi < Infinity) lines.push(` r${k++}: ${e} <= ${num(r.hi)}`);
      }
    });
    lines.push('Bounds');
    model.vars.forEach((d, name) => { if (d.type !== 'B') lines.push(` ${num(d.lo)} <= ${name} <= ${num(d.hi)}`); });
    const general = [...model.vars].filter(([, d]) => d.type === 'I').map(([name]) => name);
    const binary = [...model.vars].filter(([, d]) => d.type === 'B').map(([name]) => name);
    const list = (names) => { const out = []; for (let i = 0; i < names.length; i += 20) out.push(' ' + names.slice(i, i + 20).join(' ')); return out; };
    if (general.length) lines.push('General', ...list(general));
    if (binary.length) lines.push('Binary', ...list(binary));
    lines.push('End');
    return lines.join('\n') + '\n';
  }

  // Random numbers with a seed, so the same plan always shows the same figures.
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // Expected points of a gameweek team with FPL auto-subs: a starter who does not play is replaced by the first
  // bench player (in order) who plays and keeps a legal formation; the bench goalkeeper only replaces the goalkeeper.
  // If the captain does not play, the vice-captain's points count double (triple with Triple Captain).
  // ps: {position, xp, p1}; xi and bench (bench[0] = goalkeeper) are indexes into ps.
  function expectedWithSubs(ps, xi, bench, cap, vice, mult, benchBoost, sims = 4000) {
    const rand = rng(12345);
    const cond = ps.map((p) => (p.p1 > 0.02 ? p.xp / p.p1 : 0));
    let total = 0;
    const fromSubs = { n: 0 };
    const all = xi.concat(bench);
    for (let s = 0; s < sims; s++) {
      const plays = new Map(all.map((i) => [i, rand() < Math.min(1, Math.max(0, ps[i].p1))]));
      let pts = 0, subPts = 0;
      if (benchBoost) {
        all.forEach((i) => { if (plays.get(i)) pts += cond[i]; });
      } else {
        const on = xi.filter((i) => plays.get(i));
        const count = (list, pos) => list.filter((i) => ps[i].position === pos).length;
        const used = new Set();
        // goalkeeper
        const gk = xi.find((i) => ps[i].position === 'GK');
        if (!plays.get(gk) && bench[0] !== undefined && ps[bench[0]].position === 'GK' && plays.get(bench[0])) { on.push(bench[0]); used.add(bench[0]); subPts += cond[bench[0]]; }
        // outfield, in bench order
        const missing = xi.filter((i) => ps[i].position !== 'GK' && !plays.get(i));
        missing.forEach(() => {
          for (const b of bench.slice(1)) {
            if (used.has(b) || !plays.get(b)) continue;
            const trial = on.concat(b);
            const outfield = trial.filter((i) => ps[i].position !== 'GK');
            if (outfield.length > 10) break;
            // legal if the 10 outfield places can still reach 3 DEF, 2 MID, 1 FWD
            const need = Math.max(0, 3 - count(trial, 'DEF')) + Math.max(0, 2 - count(trial, 'MID')) + Math.max(0, 1 - count(trial, 'FWD'));
            if (need > 10 - outfield.length) continue;
            on.push(b); used.add(b); subPts += cond[b];
            break;
          }
        });
        on.forEach((i) => { pts += cond[i]; });
      }
      const c = plays.get(cap) ? cap : plays.get(vice) ? vice : null;
      if (c !== null) pts += (mult - 1) * cond[c];
      total += pts;
      fromSubs.n += subPts;
    }
    return { xpts: total / sims, subs: fromSubs.n / sims };
  }

  // Bench order (outfield) that gets the most from auto-subs.
  function bestBench(ps, xi, benchOut, gkBench, cap, vice, mult) {
    const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map((r) => [x].concat(r))));
    let best = null;
    perms(benchOut).forEach((order) => {
      const bench = [gkBench].concat(order);
      const r = expectedWithSubs(ps, xi, bench, cap, vice, mult, false, 1500);
      if (!best || r.xpts > best.r.xpts + 1e-9) best = { bench, r };
    });
    return best.bench;
  }

  // Read the solver's values back into a plan. values: {name: value}.
  function decode(input, model, values) {
    const P = input.players, T = input.T, n = P.length;
    const chips = input.chips || {};
    const has = (name, t) => (chips[name] || []).includes(t);
    const val = (name) => Math.round(values[name] || 0);
    const order = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
    const weeks = [];
    let ft = input.ft;
    for (let t = 0; t < T; t++) {
      const fh = has('freehit', t), wc = has('wildcard', t), bb = has('bboost', t), tc = has('3xc', t);
      const squad = [...Array(n).keys()].filter((i) => val(fh ? `z${t}_${i}` : `x${t}_${i}`) === 1);
      const xi = squad.filter((i) => val(`y${t}_${i}`) === 1).sort((a, b) => order[P[a].position] - order[P[b].position] || P[b].xp[t] - P[a].xp[t]);
      const cap = xi.find((i) => val(`c${t}_${i}`) === 1);
      const vice = xi.filter((i) => i !== cap).sort((a, b) => P[b].xp[t] - P[a].xp[t])[0];
      const rest = squad.filter((i) => !xi.includes(i));
      const gkBench = rest.find((i) => P[i].position === 'GK');
      const mult = tc ? 3 : 2;
      const ps = P.map((p) => ({ position: p.position, xp: p.xp[t], p1: p.p1[t] }));
      const bench = bb ? [gkBench].concat(rest.filter((i) => i !== gkBench).sort((a, b) => P[b].xp[t] - P[a].xp[t]))
        : bestBench(ps, xi, rest.filter((i) => i !== gkBench), gkBench, cap, vice, mult);
      const ins = [], outs = [];
      if (fh) {
        const reg = new Set([...Array(n).keys()].filter((i) => val(`x${t}_${i}`) === 1));
        squad.forEach((i) => { if (!reg.has(i)) ins.push(i); });
        reg.forEach((i) => { if (!squad.includes(i)) outs.push(i); });
      } else {
        for (let i = 0; i < n; i++) { if (val(`b${t}_${i}`) === 1) ins.push(i); if (val(`s${t}_${i}`) === 1) outs.push(i); }
      }
      const byPos = (a, b) => order[P[a].position] - order[P[b].position] || P[b].xp[t] - P[a].xp[t];
      ins.sort(byPos); outs.sort(byPos);
      const paid = !fh && !wc && t < model.depth;
      const hits = paid ? Math.max(0, ins.length - ft) : 0;
      const ftNow = ft;
      // a wildcard or free hit keeps the saved transfers but adds none
      if (!fh && !wc) ft = Math.min(MAX_FT, Math.max(ft - (paid ? ins.length : 0), 0) + 1);
      const r = expectedWithSubs(ps, xi, bench, cap, vice, mult, bb);
      const raw = xi.reduce((a, i) => a + P[i].xp[t], 0) + (mult - 1) * P[cap].xp[t] + (bb ? bench.reduce((a, i) => a + P[i].xp[t], 0) : 0);
      weeks.push({
        t, chip: fh ? 'freehit' : wc ? 'wildcard' : bb ? 'bboost' : tc ? '3xc' : null,
        transfersAllowed: t < model.depth || wc || fh,
        freeTransfers: ftNow, hits, bank: values[`bank${t}`] !== undefined ? Math.round(values[`bank${t}`] * 10) / 10 : null,
        xi, bench, cap, vice, ins, outs, mult,
        xpts: r.xpts - HIT * hits, subs: bb ? 0 : r.subs, raw: raw - HIT * hits,
      });
    }
    return weeks;
  }

  const api = { build, toLP, decode, pool, expectedWithSubs, DEPTH, HIT, MAX_FT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PlannerSolve = api;
})(typeof self !== 'undefined' ? self : this);
