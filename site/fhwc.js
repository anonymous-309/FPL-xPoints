// FH & WC: the best Free Hit (one gameweek) and Wildcard (5 gameweeks) teams before each deadline, against what they scored.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== '')); return n; };
  const f1 = (x) => (x === null || x === undefined ? '–' : Number(x).toFixed(1));
  const has = (x) => x !== null && x !== undefined;
  let log = null, tab = 'fh';
  const name = (id) => (log.names[id] || { name: id, team: '', pos: '' });
  const table = (head, rows) => el('div', { className: 'wrap fh-wrap' }, el('table', { className: 'fh-table' },
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { scope: 'col', textContent: h })))), el('tbody', {}, ...rows)));
  const diff = (a, x) => (has(a) ? `${a - x >= 0 ? '+' : '−'}${f1(Math.abs(a - x))}` : '');
  const when = (t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const entries = () => Object.values(log.entries).sort((a, b) => b.gw - a.gw);
  const num = (t) => el('td', { className: 'num', textContent: t });

  function summary() {
    if (tab === 'fh') {
      $('sum-h').textContent = 'Free Hit, every gameweek';
      $('sum').tHead.replaceChildren(el('tr', {}, ...['GW', 'xPts', 'Actual', '±'].map((h) => el('th', { scope: 'col', textContent: h }))));
      $('sum').tBodies[0].replaceChildren(...entries().map((e) => el('tr', {}, el('td', { textContent: `GW${e.gw}${e.locked ? '' : ' (not final)'}` }),
        num(f1(e.fh.week.xpts)), num(has(e.fh.week.actual) ? e.fh.week.actual : '–'), num(diff(e.fh.week.actual, e.fh.week.xpts)))));
    } else {
      $('sum-h').textContent = 'Wildcard, 5 gameweeks from each start';
      $('sum').tHead.replaceChildren(el('tr', {}, ...['Wildcard', 'Weeks played', 'xPts (played)', 'Actual', '±', 'xPts (5 GWs)'].map((h) => el('th', { scope: 'col', textContent: h }))));
      $('sum').tBodies[0].replaceChildren(...entries().map((e) => {
        const played = e.wc.weeks.filter((w) => has(w.actual));
        const x = played.reduce((a, w) => a + w.xpts, 0), a = played.reduce((s, w) => s + w.actual, 0);
        return el('tr', {}, el('td', { textContent: `WC GW${e.gw}` }), num(`${played.length} of 5`), num(played.length ? f1(x) : '–'),
          num(played.length ? a : '–'), num(played.length ? diff(a, x) : ''), num(f1(e.wc.weeks.reduce((s, w) => s + w.xpts, 0))));
      }));
    }
  }

  // one gameweek's 15: starters then bench, with xPts and the real points
  function weekRows(w) {
    const line = (id, k, bench) => {
      const n = name(id), pts = w.playerPts ? w.playerPts[id] : undefined, mins = w.playerMins ? w.playerMins[id] : undefined;
      const tag = id === w.cap ? ' (C)' : id === w.vice ? ' (V)' : '';
      const sub = (w.subs || []).includes(id) ? ' ↑ came on' : mins === 0 && !bench ? ' ✕ did not play' : '';
      return el('tr', { className: bench ? 'bench' : '' }, el('td', { textContent: bench ? (k === 0 ? 'GK2' : `Sub ${k}`) : n.pos }),
        el('td', {}, el('b', { textContent: n.name + tag }), el('small', { textContent: ` ${n.team}${sub}` })),
        num(f1(w.xp ? w.xp[id] : undefined)), num(has(pts) ? pts : '–'));
    };
    return w.xi.map((id) => line(id, 0, false)).concat(w.bench.map((id, k) => line(id, k, true)));
  }

  function show() {
    const e = log.entries[$('gw').value];
    if (!e) return;
    if (tab === 'fh') {
      const fw = e.fh.week;
      $('one').replaceChildren(el('h2', { textContent: `Free Hit GW${e.gw}` }),
        el('p', { className: 'meta', textContent: `£${Number(e.fh.cost).toFixed(1)}m · saved ${when(e.saved)}${e.locked ? ' (final, before the deadline)' : ' (not final yet)'}` }),
        el('p', {}, 'xPts ', el('b', { textContent: f1(fw.xpts) }), ' · actual ', el('b', { textContent: has(fw.actual) ? fw.actual : '–' }), has(fw.actual) ? ` (${diff(fw.actual, fw.xpts)})` : ''),
        table(['', 'Player', 'xPts', 'Pts'], weekRows(fw)));
      return;
    }
    const W = e.wc.weeks, played = W.filter((w) => has(w.actual));
    const rows = W.map((w) => el('tr', {}, el('td', { textContent: `GW${w.gw}` }), el('td', { textContent: name(w.cap).name }),
      el('td', { className: 'small', textContent: w.picked ? `${w.locked ? 'final' : 'latest'} ${when(w.picked)}` : `planned ${when(e.saved)}` }),
      num(f1(w.xpts)), num(has(w.actual) ? w.actual : '–'), num(diff(w.actual, w.xpts))));
    const tx = W.reduce((a, w) => a + w.xpts, 0), px = played.reduce((a, w) => a + w.xpts, 0), pa = played.reduce((a, w) => a + w.actual, 0);
    rows.push(el('tr', { className: 'total' }, el('td', { textContent: '5 GWs' }), el('td'), el('td'), num(f1(tx)),
      num(played.length === W.length ? pa : played.length ? `${pa} (${played.length} played)` : '–'), num(played.length === W.length ? diff(pa, tx) : played.length ? diff(pa, px) : '')));
    const pick = el('select', {}, ...W.map((w) => el('option', { value: String(w.gw), textContent: `GW${w.gw}` })));
    const box = el('div');
    const one = () => box.replaceChildren(table(['', 'Player', 'xPts', 'Pts'], weekRows(W.find((x) => String(x.gw) === pick.value))));
    pick.addEventListener('change', one);
    $('one').replaceChildren(el('h2', { textContent: `Wildcard GW${e.gw}: GW${W[0].gw}-${W[W.length - 1].gw}` }),
      el('p', { className: 'meta', textContent: `£${Number(e.wc.cost).toFixed(1)}m · the same 15 all 5 weeks, no transfers; the 11 and captain picked again before each gameweek` }),
      table(['GW', 'Captain', 'Line-up', 'xPts', 'Actual', '±'], rows),
      el('label', { className: 'fh-pick' }, 'Team in ', pick), box);
    one();
  }

  function draw() { summary(); show(); }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('gw-label').textContent = tab === 'fh' ? 'Gameweek' : 'Wildcard from';
    draw();
  }));
  fetch('fhwc_log.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then((d) => {
    log = d;
    const gws = Object.keys(log.entries).map(Number).sort((a, b) => b - a);
    if (!gws.length) { $('status').textContent = 'No teams saved yet'; return; }
    $('status').textContent = `Free Hit and Wildcard teams from GW${gws[gws.length - 1]}, against what they scored`;
    $('gw').replaceChildren(...gws.map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
    $('gw').addEventListener('change', show);
    draw();
  }).catch(() => { $('status').textContent = 'No teams saved yet: the first ones come with the next update'; });
})();
