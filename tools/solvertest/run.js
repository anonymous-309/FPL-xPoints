// Solve the planner's plans for a team with the real HiGHS (as the site does) and report every failure.
// node tools/solvertest/run.js <team id> <data.json>
const fs = require('fs');
const S = require('../../site/planner-solve.js');
const highsLoader = require('highs');
const entry = process.argv[2], data = JSON.parse(fs.readFileSync(process.argv[3]));
const api = (p) => fetch('https://fantasy.premierleague.com/api/' + p, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.json());
(async () => {
  const boot = await api('bootstrap-static/'), hist = await api(`entry/${entry}/history/`);
  const last = hist.current.at(-1).event;
  const picks = await api(`entry/${entry}/event/${last}/picks/`);
  const els = new Map(boot.elements.map((e) => [e.id, e]));
  let ft = 1; hist.current.forEach((e) => { if (e.event > 1) ft = Math.min(5, Math.max(ft - e.event_transfers, 0) + 1); });
  const bank = hist.current.at(-1).bank / 10;
  const own = new Map(picks.picks.map((p) => { const e = els.get(p.element); return ['c' + e.code, e.now_cost / 10]; }));
  const T = 8, depth = 3, gws = data.gws.slice(0, T);
  const all = data.players.map((p) => ({ id: p.id, name: p.name, team: p.team, position: p.position, price: p.price, owned: own.has(p.id), sell: own.get(p.id),
    xp: gws.map((g) => Math.max(0, p.byGw[g]?.xpts || 0)), p1: gws.map((g) => p.byGw[g]?.pApp1 ?? 0) }));
  own.forEach((price, id) => { if (!all.some((p) => p.id === id)) { const e = boot.elements.find((x) => 'c' + x.code === id); all.push({ id, name: e.web_name, team: String(e.team), position: ['', 'GK', 'DEF', 'MID', 'FWD'][e.element_type], price, owned: true, sell: price, xp: gws.map(() => 0), p1: gws.map(() => 0) }); } });
  const P = S.pool(all, [...own.keys()]);
  const Pm = P.map((p) => ({ ...p, xp: p.xp.slice(0, depth).concat([p.xp.slice(depth).reduce((a, x, j) => a + Math.pow(0.85, j) * x, 0)]), p1: p.p1.slice(0, depth + 1) }));
  console.log(`team ${entry}: ${ft} FT, bank ${bank}, pool ${P.length}`);
  const base = { players: Pm, T: depth + 1, ft, bank, chips: {}, settings: { depth, decay: 0.85, reserve: [0, 0, 0, 0, 0], minGain: 0, bankValue: 0, maxHits: null } };
  const per = (k) => (ft >= 4 ? (k === 2 || k === 3 ? 2 : 1) : ft === 3 ? 2 : 3);
  const groups = []; for (let k = Math.max(ft, 1); k > 0; k--) groups.push({ k, n: per(k) }); groups.push({ k: 0, n: 1 });
  const tries = [{ time_limit: 25, mip_rel_gap: 0.001, presolve: 'on' }];
  for (const g of groups) {
    const cuts = [];
    for (let r = 0; r < g.n; r++) {
      const input = { ...base, count: [{ t: 0, n: g.k }], cut: cuts.slice() };
      const lp = S.toLP(S.build(input));
      const results = [];
      let values = null;
      for (const o of tries) {
        const t0 = Date.now();
        try {
          const highs = await highsLoader();
          const sol = highs.solve(lp, o);
          results.push(`${JSON.stringify(o)} -> ${sol.Status} ${sol.ObjectiveValue?.toFixed(2)} ${(Date.now() - t0) / 1000}s`);
          if (!values) values = Object.fromEntries(Object.entries(sol.Columns).map(([k, v]) => [k, v.Primal]));
        } catch (e) { results.push(`${JSON.stringify(o)} -> ERROR ${String(e.message || e).slice(0, 80)} ${(Date.now() - t0) / 1000}s`); }
      }
      console.log(`k=${g.k} #${r + 1} lp ${lp.length} chars\n  ` + results.join('\n  '));
      if (values) cuts.push(S.option(input, values, 0));
    }
  }
})();
