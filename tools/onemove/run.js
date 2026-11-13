// One-transfer check for a team: every legal single transfer and its gain in expected points for the coming gameweek.
const fs = require('fs');
const S = require('../../site/planner-solve.js');
const entry = process.argv[2], data = JSON.parse(fs.readFileSync(process.argv[3]));
const api = (p) => fetch('https://fantasy.premierleague.com/api/' + p, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.json());
const POS = ['', 'GK', 'DEF', 'MID', 'FWD'];
(async () => {
  const boot = await api('bootstrap-static/'), hist = await api(`entry/${entry}/history/`), tr = await api(`entry/${entry}/transfers/`);
  const last = hist.current.at(-1).event;
  const picks = await api(`entry/${entry}/event/${last}/picks/`);
  const els = new Map(boot.elements.map((e) => [e.id, e]));
  const bank = hist.current.at(-1).bank / 10;
  const bought = new Map(); tr.slice().sort((a, b) => (a.time < b.time ? -1 : 1)).forEach((t) => bought.set(t.element_in, t.element_in_cost));
  const g = data.gws[0];
  const byId = new Map(data.players.map((p) => [p.id, p]));
  const G8 = data.gws.slice(0, 8);
  const info = (p) => ({ id: p.id, name: p.name, team: p.team, position: p.position, price: p.price, xp: Math.max(0, p.byGw[g]?.xpts || 0), p1: p.byGw[g]?.pApp1 ?? 0,
    xpw: G8.map((x) => Math.max(0, p.byGw[x]?.xpts || 0)), p1w: G8.map((x) => p.byGw[x]?.pApp1 ?? 0),
    xp8: data.gws.slice(0, 8).reduce((a, x) => a + Math.max(0, p.byGw[x]?.xpts || 0), 0) });
  const squad = picks.picks.map((pk) => {
    const e = els.get(pk.element), id = 'c' + e.code, now = e.now_cost, paid = bought.has(e.id) ? bought.get(e.id) : now - (e.cost_change_start || 0);
    const sell = (now > paid ? paid + Math.floor((now - paid) / 2) : now) / 10;
    const d = byId.get(id);
    return { ...(d ? info(d) : { id, name: e.web_name, team: '?', position: POS[e.element_type], price: now / 10, xp: 0, p1: 0, xp8: 0, xpw: G8.map(() => 0), p1w: G8.map(() => 0) }), sell };
  });
  const scoreW = (sq, t) => score(sq.map((p) => ({ ...p, xp: p.xpw[t], p1: p.p1w[t] })));
  const long = (sq) => { let raw = 0, dec = 0; G8.forEach((x, t) => { const v = scoreW(sq, t); raw += v; dec += Math.pow(0.85, t) * v; }); return { raw, dec }; };
  const score = (sq) => {
    let best = null;
    const by = (pos) => sq.map((p, i) => i).filter((i) => sq[i].position === pos).sort((a, b) => sq[b].xp - sq[a].xp);
    const gk = by('GK'), de = by('DEF'), mi = by('MID'), fw = by('FWD');
    for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) { const f = 10 - d - m; if (f < 1 || f > 3) continue;
      const xi = [gk[0], ...de.slice(0, d), ...mi.slice(0, m), ...fw.slice(0, f)]; const s = xi.reduce((a, i) => a + sq[i].xp, 0);
      if (!best || s > best.s) best = { s, xi }; }
    const xi = best.xi, rest = sq.map((p, i) => i).filter((i) => !xi.includes(i));
    const bgk = rest.find((i) => sq[i].position === 'GK');
    const bench = [bgk].concat(rest.filter((i) => i !== bgk).sort((a, b) => sq[b].xp - sq[a].xp));
    const byXp = xi.slice().sort((a, b) => sq[b].xp - sq[a].xp);
    return S.expectedWithSubs(sq.map((p) => ({ position: p.position, xp: p.xp, p1: p.p1 })), xi, bench, byXp[0], byXp[1], 2, false, 1500).xpts;
  };
  const base = score(squad);
  const clubs = {}; squad.forEach((p) => { clubs[p.team] = (clubs[p.team] || 0) + 1; });
  const owned = new Set(squad.map((p) => p.id));
  console.log(`team ${entry} GW${g}: bank ${bank}, base ${base.toFixed(2)}`);
  squad.forEach((p) => console.log(`  ${p.position} ${p.name} (${p.team}) ${p.price} sell ${p.sell} xp ${p.xp.toFixed(2)} p1 ${p.p1.toFixed(2)}`));
  const L0 = long(squad);
  console.log(`8GW GW${G8[0]}-${G8.at(-1)} base raw ${L0.raw.toFixed(1)} decayed ${L0.dec.toFixed(1)}`);
  const res = [];
  squad.forEach((o, k) => data.players.forEach((d) => {
    if (owned.has(d.id) || d.position !== o.position || d.price > o.sell + bank + 1e-9) return;
    if (d.team !== o.team && (clubs[d.team] || 0) >= 3) return;
    const n = info(d); const sq = squad.slice(); sq[k] = n;
    const gain = score(sq) - base;
    if (n.xp8 - o.xp8 < 2) return;
    const L = long(sq);
    res.push({ raw8: L.raw - L0.raw, dec8: L.dec - L0.dec, out: o.name, in: `${n.name} (${n.team}) ${n.price}`, gain, d8: n.xp8 - o.xp8, bank: +(o.sell + bank - n.price).toFixed(1) });
  }));
  res.sort((a, b) => b.dec8 - a.dec8);
  console.log('RESULTS');
  res.slice(0, 30).forEach((r) => console.log(`dec ${r.dec8.toFixed(2)}\traw ${r.raw8.toFixed(2)}\tGW1 ${r.gain.toFixed(2)}\t${r.out} -> ${r.in}\t8GW raw diff ${r.d8.toFixed(1)}\tITB ${r.bank}`));
})();
