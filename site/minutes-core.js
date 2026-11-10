// Minutes shared by the xPoints and Minutes pages: the model's minutes per match, the viewer's own edits
// (saved in this browser), and the points rescaled to those minutes.
window.XMin = (function () {
  'use strict';
  const STORE = 'xmin-overrides';
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

  // Gameweek figures, rescaled when the viewer has set minutes. Appearance points follow FPL rules per match.
  function view(overrides, p, g) {
    const d = p.byGw[g];
    if (!d) return null;
    const m = minutes(overrides, p, g);
    if (m.source === 'model') return d;
    const r = m.mins.reduce((a, b) => a + b, 0) / m.mins.length / 90, f = d.full;
    const parts = { app: m.mins.reduce((a, x) => a + (x > 0 ? 1 : 0) + (x >= 60 ? 1 : 0), 0) };
    PARTS.forEach((k) => { parts[k] = f[k] * r; });
    return { ...d, parts, xpts: Object.values(parts).reduce((a, b) => a + b, 0), xmin: r * 90 * m.mins.length, mins: m.mins, xg: f.xg * r, xa: f.xa * r, edited: m.source };
  }

  const join = (mins) => mins.map((x) => Math.round(x)).join('+');
  return { load, save, parse, tidy, model, minutes, view, join };
})();
