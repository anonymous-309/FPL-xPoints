// Minutes shared by the xPoints and Minutes pages: the model's minutes per match, the viewer's own edits
// (saved in this browser), and the points rescaled to those minutes.
window.XMin = (function () {
  'use strict';
  const STORE = 'xmin-overrides';
  const GOAL_PTS = { GK: 10, DEF: 6, MID: 5, FWD: 4 };
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
  function setPlayers(players) {
    takers = {};
    fkTakers = {};
    players.filter((p) => p.penOrder != null).forEach((p) => { (takers[p.team] = takers[p.team] || []).push(p); });
    players.filter((p) => p.fkOrder != null || p.cornerOrder != null).forEach((p) => { (fkTakers[p.team] = fkTakers[p.team] || []).push(p); });
    Object.values(takers).forEach((list) => list.sort((a, b) => a.penOrder - b.penOrder));
  }

  // Share of 90 minutes player t is on the pitch in the match of fixture fx (gameweek g), or null if not in it.
  function onPitch(overrides, t, g, fx) {
    const k = t.byGw[g] && t.byGw[g].fx ? t.byGw[g].fx.indexOf(fx) : -1;
    return k < 0 ? null : Math.min(90, minutes(overrides, t, g).mins[k]) / 90;
  }

  // His share of the team's penalties while he is on the pitch in match j of gameweek g: the first taker takes
  // them when on, each next taker gets the ones left while those above him are off; those left while every listed
  // taker is off go to the free kick and corner takers, split by their minutes (same rule as the model).
  function penCond(overrides, p, g, j) {
    const d = p.byGw[g];
    if (!d || !d.fx) return 0;
    const fx = d.fx[j];
    let share = 0, left = 1;
    for (const t of takers[p.team] || []) {
      const m = onPitch(overrides, t, g, fx);
      if (m === null) continue;
      if (t.id === p.id) share = PEN_TAKE_ON_PITCH * left;
      left *= 1 - m;
    }
    // (not the penalty takers themselves: these penalties come exactly when they are all off)
    if (p.penOrder == null && (p.fkOrder != null || p.cornerOrder != null) && left > 0) {
      const mine = onPitch(overrides, p, g, fx);
      const total = (fkTakers[p.team] || []).filter((t) => t.penOrder == null).reduce((s, t) => s + (onPitch(overrides, t, g, fx) || 0), 0);
      if (mine > 0 && total > 0) share = Math.min(1, share + left / total);
    }
    return share;
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
    // Clean sheet and goals conceded count only for matches with 60+ minutes (FPL rule).
    const full60 = m.mins.filter((x) => x >= 60).length / m.mins.length;
    parts.cs = f.cs * full60;
    parts.conceded = f.conceded * full60;
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

  return { load, save, parse, tidy, model, minutes, view, join, setPlayers, penCond, order };
})();
