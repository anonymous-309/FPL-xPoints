// GW1 transfer sets (1-4 FT) that pass: GW1 gain > 0, decayed gain > 0, decayed gain + money change > 4 x FT used.
const fs = require('fs');
const S = require('../../site/planner-solve.js');
const entry = process.argv[2], data = JSON.parse(fs.readFileSync(process.argv[3]));
const FTV = 4, DEC = 0.85;
const api = (p) => fetch('https://fantasy.premierleague.com/api/' + p, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.json());
const POS = ['', 'GK', 'DEF', 'MID', 'FWD'];
(async () => {
  const boot = await api('bootstrap-static/'), hist = await api(`entry/${entry}/history/`), tr = await api(`entry/${entry}/transfers/`);
  const last = hist.current.at(-1).event, picks = await api(`entry/${entry}/event/${last}/picks/`);
  const els = new Map(boot.elements.map((e) => [e.id, e]));
  const bank = hist.current.at(-1).bank / 10;
  const bought = new Map(); tr.slice().sort((a, b) => (a.time < b.time ? -1 : 1)).forEach((t) => bought.set(t.element_in, t.element_in_cost));
  const G = data.gws.slice(0, 8), byId = new Map(data.players.map((p) => [p.id, p]));
  const info = (p) => ({ id: p.id, name: p.name, team: p.team, position: p.position, price: p.price, xpw: G.map((x) => Math.max(0, p.byGw[x]?.xpts || 0)), p1w: G.map((x) => p.byGw[x]?.pApp1 ?? 0) });
  const squad = picks.picks.map((pk) => { const e = els.get(pk.element), id = 'c' + e.code, now = e.now_cost, paid = bought.has(e.id) ? bought.get(e.id) : now - (e.cost_change_start || 0);
    const d = byId.get(id); const b = d ? info(d) : { id, name: e.web_name, team: '?', position: POS[e.element_type], price: now / 10, xpw: G.map(() => 0), p1w: G.map(() => 0) };
    return { ...b, sell: (now > paid ? paid + Math.floor((now - paid) / 2) : now) / 10 }; });
  // quick week score: best XI + captain (every likely starter here is a sure starter, so auto-subs add nothing)
  const wk = (sq, t) => { const by = (pos) => sq.filter((p) => p.position === pos).map((p) => p.xpw[t]).sort((a, b) => b - a);
    const gk = by('GK'), de = by('DEF'), mi = by('MID'), fw = by('FWD'); let best = -1;
    for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) { const f = 10 - d - m; if (f < 1 || f > 3) continue;
      let s = gk[0], mx = gk[0]; for (const v of [...de.slice(0, d), ...mi.slice(0, m), ...fw.slice(0, f)]) { s += v; if (v > mx) mx = v; } if (s + mx > best) best = s + mx; } return best; };
  const ev = (sq) => { let dec = 0, raw = 0; const g1 = wk(sq, 0); for (let t = 0; t < G.length; t++) { const v = t ? wk(sq, t) : g1; raw += v; dec += Math.pow(DEC, t) * v; } return { g1, dec, raw }; };
  const full = (sq) => { let dec = 0, g1 = 0, raw = 0; for (let t = 0; t < G.length; t++) { const ps = sq.map((p) => ({ position: p.position, xp: p.xpw[t], p1: p.p1w[t] }));
    const by = (pos) => sq.map((p, i) => i).filter((i) => sq[i].position === pos).sort((a, b) => ps[b].xp - ps[a].xp);
    const gk = by('GK'), de = by('DEF'), mi = by('MID'), fw = by('FWD'); let best = null;
    for (let d = 3; d <= 5; d++) for (let m = 2; m <= 5; m++) { const f = 10 - d - m; if (f < 1 || f > 3) continue; const xi = [gk[0], ...de.slice(0, d), ...mi.slice(0, m), ...fw.slice(0, f)]; const s = xi.reduce((a, i) => a + ps[i].xp, 0); if (!best || s > best.s) best = { s, xi }; }
    const rest = sq.map((p, i) => i).filter((i) => !best.xi.includes(i)), bg = rest.find((i) => sq[i].position === 'GK');
    const bench = [bg].concat(rest.filter((i) => i !== bg).sort((a, b) => ps[b].xp - ps[a].xp)), byXp = best.xi.slice().sort((a, b) => ps[b].xp - ps[a].xp);
    const v = S.expectedWithSubs(ps, best.xi, bench, byXp[0], byXp[1], 2, false, 1500).xpts; if (!t) g1 = v; raw += v; dec += Math.pow(DEC, t) * v; } return { g1, dec, raw }; };
  const base = ev(squad), baseF = full(squad);
  const owned = new Set(squad.map((p) => p.id));
  const decSum = (p) => p.xpw.reduce((a, x, t) => a + Math.pow(DEC, t) * x, 0);
  const pool = (pos, n) => data.players.filter((d) => d.position === pos && !owned.has(d.id)).map(info).sort((a, b) => decSum(b) - decSum(a)).slice(0, n);
  const clubs0 = {}; squad.forEach((p) => { clubs0[p.team] = (clubs0[p.team] || 0) + 1; });
  const LIMIT = { 1: 1000, 2: 60, 3: 20, 4: 10 };
  const found = { 1: [], 2: [], 3: [], 4: [] }, checked = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const k of [1, 2, 3, 4]) {
    const cand = {}; ['GK', 'DEF', 'MID', 'FWD'].forEach((pos) => { cand[pos] = pool(pos, LIMIT[k]); });
    const outs = [];
    const comb = (start, acc) => { if (acc.length === k) { outs.push(acc.slice()); return; } for (let i = start; i < squad.length; i++) { acc.push(i); comb(i + 1, acc); acc.pop(); } };
    comb(0, []);
    for (const o of outs) {
      const money0 = bank + o.reduce((a, i) => a + squad[i].sell, 0);
      const clubs = { ...clubs0 }; o.forEach((i) => clubs[squad[i].team]--);
      const ins = [];
      const rec = (j, money, lastIdx) => {
        if (j === k) {
          checked[k]++;
          const sq = squad.slice(); o.forEach((i, m) => { sq[i] = ins[m]; });
          const e = ev(sq), g1 = e.g1 - base.g1, dec = e.dec - base.dec, raw = e.raw - base.raw, itb = money - bank;
          if (g1 > -0.3 && raw > FTV * k - 0.5) found[k].push({ o, ins: ins.slice(), sq, g1, dec, raw, itb, money });
          return;
        }
        const pos = squad[o[j]].position, list = cand[pos];
        const startAt = j > 0 && squad[o[j - 1]].position === pos ? lastIdx + 1 : 0;
        for (let c = startAt; c < list.length; c++) { const p = list[c]; if (p.price > money + 1e-9 || (clubs[p.team] || 0) >= 3 || ins.some((x) => x.id === p.id)) continue;
          clubs[p.team] = (clubs[p.team] || 0) + 1; ins.push(p); rec(j + 1, money - p.price, c); ins.pop(); clubs[p.team]--; }
      };
      rec(0, money0, -1);
    }
  }
  console.log(`COUNT team ${entry}: bank ${bank}; players to buy checked per position: 1FT all, 2FT top ${LIMIT[2]}, 3FT top ${LIMIT[3]}, 4FT top ${LIMIT[4]}`);
  for (const k of [1, 2, 3, 4]) {
    // confirm with the full score (auto-subs)
    const ok = found[k].map((x) => { const f = full(x.sq); return { ...x, g1: f.g1 - baseF.g1, dec: f.dec - baseF.dec, raw: f.raw - baseF.raw }; })
      .filter((x) => x.g1 >= 0 && x.raw > FTV * k).sort((a, b) => b.raw - a.raw);
    console.log(`\n${k}FT: ${ok.length} pass (of ${checked[k]} checked)`);
    ok.slice(0, 15).forEach((x) => console.log(`  over ${(x.raw - FTV * k).toFixed(2)}\traw ${x.raw.toFixed(2)}\tdec ${x.dec.toFixed(2)}\tITB ${(x.itb >= 0 ? '+' : '') + x.itb.toFixed(1)} -> ${x.money.toFixed(1)}\tGW1 ${x.g1.toFixed(2)}\t` + x.o.map((i, m) => `${squad[i].name} -> ${x.ins[m].name} (${x.ins[m].team}) ${x.ins[m].price}`).join(' + ')));
  }
})();
