// Minutes shared by the xPoints and Minutes pages: the model's minutes per match, the viewer's own edits
// (saved in this browser), and the points rescaled to those minutes.
window.XMin = (function () {
  'use strict';
  const STORE = 'xmin-overrides';
  const GOAL_PTS = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
  const CS_PTS = { GK: 4, DEF: 4, MID: 1, FWD: 0 };
  let dcPower = null;  // DefCon chance in m minutes = chance over 90 x (m / 90) ** dcPower (same as the model)
  const PEN_TAKE_ON_PITCH = 1;  // same as the model: the listed taker takes them while he is on the pitch
  let takers = {};  // team -> players with an FPL penalty order, first taker first
  let fkTakers = {};  // team -> players on FPL's free kick or corner list
  const PARTS = ['goal', 'assist', 'bonus', 'cs', 'conceded', 'saves', 'pensave', 'penmiss', 'own', 'defcon', 'cards'];

  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function save(overrides) { try { localStorage.setItem(STORE, JSON.stringify(overrides)); } catch (e) { /* edits still work for this visit */ } }
  // Empty text clears an edit (null); anything that is not a number is ignored (undefined).
  function parse(text) {
    if (String(text).trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(90, n))) : undefined;
  }
  function tidy(overrides, id) {
    const o = overrides[id];
    if (o && o.gw && !Object.keys(o.gw).length) delete o.gw;
    if (o && o.all === undefined && !o.gw) delete overrides[id];
  }

  // Model minutes per match in gameweek g, and the share of his usual minutes the injury and ban logic leaves him.
  function model(p, g) {
    const d = p.byGw[g];
    const n = d.opp.length;
    const mins = d.mins && d.mins.length === n ? d.mins : Array(n).fill(d.xmin / n);
    const share = mins.map((m) => (p.minUsual > 0 ? Math.min(1, m / p.minUsual) : 1));
    return { mins, share };
  }

  // Minutes per match for gameweek g: an edit of that gameweek, else Adjust min times the share
  // (so injuries and bans still count), else the model.
  function minutes(overrides, p, g) {
    if (!p.byGw[g]) return null;
    const m = model(p, g);
    const o = overrides[p.id];
    if (o && o.gw && o.gw[g] !== undefined) return { mins: m.mins.map(() => o.gw[g]), source: 'gw' };
    if (o && o.all !== undefined) return { mins: m.share.map((s) => Math.round(o.all * s)), source: 'all' };
    return { mins: m.mins, source: 'model' };
  }

  // Call once with all players so penalty shares can follow edited minutes of the takers above.
  let patterns = {};  // team -> [{ ids, pats: [[weight, started flags]] }]: who started together in recent matches
  function setPlayers(players, pats, slope) {
    if (slope !== undefined) dcPower = slope;
    patterns = pats || {};
    takers = {};
    fkTakers = {};
    players.filter((p) => p.penOrder != null).forEach((p) => { (takers[p.team] = takers[p.team] || []).push(p); });
    players.filter((p) => p.fkOrder != null || p.cornerOrder != null).forEach((p) => { (fkTakers[p.team] = fkTakers[p.team] || []).push(p); });
    Object.values(takers).forEach((list) => list.sort((a, b) => a.penOrder - b.penOrder));
  }

  // Minutes of player t in the match of fixture fx (gameweek g), or null if not in it.
  function matchMins(overrides, t, g, fx) {
    const k = t.byGw[g] && t.byGw[g].fx ? t.byGw[g].fx.indexOf(fx) : -1;
    return k < 0 ? null : Math.min(90, minutes(overrides, t, g).mins[k]);
  }
  // How he is on the pitch (same as the model): the chance he starts, his minutes when he starts (from the kick-off)
  // and when he does not (at the end), and the chance he is there at all, his minutes over his usual ones.
  function pitch(overrides, t, g, fx) {
    const m = matchMins(overrides, t, g, fx);
    if (m === null) return null;
    const u = t.pitch || { start: m >= 60 ? 1 : 0, ms: m, mb: 0 };
    const usual = t.minUsual || 0;
    const there = usual > 0 ? Math.min(1, m / usual) : 0;
    const q = usual > 0 && m > usual ? m / usual : 1;  // minutes set above his usual: longer on the pitch
    return { id: t.id, start: u.start, ms: Math.min(90, u.ms * q), mb: Math.min(90, u.mb * q), there };
  }
  const GRID = Array.from({ length: 90 }, (_, i) => i + 0.5);
  // Every case of who starts among the listed takers with its chance: each starts as often as his Start says; the
  // club's recent start patterns decide who starts together (fitted to those chances, as the model does).
  function startCases(starts, pats) {
    const k = starts.length;
    const cells = Array.from({ length: 1 << k }, (_, b) => starts.map((_, i) => (b >> i) & 1));
    const indep = cells.map((c) => c.reduce((a, f, i) => a * (f ? starts[i] : 1 - starts[i]), 1));
    if (!pats || !pats.length) return cells.map((c, n) => [indep[n], c]).filter(([w]) => w > 0);
    const seen = cells.map(() => 0);
    pats.forEach(([w, fl]) => { const n = fl.reduce((a, f, i) => a + (f ? 1 << i : 0), 0); seen[n] += w; });
    const ss = seen.reduce((a, v) => a + v, 0) || 1;
    let p = cells.map((_, n) => 0.9 * seen[n] / ss + 0.1 * indep[n] + 1e-9);
    const norm = () => { const t = p.reduce((a, v) => a + v, 0); p = p.map((v) => v / t); };
    norm();
    for (let it = 0; it < 60; it++) {
      starts.forEach((st, i) => {
        const m = p.reduce((a, v, n) => a + (cells[n][i] ? v : 0), 0);
        if (m > 0 && m < 1) p = p.map((v, n) => v * (cells[n][i] ? st / m : (1 - st) / (1 - m)));
        norm();
      });
    }
    return cells.map((c, n) => [p[n], c]).filter(([w]) => w > 1e-9);
  }
  // Share of the team's penalties each player takes while on the pitch, minute by minute (as the model does it):
  // the first listed taker on the pitch takes them, and when none is on, the free kick and corner takers on it.
  function shares(listed, fks, pats) {
    const k = listed.length;
    const onS = listed.map((x) => GRID.map((t) => (t < x.ms ? 1 : 0)));
    const onB = listed.map((x) => GRID.map((t) => (t >= 90 - x.mb ? 1 : 0)));
    const cases = startCases(listed.map((x) => x.start), pats);
    const took = Array(k).fill(0), onT = Array(k).fill(0), free = Array(k).fill(0), unc = Array(90).fill(0);
    cases.forEach(([w, fl]) => {
      for (let there = 0; there < 1 << k; there++) {
        const wt = w * listed.reduce((a, x, i) => a * ((there >> i) & 1 ? x.there : 1 - x.there), 1);
        if (wt <= 0) continue;
        const cov = Array(90).fill(0);
        for (let i = 0; i < k; i++) {
          const on = (there >> i) & 1 ? (fl[i] ? onS[i] : onB[i]) : null;
          let fr = 0, tk = 0, o = 0;
          for (let t = 0; t < 90; t++) { fr += 1 - cov[t]; if (on && on[t]) { o += 1; if (!cov[t]) { tk += 1; cov[t] = 1; } } }
          free[i] += wt * fr / 90; took[i] += wt * tk / 90; onT[i] += wt * o / 90;
        }
        for (let t = 0; t < 90; t++) unc[t] += wt * (1 - cov[t]);
      }
    });
    const out = {};
    listed.forEach((x, i) => { out[x.id] = PEN_TAKE_ON_PITCH * (onT[i] > 1e-9 ? took[i] / onT[i] : free[i]); });
    if (fks.length) {
      // while no listed taker is on: the free kick and corner takers, split by their minutes (starting or not)
      const left = unc.reduce((a, v) => a + v, 0) / 90;
      const mins = fks.reduce((a, x) => a + x.m, 0);
      fks.forEach((x) => { if (x.m > 0 && mins > 0) out[x.id] = Math.min(1, (out[x.id] || 0) + left / mins); });
    }
    return out;
  }

  // His share of the team's penalties while he is on the pitch in match j of gameweek g. Who starts with whom
  // matters: two takers who start together leave the next one the minutes after both have gone off; two who take
  // turns to start always leave one of them on.
  function penCond(overrides, p, g, j) {
    const d = p.byGw[g];
    if (!d || !d.fx) return 0;
    const fx = d.fx[j];
    // listed takers: Start above 50% -> on from the kick-off for his minutes, else on at the end for them
    const listed = (takers[p.team] || []).map((t) => {
      const x = pitch(overrides, t, g, fx);
      if (!x) return null;
      const len = Math.min(90, (t.minUsual || 0) * (t.minUsual > 0 ? Math.max(1, matchMins(overrides, t, g, fx) / t.minUsual) : 1));
      return { ...x, start: (t.pitch ? t.pitch.start : x.start) > 0.5 ? 1 : 0, ms: len, mb: len };
    }).filter(Boolean);
    const fks = (fkTakers[p.team] || []).filter((t) => t.penOrder == null).map((t) => { const m = matchMins(overrides, t, g, fx); return m ? { id: t.id, m: m / 90 } : null; }).filter(Boolean);
    if (!listed.some((x) => x.id === p.id) && !fks.some((x) => x.id === p.id)) return 0;
    return shares(listed, fks, null)[p.id] || 0;
  }

  // The chance he starts in gameweek g (at least one start in a double): his Start times the share of his usual
  // minutes he is expected to play.
  function startChanceAt(overrides, p, g, j) {
    const d = p.byGw[g];
    if (!d || !d.fx || !p.pitch) return null;
    const x = pitch(overrides, p, g, d.fx[j]);
    return x ? x.start * x.there : 0;
  }
  function startChance(overrides, p, g) {
    const d = p.byGw[g];
    if (!d || !d.fx || !p.pitch) return null;
    return 1 - d.fx.reduce((a, fx) => { const x = pitch(overrides, p, g, fx); return a * (1 - (x ? x.start * x.there : 0)); }, 1);
  }

  // Change in his full-90 goal, penalty miss and xG figures for match j when the penalty share moves.
  function penShift(overrides, p, g, j) {
    const d = p.byGw[g];
    if (!d.pc || !d.tp || p.penMiss == null) return { goal: 0, penmiss: 0, xg: 0 };
    const pens = (penCond(overrides, p, g, j) - d.pc[j]) * d.tp[j];
    return { goal: pens * (1 - p.penMiss) * GOAL_PTS[p.position], penmiss: -2 * pens * p.penMiss, xg: pens * (1 - p.penMiss) };
  }

  // Gameweek figures, rescaled when the viewer has set minutes. Appearance points follow FPL rules per match.
  // Penalties move to the next taker when a taker above him has fewer minutes (or back when more).
  function view(overrides, p, g) {
    const d = p.byGw[g];
    if (!d) return null;
    const m = minutes(overrides, p, g);
    const shifts = p.penOrder != null && d.fx ? d.fx.map((_, j) => penShift(overrides, p, g, j)) : [];
    const moved = shifts.some((s) => Math.abs(s.goal) > 0.005 || Math.abs(s.penmiss) > 0.005);
    if (m.source === 'model' && !moved) return d;
    if (m.source === 'model') {
      // only the penalty share changed: add it per match at his model minutes
      const parts = { ...d.parts };
      let xg = d.xg;
      shifts.forEach((s, j) => { const w = m.mins[j] / 90; parts.goal += s.goal * w; parts.penmiss += s.penmiss * w; xg += s.xg * w; });
      return { ...d, parts, xg, xpts: Object.values(parts).reduce((a, b) => a + b, 0), penMoved: true };
    }
    const f = { ...d.full };
    shifts.forEach((s) => { f.goal += s.goal; f.penmiss += s.penmiss; f.xg += s.xg; });
    const r = m.mins.reduce((a, b) => a + b, 0) / m.mins.length / 90;
    const parts = { app: m.mins.reduce((a, x) => a + (x > 0 ? 1 : 0) + (x >= 60 ? 1 : 0), 0) };
    PARTS.forEach((k) => { parts[k] = f[k] * r; });
    // Clean sheet and goals conceded count only for matches with 60+ minutes (FPL rule), and only the goals while
    // he is on the pitch; DefCon is much harder to reach in fewer minutes (same rules as the model).
    const full60 = m.mins.filter((x) => x >= 60).length / m.mins.length;
    if (d.cc && d.cc.length === m.mins.length) {
      const gkdef = p.position === 'GK' || p.position === 'DEF';
      parts.cs = 0; parts.conceded = 0;
      m.mins.forEach((x, j) => {
        if (x < 60) return;
        const on = d.cc[j] * x / 90;
        parts.cs += Math.exp(-on) * CS_PTS[p.position];
        if (gkdef) parts.conceded -= (on - (1 - Math.exp(-2 * on)) / 2) / 2;
      });
    } else {
      parts.cs = f.cs * full60;
      parts.conceded = f.conceded * full60;
    }
    if (d.dp && d.dp.length === m.mins.length && dcPower != null && p.position !== 'GK') {
      parts.defcon = m.mins.reduce((a, x, j) => a + 2 * d.dp[j] * Math.pow(Math.min(90, Math.max(0, x)) / 90, dcPower), 0);
    }
    return { ...d, parts, xpts: Object.values(parts).reduce((a, b) => a + b, 0), xmin: r * 90 * m.mins.length, mins: m.mins, xg: f.xg * r, xa: f.xa * r, edited: m.source };
  }

  const join = (mins) => mins.map((x) => Math.round(x)).join('+');
  // Player order of the xPoints page: the order it last showed (saved there, same data update only), else its
  // default, total xPts over the first 8 gameweeks with this viewer's minutes. Returns rank (lower is higher).
  function order(data, overrides) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('xpoints-order')); } catch (e) { saved = null; }
    if (saved && saved.updatedAt === data.updatedAt && Array.isArray(saved.ids) && saved.ids.length) {
      const rank = new Map(saved.ids.map((id, i) => [id, i]));
      return (p) => (rank.has(p.id) ? rank.get(p.id) : saved.ids.length);
    }
    const gws = data.gws.slice(0, 8).map(String), score = new Map();
    data.players.forEach((p) => score.set(p.id, gws.reduce((a, g) => { const d = view(overrides, p, g); return a + (d ? d.xpts : 0); }, 0)));
    return (p) => -(score.get(p.id) || 0);
  }

  // The same text as a gameweek cell on the xPoints page: expected points, minutes, Chance 90min and points by part.
  // The same figures as the xPoints page's player pop-up: Chance 90min as on the Chance page (goals split into open
  // play and penalties, with the Minutes page edits), then this season so far.
  const CHANCES = [
    ['pStart', 'Start', 'pct'], ['pApp1', 'Appearance 1+', 'pct'], ['pApp60', 'Appearance 60+', 'pct'],
    ['pScore', 'Score 1+', 'pct'], ['npxGoals', 'NPxGoals', 2], ['xPenGoals', 'Pen goals', 2], ['pAssist', 'Fantasy Assist 1+', 'pct'], ['xAssists', 'xAssists', 2],
    ['pCs', 'Clean sheet', 'pct'], ['xConceded', 'Conceded', 2], ['pDefcon', 'DefCon', 'pct'], ['xDefcon', 'DefCon actions', 1], ['xSaves', 'Saves', 1],
    ['pPenSave', 'Pen save', 'pct1'], ['pPenMiss', 'Pen miss', 'pct1'], ['pOwnGoal', 'Own goal', 'pct1'],
    ['pRed', 'Red card', 'pct1'], ['pYellow', 'Yellow card', 'pct'], ['xBps', 'BPS', 0], ['bonus', 'Bonus', 2],
  ];
  function chanceFigures(overrides, p, g) {
    const d = p.byGw[g];
    const miss = p.penMiss == null ? 0.22 : p.penMiss;
    let penModel = 0, pen = 0, missed = 0;
    (d.fx || []).forEach((_, j) => {
      const tp = d.tp ? d.tp[j] : 0;
      penModel += (d.pc ? d.pc[j] : 0) * tp * (1 - miss);
      const pens = penCond(overrides, p, g, j) * tp;
      pen += pens * (1 - miss);
      missed += pens * miss;
    });
    const np = Math.max(0, d.xGoals - penModel);
    return { ...d, pStart: startChance(overrides, p, g), npxGoals: np, xPenGoals: pen, pScore: 1 - Math.exp(-(np + pen)), pPenMiss: d.fx ? 1 - Math.exp(-missed) : d.pPenMiss };
  }
  function seasonText(p) {
    const s = p.season;
    if (!s || !s.matches) return 'This season\nNo league matches yet';
    const per = (v) => (v === null || v === undefined ? '–' : v.toFixed(2));
    return ['This season', `Starts: ${s.starts} of ${s.matches} matches (${s.apps} played)`, `Minutes: ${s.mins}`,
      `Goals: ${s.goals}, assists: ${s.assists}`,
      ...(s.npxg === null || s.npxg === undefined ? [`xG: ${s.xg.toFixed(2)} (${per(s.xg90)} per 90)`]
        : [`npxG: ${s.npxg.toFixed(2)} (${per(s.mins ? s.npxg / (s.mins / 90) : null)} per 90)`, `Pen xG: ${(s.xg - s.npxg).toFixed(2)} (${per(s.mins ? (s.xg - s.npxg) / (s.mins / 90) : null)} per 90)`]),
      `xA: ${s.xa.toFixed(2)} (${per(s.xa90)} per 90)`,
      `xGI: ${s.xgi.toFixed(2)} (${per(s.xgi90)} per 90)`, `DefCon: ${s.dc} (${per(s.dc90)} per 90)`].join('\n');
  }
  function detailText(overrides, p, g) {
    const d = view(overrides, p, g), raw = p.byGw[g];
    if (!d || !raw) return `${p.name}, GW${g}: no match\n\n${seasonText(p)}`;
    const m = minutes(overrides, p, g);
    const f = chanceFigures(overrides, p, g);
    const chances = CHANCES.filter(([key]) => f[key] != null && !((key === 'pDefcon' || key === 'xDefcon') && p.position === 'GK') && !((key === 'xSaves' || key === 'pPenSave') && p.position !== 'GK'))
      .map(([key, label, fmt]) => `${label}: ${fmt === 'pct' ? `${Math.round(f[key] * 100)}%` : fmt === 'pct1' ? `${(f[key] * 100).toFixed(1)}%` : f[key].toFixed(fmt)}`).join('\n');
    return `${p.name}, GW${g} v ${d.opp.join(', ')}\nExpected ${d.xpts.toFixed(1)} points, ${join(m.mins)} minutes${d.edited ? ' (yours)' : ''}\n\nChance 90min\n${chances}\n\n${seasonText(p)}`;
  }

  return { load, save, parse, tidy, model, minutes, view, join, setPlayers, penCond, startChance, startChanceAt, order, detailText };
})();
