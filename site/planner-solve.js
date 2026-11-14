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
    // and no more than a few per position, the best by expected points: keeps the search small enough for a phone
    const CAP = { GK: 6, DEF: 16, MID: 20, FWD: 12 };
    const kept = new Set(ownedIds);
    POS.forEach((pos) => {
      players.filter((p) => p.position === pos && keep.has(p.id) && !owned.has(p.id))
        .sort((a, b) => b.xp.reduce((x, y) => x + y, 0) - a.xp.reduce((x, y) => x + y, 0))
        .slice(0, CAP[pos]).forEach((p) => kept.add(p.id));
    });
    return players.filter((p) => kept.has(p.id));
  }

  // Default settings, as FPL Review's solver.
  // reserve: what each free transfer kept is worth (the 1st kept, 2nd, ... 5th), less for each one more; minGain: the
  // least a transfer must add, in xPts, to be worth making (not for selling a player out for 3+ gameweeks)
  const DEFAULTS = { decay: 0.85, reserve: [3, 2.5, 1.5, 0.5, 0], minGain: 1.5, bankValue: 0.1, maxHits: null, depth: DEPTH };

  // input: {players: [{id, position, team, price, sell (owned only), owned, xp: [T]}], T, ft, bank,
  //         chips: {wildcard: [t], freehit: [t], bboost: [t], '3xc': [t]} (week indexes),
  //         settings: {decay, reserve, minGain, bankValue, maxHits, depth}, keep: [i], avoid: [i] (player indexes),
  //         urgent: [i] (owned players out for 3+ gameweeks: selling them needs no minimum gain),
  //         benchW: [T], benchWgk: [T] (how much of a bench player's points count: the chance he is needed),
  //         fix: [{t, buys, sells, z}] (a week's transfers set exactly), cut: [{t, buys, sells, z}] (a week's
  //         transfers that must not be repeated), roll: [t] (weeks with no transfer)}
  // The search weighs week t by decay^t. Free transfers carried past the last transfer week are worth the reserve
  // values; money left in the bank bankValue per £1m. Points shown to the viewer are never discounted.
  function build(input) {
    const { players: P, T, ft, bank } = input;
    const set = { ...DEFAULTS, ...(input.settings || {}) };
    const depth = Math.max(1, Math.min(set.depth ?? DEPTH, T));
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
    const w = (t) => Math.pow(set.decay, t);
    const keep = new Set(input.keep || []), avoid = new Set(input.avoid || []), urgent = new Set(input.urgent || []);

    const transferWeek = (t) => !has('freehit', t) && (t < depth || has('wildcard', t));
    let bankPrev = null;      // name of the bank variable after the last transfer week, null = starting bank
    let ftVar = null;         // free transfers available this week
    let lastPaid = -1;        // last week with paid transfers
    let firstMove = -1;       // first week the regular squad can change
    for (let t = 0; t < T; t++) {
      const x = (i) => `x${t}_${i}`;
      const xPrev = (i) => (t ? `x${t - 1}_${i}` : null);
      if (transferWeek(t) && firstMove < 0) firstMove = t;
      // regular squad
      for (let i = 0; i < n; i++) {
        v(x(i));
        if (transferWeek(t)) {
          v(`b${t}_${i}`); v(`s${t}_${i}`);
          const terms = [[1, x(i)], [-1, `b${t}_${i}`], [1, `s${t}_${i}`]];
          if (t) { terms.push([-1, xPrev(i)]); row(terms, 0, 0); } else row(terms, P[i].owned ? 1 : 0, P[i].owned ? 1 : 0);
          row([[1, `b${t}_${i}`], [1, `s${t}_${i}`]], -Infinity, 1);
          const paidWeek = !has('wildcard', t);
          // not discounted: putting a transfer off a week must not make it look cheaper
          addObj(`b${t}_${i}`, -(paidWeek ? (input.buyCost && input.buyCost[t] != null ? input.buyCost[t] : set.minGain) : CHURN));
          if (paidWeek && urgent.has(i) && P[i].owned) addObj(`s${t}_${i}`, set.minGain);
        } else if (t) row([[1, x(i)], [-1, xPrev(i)]], 0, 0);
        else row([[1, x(i)]], P[i].owned ? 1 : 0, P[i].owned ? 1 : 0);
        // players the viewer wants kept or left out (an owned one is sold at the first chance)
        if (keep.has(i) && firstMove >= 0) row([[1, x(i)]], 1, 1);
        if (avoid.has(i) && firstMove >= 0) row([[1, x(i)]], 0, 0);
      }
      squadRules(x);
      if (transferWeek(t)) {
        const bk = v(`bank${t}`, 'C', 0, 1000);
        const terms = [[1, bk]];
        for (let i = 0; i < n; i++) { terms.push([-sellValue(i), `s${t}_${i}`]); terms.push([P[i].price, `b${t}_${i}`]); }
        if (bankPrev) { terms.push([-1, bankPrev]); row(terms, 0, 0); } else row(terms, bank, bank);
        bankPrev = bk;
        // transfers the viewer has already made (or wants made) in the first gameweek
        const forced = t === 0 && input.force ? input.force : null;
        if (forced) {
          forced.buys.forEach((i) => { if (!P[i].owned) row([[1, `b0_${i}`]], 1, 1); });
          forced.sells.forEach((i) => { if (P[i].owned) row([[1, `s0_${i}`]], 1, 1); });
        }
        // saving the transfer: no transfers apart from the forced ones
        const forcedN = forced ? Math.max(forced.buys.length, forced.sells.length) : 0;
        if ((input.roll || []).includes(t)) row([...Array(n).keys()].map((i) => [1, `b${t}_${i}`]), -Infinity, forcedN);
      }
      // free transfers and hits, only in the first weeks (later weeks have no paid transfers)
      if (t < depth) {
        const f = v(`f${t}`, 'I', 0, MAX_FT);
        if (t === 0) row([[1, f]], ft, ft);
        else nextFt(f, t - 1);
        ftVar = f;
        if (!has('wildcard', t) && !has('freehit', t)) {
          const nn = v(`n${t}`, 'I', 0, 15), u = v(`u${t}`, 'I', 0, MAX_FT);
          const h = v(`h${t}`, 'I', 0, set.maxHits == null ? 15 : set.maxHits);
          const terms = [[1, nn]];
          for (let i = 0; i < n; i++) terms.push([-1, `b${t}_${i}`]);
          row(terms, 0, 0);
          row([[1, u], [-1, nn]], -Infinity, 0);
          row([[1, u], [-1, f]], -Infinity, 0);
          row([[1, h], [-1, nn], [1, u]], 0, Infinity);
          addObj(h, -HIT * w(t));
          lastPaid = t;
        }
      }
      // free hit: a separate squad for this week, paid for with the squad's selling value and the bank
      let sq = x;
      if (has('freehit', t)) {
        const z = (i) => `z${t}_${i}`;
        for (let i = 0; i < n; i++) {
          v(z(i));
          if (keep.has(i)) row([[1, z(i)]], 1, 1);
          if (avoid.has(i)) row([[1, z(i)]], 0, 0);
        }
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
        const xp = P[i].xp[t] * w(t);
        const bw = P[i].position === 'GK' ? (input.benchWgk || [])[t] : (input.benchW || [])[t];
        const benchW = bb ? 1 : bw ?? BENCH_W;
        addObj(y, xp * (1 - benchW));
        addObj(sq(i), xp * benchW);
        addObj(c, xp * (tc ? 2 : 1));
      }
      row(yTerms, 11, 11);
      row(cTerms, 1, 1);
      POS.forEach((pos) => row(P.map((p, i) => [p.position === pos ? 1 : 0, `y${t}_${i}`]), XI[pos][0], XI[pos][1]));
    }
    // buySteps[t]: the cost of the 1st, 2nd, ... transfer made in week t (each one costing less than the one before)
    (input.buySteps || []).forEach((steps, t) => {
      if (!steps || !transferWeek(t) || has('wildcard', t)) return;
      const zs = steps.map((c, j) => { const z = v(`q${t}_${j}`); addObj(z, -c); return z; });
      row(P.map((p, i) => [1, `b${t}_${i}`]).concat(zs.map((z) => [-1, z])), -Infinity, 0);
      for (let j = 1; j < zs.length; j++) row([[1, zs[j - 1]], [-1, zs[j]]], 0, Infinity);
    });
    // useCost: {x: [cost per week], steps: [m0, m1, ...]}: a transfer that leaves r free transfers in hand costs
    // x[t] * steps[r] (the last free transfer costs the most). Total for week t: x[t] * (V(f) - V(f - u)), V(k) = sum of
    // steps below k.
    if (input.useCost) {
      const m = input.useCost.steps, V = (k) => m.slice(0, k).reduce((a, b) => a + b, 0);
      for (let t = 0; t < depth; t++) {
        const c = input.useCost.x[t];
        if (!c || !vars.has(`u${t}`)) continue;
        const ys = [...Array(MAX_FT + 1).keys()].map((k) => { const y = v(`yf${t}_${k}`); addObj(y, -c * V(k)); return [k, y]; });
        row(ys.map(([, y]) => [1, y]), 1, 1);
        row(ys.map(([k, y]) => [k, y]).concat([[-1, `f${t}`]]), 0, 0);
        const r = v(`rr${t}`, 'C', 0, MAX_FT), R = v(`rv${t}`, 'C', 0, 1000);
        row([[1, r], [-1, `f${t}`], [1, `u${t}`]], 0, 0);
        for (let k = 0; k < MAX_FT; k++) row([[1, R], [-(m[k] || 0), r]], -Infinity, V(k) - (m[k] || 0) * k);
        addObj(R, c);
      }
    }
    // Free transfers carried past the transfer weeks, and money left in the bank, are worth something.
    const reserve = (set.reserve || []).slice(0, MAX_FT);
    if (reserve.some((x) => x > 0) && lastPaid >= 0 && ftVar) {
      // the free transfers still in hand after the last transfer week. (Not those kept this week as well: a plan that
      // saves now and makes the same moves next week would get that value for nothing.)
      const fEnd = v('fend', 'I', 0, MAX_FT);
      nextFt(fEnd, depth - 1);
      reserveValue('rend', [[1, fEnd]], w(depth) * (input.ftMult ?? 1));
    }
    if (input.bankSteps && bankPrev) {
      // money left after the last transfer week, each £0.1m worth less than the one before (bankSteps: [width £m,
      // points per £1m]): the least of the lines through the steps
      const B = v('bankv', 'C', 0, 1000);
      let start = 0, cum = 0;
      input.bankSteps.concat([[1000, 0]]).forEach(([width, slope]) => {
        row([[1, B], [-slope, bankPrev]], -Infinity, cum - slope * start);
        cum += slope * width; start += width;
      });
      addObj(B, w(depth) * (input.bankMult ?? 1));
    } else if (set.bankValue && bankPrev) addObj(bankPrev, set.bankValue * w(depth));
    // only these players may be bought or sold (the route to a target squad)
    if (input.allowBuy || input.allowSell) {
      const okBuy = new Set(input.allowBuy || []), okSell = new Set(input.allowSell || []);
      vars.forEach((d, name) => {
        const m = /^([bs])(\d+)_(\d+)$/.exec(name);
        if (!m) return;
        const i = Number(m[3]);
        if ((m[1] === 'b' && input.allowBuy && !okBuy.has(i)) || (m[1] === 's' && input.allowSell && !okSell.has(i))) row([[1, name]], 0, 0);
      });
    }
    // a branch: some weeks' transfers fixed, some excluded
    (input.fix || []).forEach((o) => {
      if (o.z) { for (let i = 0; i < n; i++) row([[1, `z${o.t}_${i}`]], o.z.includes(i) ? 1 : 0, o.z.includes(i) ? 1 : 0); return; }
      if (!vars.has(`b${o.t}_0`)) return;
      for (let i = 0; i < n; i++) {
        row([[1, `b${o.t}_${i}`]], o.buys.includes(i) ? 1 : 0, o.buys.includes(i) ? 1 : 0);
        row([[1, `s${o.t}_${i}`]], o.sells.includes(i) ? 1 : 0, o.sells.includes(i) ? 1 : 0);
      }
    });
    // an exact number of transfers in a gameweek
    (input.count || []).forEach(({ t, n: k }) => {
      if (!vars.has(`b${t}_0`)) return;
      row([...Array(n).keys()].map((i) => [1, `b${t}_${i}`]), k, k);
    });
    (input.cut || []).forEach((o) => {
      // at least one of these variables must differ from this option
      const on = o.z ? o.z.map((i) => `z${o.t}_${i}`) : o.buys.map((i) => `b${o.t}_${i}`).concat(o.sells.map((i) => `s${o.t}_${i}`));
      const all = o.z ? [...Array(n).keys()].map((i) => `z${o.t}_${i}`) : [...Array(n).keys()].flatMap((i) => [`b${o.t}_${i}`, `s${o.t}_${i}`]);
      if (!vars.has(all[0])) return;
      const onSet = new Set(on);
      row(all.map((name) => [onSet.has(name) ? 1 : -1, name]), -Infinity, on.length - 1);
    });
    return { vars, obj, rows, depth, settings: set };

    // value of k free transfers kept (expr), each one worth less than the one before: the least of the lines through
    // the steps of the reserve list, which the search pushes up to the true value
    function reserveValue(name, expr, weight) {
      const R = v(name, 'C', 0, 1000);
      let cum = 0;
      for (let k = 0; k < MAX_FT; k++) {
        const slope = reserve[k] || 0;
        // R <= cum + slope * (expr - k)
        row([[1, R]].concat(expr.map(([c, x]) => [-slope * c, x])), -Infinity, cum - slope * k);
        cum += slope;
      }
      addObj(R, weight);
    }

    // free transfers next week: +1 up to 5 after a normal week, unchanged after a wildcard or free hit
    function nextFt(fNext, tPrev) {
      const prevFree = has('wildcard', tPrev) || has('freehit', tPrev);
      if (prevFree) row([[1, fNext], [-1, `f${tPrev}`]], -Infinity, 0);
      else row([[1, fNext], [-1, `f${tPrev}`], [1, `u${tPrev}`]], -Infinity, 1);
    }

    function squadRules(sq) {
      row(P.map((p, i) => [1, sq(i)]), 15, 15);
      POS.forEach((pos) => row(P.map((p, i) => [p.position === pos ? 1 : 0, sq(i)]), SQUAD[pos], SQUAD[pos]));
      [...new Set(P.map((p) => p.team))].forEach((team) => row(P.map((p, i) => [p.team === team ? 1 : 0, sq(i)]), -Infinity, 3));
    }
  }

  // One week's transfers in a solution: what a branch is fixed or cut on.
  function option(input, values, t) {
    const fh = (input.chips && input.chips.freehit || []).includes(t);
    const on = (name) => Math.round(values[name] || 0) === 1;
    const idx = [...Array(input.players.length).keys()];
    if (fh) return { t, z: idx.filter((i) => on(`z${t}_${i}`)) };
    return { t, buys: idx.filter((i) => on(`b${t}_${i}`)), sells: idx.filter((i) => on(`s${t}_${i}`)) };
  }
  const sameOption = (a, b) => JSON.stringify(a.z || [a.buys, a.sells]) === JSON.stringify(b.z || [b.buys, b.sells]);

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

  // ---- Simulation: how often each option comes out on top ----
  const GOAL_PTS = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
  const CS_PTS = { GK: 4, DEF: 4, MID: 1, FWD: 0 };

  function poisson(lambda, rand) {
    if (lambda <= 0) return 0;
    const L = Math.exp(-Math.min(lambda, 30));
    let k = 0, p = 1;
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  }

  // Points of one gameweek team in one scenario, with FPL auto-subs and the vice-captain rule.
  function scoreWeek(pos, wk, played, pts) {
    const all = wk.xi.concat(wk.bench);
    let total = 0;
    if (wk.bb) all.forEach((i) => { if (played(i)) total += pts(i); });
    else {
      const on = wk.xi.filter((i) => played(i));
      const count = (list, p) => list.filter((i) => pos[i] === p).length;
      const used = new Set();
      const gk = wk.xi.find((i) => pos[i] === 'GK');
      const bgk = wk.bench[0];
      if (!played(gk) && bgk !== undefined && pos[bgk] === 'GK' && played(bgk)) { on.push(bgk); used.add(bgk); }
      wk.xi.filter((i) => pos[i] !== 'GK' && !played(i)).forEach(() => {
        for (const b of wk.bench.slice(1)) {
          if (used.has(b) || !played(b)) continue;
          const trial = on.concat(b);
          const outfield = trial.filter((i) => pos[i] !== 'GK').length;
          if (outfield > 10) break;
          const need = Math.max(0, 3 - count(trial, 'DEF')) + Math.max(0, 2 - count(trial, 'MID')) + Math.max(0, 1 - count(trial, 'FWD'));
          if (need > 10 - outfield) continue;
          on.push(b); used.add(b);
          break;
        }
      });
      on.forEach((i) => { total += pts(i); });
    }
    const c = played(wk.cap) ? wk.cap : played(wk.vice) ? wk.vice : null;
    if (c !== null) total += (wk.mult - 1) * pts(c);
    return total - HIT * (wk.hits || 0);
  }

  // Scenarios shared by every option: each player's minutes, each team's goals in each match (so team-mates share
  // clean sheets and a striker's goals are the other side's goals conceded), then goals and assists shared out in
  // line with each player's figures, plus saves, DefCon, bonus and cards. Each player's average is lined up with his
  // xPts, so the options keep the points shown; only the spread comes from the simulation.
  // sim: {T, players: [{position, xp: [T], weeks: [[match]]}], lambda: Map('fixture|team' -> expected goals),
  //       paths: [[{xi, bench, cap, vice, mult, bb, hits}]], sims, seed}
  // match: {fx, team, opp, fixed (minutes set by the viewer, or null), p1, p60, mins, g, a, saves, ps, pm, og, y, r, dc, bonus}
  // Returns per path the points of every scenario: total over the plan and each gameweek's.
  function simulate(sim) {
    const rand = rng(sim.seed || 2024);
    const N = sim.sims || 5000, T = sim.T, players = sim.players;
    const pos = players.map((p) => p.position);
    const pts = players.map(() => Array.from({ length: T }, () => new Float32Array(N)));
    const played = players.map(() => Array.from({ length: T }, () => new Uint8Array(N)));
    const lam = (fx, team) => sim.lambda.get(`${fx}|${team}`) ?? 1.3;
    for (let s = 0; s < N; s++) {
      const goals = new Map();
      const teamGoals = (fx, team) => { const k = `${fx}|${team}`; if (!goals.has(k)) goals.set(k, poisson(lam(fx, team), rand)); return goals.get(k); };
      players.forEach((p, i) => {
        for (let t = 0; t < T; t++) {
          let total = 0, any = 0;
          (p.weeks[t] || []).forEach((m) => {
            let mins;
            if (m.fixed != null) mins = m.fixed;
            else {
              const u = rand();
              const sub = Math.max(5, Math.min(59, m.p1 > m.p60 ? (m.mins - m.p60 * 88) / (m.p1 - m.p60) : 30));
              mins = u < m.p60 ? 88 : u < m.p1 ? sub : 0;
            }
            if (mins <= 0) return;
            any = 1;
            const w = Math.min(90, mins) / 90;
            total += 1 + (mins >= 60 ? 1 : 0);
            const G = teamGoals(m.fx, m.team), GA = teamGoals(m.fx, m.opp), L = Math.max(lam(m.fx, m.team), 0.05);
            const sg = Math.min(0.95, (m.g * w) / L), sa = Math.min(0.9, (m.a * w) / L);
            for (let k = 0; k < G; k++) {
              if (rand() < sg) total += GOAL_PTS[p.position];
              if (rand() < sa) total += 3;
            }
            if (mins >= 60) {
              if (GA === 0) total += CS_PTS[p.position];
              if (p.position === 'GK' || p.position === 'DEF') total -= Math.floor(GA / 2);
            }
            if (p.position === 'GK') {
              total += Math.floor(poisson(m.saves * w, rand) / 3);
              if (rand() < m.ps * w) total += 5;
            } else if (rand() < m.dc * w) total += 2;
            total += Math.min(3, poisson(m.bonus * w, rand));
            if (rand() < m.y * w) total -= 1;
            if (rand() < m.r * w) total -= 3;
            if (rand() < m.og * w) total -= 2;
            if (rand() < m.pm * w) total -= 2;
          });
          pts[i][t][s] = total;
          played[i][t][s] = any;
        }
      });
    }
    // line each player's average up with his xPts
    players.forEach((p, i) => {
      for (let t = 0; t < T; t++) {
        const a = pts[i][t];
        let mean = 0;
        for (let s = 0; s < N; s++) mean += a[s];
        mean /= N;
        const target = p.xp[t];
        if (mean > 0.05 && target > 0) { const k = Math.max(0.5, Math.min(2, target / mean)); for (let s = 0; s < N; s++) a[s] *= k; }
      }
    });
    return sim.paths.map((path) => {
      const total = new Float32Array(N), week = path.map(() => new Float32Array(N));
      for (let s = 0; s < N; s++) {
        path.forEach((wk, t) => {
          const v = scoreWeek(pos, wk, (i) => played[i][t][s] === 1, (i) => pts[i][t][s]);
          total[s] += v;
          week[t][s] = v;
        });
      }
      return { total, week };
    });
  }

  const api = { build, toLP, decode, pool, expectedWithSubs, option, sameOption, simulate, DEPTH, HIT, MAX_FT, DEFAULTS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PlannerSolve = api;
})(typeof self !== 'undefined' ? self : this);
