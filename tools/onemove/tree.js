// Two-level transfer tree for a team: GW1 options by number of FT used, then the same search one gameweek later
// for the best GW1 choices. Each FT used costs FTV points; money left counts 1 point per £1m.
const fs = require('fs');
const S = require('../../site/planner-solve.js');
const highsLoader = require('highs');
const entry = process.argv[2], data = JSON.parse(fs.readFileSync(process.argv[3]));
const FTV = 0, DEC = 0.85, PER = 1;
const api = (p) => fetch('https://fantasy.premierleague.com/api/' + p, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.json());
const POS = ['', 'GK', 'DEF', 'MID', 'FWD'];
(async () => {
  const boot = await api('bootstrap-static/'), hist = await api(`entry/${entry}/history/`), tr = await api(`entry/${entry}/transfers/`);
  const last = hist.current.at(-1).event;
  const picks = await api(`entry/${entry}/event/${last}/picks/`);
  const els = new Map(boot.elements.map((e) => [e.id, e]));
  const chips = new Map((hist.chips || []).map((c) => [c.event, c.name]));
  let ft = 1; hist.current.forEach((e) => { if (e.event === 1 || ['wildcard', 'freehit'].includes(chips.get(e.event))) return; ft = Math.min(5, Math.max(ft - e.event_transfers, 0) + 1); });
  const bank = hist.current.at(-1).bank / 10;
  const bought = new Map(); tr.slice().sort((a, b) => (a.time < b.time ? -1 : 1)).forEach((t) => bought.set(t.element_in, t.element_in_cost));
  const G = data.gws.slice(0, 8), byId = new Map(data.players.map((p) => [p.id, p]));
  const info = (p) => ({ id: p.id, name: p.name, team: p.team, position: p.position, price: p.price, sell: p.price,
    xpw: G.map((x) => Math.max(0, p.byGw[x]?.xpts || 0)), p1w: G.map((x) => p.byGw[x]?.pApp1 ?? 0) });
  const squad0 = picks.picks.map((pk) => {
    const e = els.get(pk.element), id = 'c' + e.code, now = e.now_cost, paid = bought.has(e.id) ? bought.get(e.id) : now - (e.cost_change_start || 0);
    const d = byId.get(id);
    const base = d ? info(d) : { id, name: e.web_name, team: '?', position: POS[e.element_type], price: now / 10, xpw: G.map(() => 0), p1w: G.map(() => 0) };
    return { ...base, sell: (now > paid ? paid + Math.floor((now - paid) / 2) : now) / 10 };
  });
  // a week's points for a squad: best XI and captain, auto-subs
  const week = (sq, t) => {
    const ps = sq.map((p) => ({ position: p.position, xp: p.xpw[t], p1: p.p1w[t] }));
    const by = (pos) => sq.map((p, i) => i).filter((i) => sq[i].position === pos).sort((a, b) => ps[b].xp - ps[a].xp);
    const gk = by('GK'), de = by('DEF'), mi = by('MID'), fw = by('FWD'); let best = null;
    for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) { const f = 10 - d - m; if (f < 1 || f > 3) continue;
      const xi = [gk[0], ...de.slice(0, d), ...mi.slice(0, m), ...fw.slice(0, f)]; const s = xi.reduce((a, i) => a + ps[i].xp, 0); if (!best || s > best.s) best = { s, xi }; }
    const rest = sq.map((p, i) => i).filter((i) => !best.xi.includes(i)), bg = rest.find((i) => sq[i].position === 'GK');
    const bench = [bg].concat(rest.filter((i) => i !== bg).sort((a, b) => ps[b].xp - ps[a].xp));
    const byXp = best.xi.slice().sort((a, b) => ps[b].xp - ps[a].xp);
    return S.expectedWithSubs(ps, best.xi, bench, byXp[0], byXp[1], 2, false, 1500).xpts;
  };
  const from = (sq, t0) => { let raw = 0, dec = 0; for (let t = t0; t < G.length; t++) { const v = week(sq, t); raw += v; dec += Math.pow(DEC, t - t0) * v; } return { raw, dec }; };
  let solves = 0, secs = 0;
  // every good choice for a squad state at week t0
  async function decide(st) {
    const owned = new Set(st.squad.map((p) => p.id));
    const all = data.players.map((d) => { const n = info(d); const o = st.squad.find((p) => p.id === d.id);
      return { id: d.id, name: d.name, team: d.team, position: d.position, price: d.price, owned: !!o, sell: o ? o.sell : undefined, xp: n.xpw.slice(st.t), p1: n.p1w.slice(st.t) }; });
    st.squad.forEach((o) => { if (!all.some((p) => p.id === o.id)) all.push({ id: o.id, name: o.name, team: o.team, position: o.position, price: o.price, owned: true, sell: o.sell, xp: o.xpw.slice(st.t), p1: o.p1w.slice(st.t) }); });
    const P = S.pool(all, [...owned]);
    const hold = from(st.squad, st.t);
    const base = { players: P, T: G.length - st.t, ft: st.ft, bank: st.bank, chips: {}, settings: { ...S.DEFAULTS, depth: 1, decay: DEC, reserve: [0, 0, 0, 0, 0], minGain: FTV, bankValue: 0, maxHits: null } };
    const out = [];
    for (let k = 0; k <= st.ft; k++) {
      const cuts = [];
      for (let r = 0; r < (k ? PER : 1); r++) {
        const input = { ...base, count: [{ t: 0, n: k }], cut: cuts.slice() };
        const t0 = Date.now(); const highs = await highsLoader();
        const sol = highs.solve(S.toLP(S.build(input)), { time_limit: 60, mip_rel_gap: 0.0005 });
        solves++; secs += (Date.now() - t0) / 1000;
        if (!/optimal|time/i.test(sol.Status)) break;
        const values = Object.fromEntries(Object.entries(sol.Columns).map(([a, c]) => [a, c.Primal]));
        const opt = S.option(input, values, 0); cuts.push(opt);
        const sq = st.squad.slice(), used = new Set(), moves = [];
        opt.sells.forEach((si) => { const j = sq.findIndex((p) => p.id === P[si].id); const bi = opt.buys.find((b) => !used.has(b) && P[b].position === P[si].position); used.add(bi);
          moves.push(`${sq[j].name} -> ${P[bi].name} (${P[bi].team}) ${P[bi].price}`); sq[j] = info(byId.get(P[bi].id)); });
        const bankAfter = Math.round((st.bank + opt.sells.reduce((a, x) => a + P[x].sell, 0) - opt.buys.reduce((a, b) => a + P[b].price, 0)) * 10) / 10;
        const L = from(sq, st.t);
        out.push({ k, moves: moves.length ? moves.join(' + ') : 'Save', squad: sq, bank: bankAfter, ft: Math.min(5, st.ft - k + 1), t: st.t + 1,
          dec: L.dec - hold.dec, raw: L.raw - hold.raw, itb: bankAfter - st.bank, score: L.dec - hold.dec });
      }
    }
    return out;
  }
  const show = (o, pad) => console.log(`${pad}${o.score >= 0 ? '+' : ''}${o.score.toFixed(2)}\t[${o.k}FT dec ${o.dec.toFixed(2)} raw ${o.raw.toFixed(2)} ITB ${o.bank} (${o.itb >= 0 ? '+' : ''}${o.itb.toFixed(1)})]\t${o.moves}`);
  // ---- one model for GW1-3: GW1 transfers fixed in number, GW2 and GW3 free; each FT left at the end worth FTEND
  const X = 0.5, Y = 2.89, STEP = [1, 0.75, 0.5, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], RES = STEP.slice(0, 5).map((m) => m * Y), D = 3;
  const keptValue = (n) => RES.slice(0, n).reduce((a, b) => a + b, 0);
  const owned = new Set(squad0.map((p) => p.id));
  const all = data.players.map((d) => { const n = info(d); const o = squad0.find((p) => p.id === d.id);
    return { id: d.id, name: d.name, team: d.team, position: d.position, price: d.price, owned: !!o, sell: o ? o.sell : undefined, xp: n.xpw, p1: n.p1w }; });
  squad0.forEach((o) => { if (!all.some((p) => p.id === o.id)) all.push({ id: o.id, name: o.name, team: o.team, position: o.position, price: o.price, owned: true, sell: o.sell, xp: o.xpw, p1: o.p1w }); });
  const P = S.pool(all, [...owned]);
  const hold = from(squad0, 0);
  const base = { players: P, T: G.length, ft, bank, chips: {}, ftMult: 1 / Math.pow(DEC, D), buyCost: [0, 0, 0], buySteps: [STEP.map((m) => 2 * X * m), STEP.map((m) => X * m)],
    settings: { ...S.DEFAULTS, depth: D, decay: DEC, reserve: RES, minGain: 0, bankValue: 0, maxHits: 0 } };
  console.log(`TREE team ${entry}: ${ft} FT, bank ${bank}; GW${G[0]}-${G[D - 1]} planned in one model, early cost per transfer (1st, 2nd, ...) GW${G[0]} ${STEP.slice(0,5).map((m) => (2 * X * m).toFixed(2)).join('/')}, GW${G[1]} ${STEP.slice(0,5).map((m) => (X * m).toFixed(2)).join('/')}, GW${G[2]} 0, FT left after GW${G[D - 1]} worth ${RES.map((x) => x.toFixed(2)).join('/')}, no hits, xP GW${G[0]}-${G.at(-1)} decayed`);
  const T0 = Date.now(), res = [];
  for (const k of [0, 1, 2, 3, 4, null]) {
    if (k !== null && k > ft) continue;
    const input = { ...base, ...(k === null ? {} : { count: [{ t: 0, n: k }] }) };
    const model = S.build(input);
    const t0 = Date.now(); const highs = await highsLoader();
    const sol = highs.solve(S.toLP(model), { time_limit: 120, mip_rel_gap: 0.0005 });
    const secs1 = (Date.now() - t0) / 1000;
    const values = Object.fromEntries(Object.entries(sol.Columns).map(([a, c]) => [a, c.Primal]));
    const weeks = S.decode(input, model, values);
    let dec = 0, raw = 0, ftNow = ft, used = [];
    const lines = [];
    weeks.forEach((w, t) => {
      const sq = w.xi.concat(w.bench).map((i) => (byId.has(P[i].id) ? info(byId.get(P[i].id)) : squad0.find((p) => p.id === P[i].id)));
      const v = week(sq, t); raw += v; dec += Math.pow(DEC, t) * v;
      if (t < D) { used.push(w.ins.length); lines.push(`    GW${G[t]} (${w.freeTransfers} FT): ` + (w.ins.length ? w.outs.map((o, m) => `${P[o].name} -> ${P[w.ins[m]].name} (${P[w.ins[m]].team}) ${P[w.ins[m]].price}`).join(' + ') : 'Save') + `, bank ${w.bank}`); }
    });
    const left = weeks[D] ? weeks[D].freeTransfers : null;
    const early = STEP.slice(0, used[0]).reduce((a, m) => a + 2 * X * m, 0) + STEP.slice(0, used[1]).reduce((a, m) => a + X * m, 0);
    res.push({ k, early, dec: dec - hold.dec, raw: raw - hold.raw, left, total: dec - hold.dec - early + keptValue(left || 0), used, lines, secs1, status: sol.Status });
  }
  res.forEach((r) => { console.log(`\n${r.k === null ? 'FREE (solver picks GW' + G[0] + ')' : 'GW' + G[0] + ' ' + r.k + 'FT'}: total ${r.total.toFixed(2)} = dec ${r.dec.toFixed(2)} - early ${r.early.toFixed(2)} + kept ${keptValue(r.left || 0).toFixed(2)} (${r.left} FT left) (raw ${r.raw.toFixed(2)}), FT used ${r.used.join('-')}, ${r.secs1}s ${r.status}`); r.lines.forEach((l) => console.log(l)); });
  console.log(`\nall: ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  console.log(`\n${solves} solves, ${secs.toFixed(1)}s solving`);
})();
