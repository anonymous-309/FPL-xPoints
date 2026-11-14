// Free Hit by gameweek: for each gameweek in the data, the best squad for that week alone (within the squad's selling
// value and the bank, at most 3 per club) against the squad as it stands.
const fs = require('fs');
const S = require('../../site/planner-solve.js');
const highsLoader = require('highs');
const entry = process.argv[2], data = JSON.parse(fs.readFileSync(process.argv[3]));
const api = (p) => fetch('https://fantasy.premierleague.com/api/' + p, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.json());
const POS = ['', 'GK', 'DEF', 'MID', 'FWD'];
(async () => {
  const boot = await api('bootstrap-static/'), hist = await api(`entry/${entry}/history/`), tr = await api(`entry/${entry}/transfers/`);
  const last = hist.current.at(-1).event, picks = await api(`entry/${entry}/event/${last}/picks/`);
  const els = new Map(boot.elements.map((e) => [e.id, e]));
  const bank = hist.current.at(-1).bank / 10;
  const bought = new Map(); tr.slice().sort((a, b) => (a.time < b.time ? -1 : 1)).forEach((t) => bought.set(t.element_in, t.element_in_cost));
  const G = data.gws, byId = new Map(data.players.map((p) => [p.id, p]));
  console.log(`FH team ${entry}: gameweeks in data ${G.join(',')}; chips used ${(hist.chips || []).map((c) => c.name + ' GW' + c.event).join(', ') || 'none'}`);
  const squad = picks.picks.map((pk) => { const e = els.get(pk.element), id = 'c' + e.code, now = e.now_cost, paid = bought.has(e.id) ? bought.get(e.id) : now - (e.cost_change_start || 0);
    return { id, name: e.web_name, sell: (now > paid ? paid + Math.floor((now - paid) / 2) : now) / 10, position: POS[e.element_type] }; });
  const owned = new Set(squad.map((p) => p.id));
  const value = squad.reduce((a, p) => a + p.sell, 0) + bank;
  console.log(`selling value + bank: ${value.toFixed(1)}`);
  const rows = [];
  for (let t = 0; t < G.length; t++) {
    const g = G[t];
    const all = data.players.map((d) => { const o = squad.find((p) => p.id === d.id);
      return { id: d.id, name: d.name, team: d.team, position: d.position, price: d.price, owned: !!o, sell: o ? o.sell : undefined, xp: [Math.max(0, d.byGw[g]?.xpts || 0)], p1: [d.byGw[g]?.pApp1 ?? 0] }; });
    squad.forEach((o) => { if (!all.some((p) => p.id === o.id)) all.push({ id: o.id, name: o.name, team: '?', position: o.position, price: o.sell, owned: true, sell: o.sell, xp: [0], p1: [0] }); });
    const P = S.pool(all, [...owned]);
    const solveOne = async (chips) => { const input = { players: P, T: 1, ft: 1, bank, chips, settings: { ...S.DEFAULTS, depth: 1, decay: 1, reserve: [0, 0, 0, 0, 0], minGain: 0, bankValue: 0, maxHits: 0 } };
      const model = S.build(input); const highs = await highsLoader(); const sol = highs.solve(S.toLP(model), { time_limit: 60 });
      const values = Object.fromEntries(Object.entries(sol.Columns).map(([a, c]) => [a, c.Primal])); return { w: S.decode(input, model, values)[0], P }; };
    const hold = await solveOne({});
    const fh = await solveOne({ freehit: [0] });
    const dgw = data.players.filter((d) => (d.byGw[g]?.fixtures || d.byGw[g]?.opp || []).length > 1).length;
    rows.push({ g, hold: hold.w.xpts, fh: fh.w.xpts, gain: fh.w.xpts - hold.w.xpts, xi: fh.w.xi.map((i) => P[i].name) });
  }
  console.log('RESULT');
  rows.forEach((r) => console.log(`GW${r.g}\thold ${r.hold.toFixed(2)}\tFH ${r.fh.toFixed(2)}\tgain ${r.gain.toFixed(2)}\t${r.xi.join(', ')}`));
})();
