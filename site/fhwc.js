// FH & WC: the best Free Hit (one gameweek) and Wildcard (5 gameweeks) teams before each deadline, against what they scored.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== '')); return n; };
  const f1 = (x) => (x === null || x === undefined ? '–' : Number(x).toFixed(1));
  let log = null;
  const name = (id) => (log.names[id] || { name: id, team: '', pos: '' });
  const table = (head, rows, cls) => el('div', { className: 'wrap fh-wrap' }, el('table', { className: `fh-table ${cls || ''}` },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { scope: 'col', textContent: h })))),
    el('tbody', {}, ...rows)));
  const diff = (a, x) => (a === undefined || a === null ? '' : `${a - x >= 0 ? '+' : '−'}${f1(Math.abs(a - x))}`);

  function summary() {
    const head = ['GW', 'FH xPts', 'FH actual', 'WC xPts (played weeks)', 'WC actual', 'WC xPts (5 GWs)'];
    const rows = Object.values(log.entries).sort((a, b) => b.gw - a.gw).map((e) => {
      const fw = e.fh.week, played = e.wc.weeks.filter((w) => w.actual !== undefined);
      const wx = played.reduce((a, w) => a + w.xpts, 0), wa = played.reduce((a, w) => a + w.actual, 0);
      return el('tr', {}, el('td', { textContent: `GW${e.gw}${e.locked ? '' : ' (not final)'}` }),
        el('td', { className: 'num', textContent: f1(fw.xpts) }), el('td', { className: 'num', textContent: fw.actual === undefined ? '–' : fw.actual }),
        el('td', { className: 'num', textContent: played.length ? `${f1(wx)} (${played.length})` : '–' }), el('td', { className: 'num', textContent: played.length ? wa : '–' }),
        el('td', { className: 'num', textContent: f1(e.wc.weeks.reduce((a, w) => a + w.xpts, 0)) }));
    });
    $('sum').tHead.replaceChildren(el('tr', {}, ...head.map((h) => el('th', { scope: 'col', textContent: h }))));
    $('sum').tBodies[0].replaceChildren(...rows);
  }

  // one gameweek's 15: starters then bench, with xPts and the real points
  function weekRows(w) {
    const rows = [];
    const line = (id, k, bench) => {
      const n = name(id), pts = w.playerPts ? w.playerPts[id] : undefined, mins = w.playerMins ? w.playerMins[id] : undefined;
      const tag = id === w.cap ? ' (C)' : id === w.vice ? ' (V)' : '';
      const sub = (w.subs || []).includes(id) ? ' ↑ sub on' : mins === 0 && !bench ? ' ✕ did not play' : '';
      return el('tr', { className: bench ? 'bench' : '' },
        el('td', { textContent: bench ? (k === 0 ? 'GK2' : `Sub ${k}`) : n.pos }),
        el('td', {}, el('b', { textContent: n.name + tag }), el('small', { textContent: ` ${n.team}${sub}` })),
        el('td', { className: 'num', textContent: f1(w.xp ? w.xp[id] : undefined) }),
        el('td', { className: 'num', textContent: pts === undefined ? '–' : pts }));
    };
    w.xi.forEach((id) => rows.push(line(id, 0, false)));
    w.bench.forEach((id, k) => rows.push(line(id, k, true)));
    return rows;
  }

  function show() {
    const e = log.entries[$('gw').value];
    if (!e) return;
    const fw = e.fh.week;
    $('fh').replaceChildren(el('h2', { textContent: `Free Hit GW${e.gw}` }),
      el('p', { className: 'meta', textContent: `£${e.fh.cost}m · saved ${e.saved.replace('T', ' ')}${e.locked ? ' (final, before the deadline)' : ' (not final yet)'}` }),
      el('p', {}, 'xPts ', el('b', { textContent: f1(fw.xpts) }), ' · actual ', el('b', { textContent: fw.actual === undefined ? '–' : fw.actual }), fw.actual === undefined ? '' : ` (${diff(fw.actual, fw.xpts)})`),
      table(['', 'Player', 'xPts', 'Pts'], weekRows(fw)));
    const wrows = e.wc.weeks.map((w) => el('tr', {}, el('td', { textContent: `GW${w.gw}` }), el('td', { textContent: name(w.cap).name }),
      el('td', { className: 'num', textContent: f1(w.xpts) }), el('td', { className: 'num', textContent: w.actual === undefined ? '–' : w.actual }),
      el('td', { className: 'num', textContent: diff(w.actual, w.xpts) })));
    const played = e.wc.weeks.filter((w) => w.actual !== undefined);
    const tot = el('tr', { className: 'total' }, el('td', { textContent: 'Total' }), el('td'),
      el('td', { className: 'num', textContent: f1(e.wc.weeks.reduce((a, w) => a + w.xpts, 0)) }),
      el('td', { className: 'num', textContent: played.length ? played.reduce((a, w) => a + w.actual, 0) : '–' }), el('td'));
    const pick = el('select', {}, ...e.wc.weeks.map((w) => el('option', { value: String(w.gw), textContent: `GW${w.gw}` })));
    const box = el('div');
    const one = () => { const w = e.wc.weeks.find((x) => String(x.gw) === pick.value); box.replaceChildren(table(['', 'Player', 'xPts', 'Pts'], weekRows(w))); };
    pick.addEventListener('change', one);
    $('wc').replaceChildren(el('h2', { textContent: `Wildcard from GW${e.gw} (5 gameweeks)` }),
      el('p', { className: 'meta', textContent: `£${e.wc.cost}m · the same 15 every week, best 11 and captain each week` }),
      table(['GW', 'Captain', 'xPts', 'Actual', '±'], wrows.concat([tot])),
      el('label', { className: 'fh-pick' }, 'Team in ', pick), box);
    one();
  }

  fetch('fhwc_log.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then((d) => {
    log = d;
    const gws = Object.keys(log.entries).map(Number).sort((a, b) => b - a);
    if (!gws.length) { $('status').textContent = 'No teams saved yet'; return; }
    $('status').textContent = `Free Hit and Wildcard teams from GW${gws[gws.length - 1]}, against what they scored`;
    $('gw').replaceChildren(...gws.map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
    $('gw').addEventListener('change', show);
    summary(); show();
  }).catch(() => { $('status').textContent = 'No teams saved yet: the first ones come with the next update'; });
})();
