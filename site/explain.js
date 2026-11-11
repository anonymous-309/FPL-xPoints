// Worked example on the How it works page: one player's xPoints for one gameweek, component by component.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids); return n; };
  const ROWS = [
    ['goal', 'Goals', 'm'], ['assist', 'Assists', 'm'], ['cs', 'Clean sheet', 'p60'], ['conceded', 'Goals conceded', 'p60'],
    ['saves', 'Saves', 'm'], ['pensave', 'Penalty saves', 'm'], ['defcon', 'DefCon', 'm'], ['bonus', 'Bonus', 'm'],
    ['penmiss', 'Penalty misses', 'm'], ['own', 'Own goals', 'm'], ['cards', 'Cards', 'm'],
  ];
  const f2 = (x) => (Math.abs(x) < 0.005 ? '0.00' : x.toFixed(2));
  let data = null;

  function find() {
    const q = $('player').value.trim().toLowerCase();
    if (!q) return null;
    const list = data.players;
    return list.find((p) => `${p.name} (${p.team})`.toLowerCase() === q)
      || list.find((p) => p.name.toLowerCase() === q)
      || list.filter((p) => p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q))
        .sort((a, b) => b.price - a.price)[0] || null;
  }

  function render() {
    const p = find(), g = $('gw').value;
    const d = p && p.byGw[g];
    $('example').hidden = !d;
    if (!d) { $('exNote').textContent = p ? `${p.name} has no match in GW${g}.` : 'Type a player name to see the calculation.'; return; }
    const n = d.opp.length, m = d.xmin / 90 / n;
    const rows = [el('tr', {}, el('th', { scope: 'row', textContent: 'Appearance' }),
      el('td', { textContent: `P1 ${Math.round(d.pApp1 * 100)}% + P60 ${Math.round(d.pApp60 * 100)}%` }), el('td', { textContent: '' }),
      el('td', { textContent: f2(d.parts.app) }))];
    ROWS.forEach(([k, label, kind]) => {
      const full = d.full[k] || 0, pts = d.parts[k] || 0;
      if (Math.abs(full) < 0.005 && Math.abs(pts) < 0.005) return;
      const factor = full ? pts / full : 0;
      const how = kind === 'p60' ? `P60 ${Math.round(factor * 100)}%` : `${(factor * 90).toFixed(0)}/90 min`;
      rows.push(el('tr', {}, el('th', { scope: 'row', textContent: label }), el('td', { textContent: f2(full) }), el('td', { textContent: how }), el('td', { textContent: f2(pts) })));
    });
    rows.push(el('tr', { className: 'sum' }, el('th', { scope: 'row', textContent: 'xPoints' }), el('td'), el('td'), el('td', { textContent: f2(d.xpts) })));
    $('exTable').tBodies[0].replaceChildren(...rows);
    const opp = d.opp.join(', ');
    $('exNote').textContent = `${p.fullName} (${p.team} ${p.position}), GW${g} v ${opp}: xMin ${Math.round(d.xmin)}${n > 1 ? ` over ${n} matches` : ''}, so m ≈ ${m.toFixed(2)} per match. `
      + `"Over 90 minutes" is the points expected from that part if he plays the full 90${n > 1 ? ' (both matches added)' : ''}. Goals conceded and cards are negative.`;
  }

  $('filters').addEventListener('submit', (e) => e.preventDefault());
  $('filters').addEventListener('input', render);
  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((json) => {
      data = json;
      const upcoming = json.gws.filter((g) => !(json.pastGws || []).includes(g));
      $('gw').replaceChildren(...upcoming.map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
      $('players').replaceChildren(...json.players.slice().sort((a, b) => b.price - a.price).map((p) => el('option', { value: `${p.name} (${p.team})` })));
      const top = json.players.slice().sort((a, b) => ((b.byGw[upcoming[0]] || {}).xpts || 0) - ((a.byGw[upcoming[0]] || {}).xpts || 0))[0];
      if (top) $('player').value = `${top.name} (${top.team})`;
      render();
    })
    .catch((e) => { $('error').hidden = false; $('error').textContent = `Could not load the data (${e.message}).`; });
})();
