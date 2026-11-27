// Minutes test: last season's xMin before each match against the minutes played (minutes_test.json, written by the
// backtest: players [{n name, t team, p position, m: [[gw, xMin, minutes, started 0/1, known out 0/1, opponent]]}]).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids); return n; };
  const state = { data: [], pos: '', sort: 'xm', dir: -1, open: null, limit: 150 };
  const COLS = [['n', 'Player'], ['k', 'Matches'], ['xm', 'xMin'], ['mi', 'Played'], ['df', 'Diff'], ['ms', 'Miss']];
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  function summarise(p) {
    const m = p.m;
    const xm = avg(m.map((r) => r[1])), mi = avg(m.map((r) => r[2]));
    return { ...p, k: m.length, xm, mi, df: xm - mi, ms: avg(m.map((r) => Math.abs(r[1] - r[2]))) };
  }

  function rows() {
    const q = $('search').value.trim().toLowerCase(), team = $('team').value, minx = +$('minx').value;
    return state.data.filter((p) => (!state.pos || p.p === state.pos) && (!team || p.t === team) && (!q || p.n.toLowerCase().includes(q)) && p.xm >= minx)
      .sort((a, b) => (state.sort === 'n' ? a.n.localeCompare(b.n) * -state.dir : (a[state.sort] - b[state.sort]) * state.dir));
  }

  function summary(list) {
    const all = list.flatMap((p) => p.m);
    if (!all.length) return $('sum').replaceChildren(el('p', { className: 'meta', textContent: 'No players.' }));
    const xm = avg(all.map((r) => r[1])), mi = avg(all.map((r) => r[2])), ms = avg(all.map((r) => Math.abs(r[1] - r[2])));
    const w10 = all.filter((r) => Math.abs(r[1] - r[2]) <= 10).length / all.length;
    $('sum').replaceChildren(el('h2', { textContent: `${list.length} players, ${all.length} matches` }),
      el('p', {}, `xMin ${xm.toFixed(1)} against ${mi.toFixed(1)} played on average (diff ${(xm - mi >= 0 ? '+' : '') + (xm - mi).toFixed(1)}), `,
        `average miss ${ms.toFixed(1)} minutes, ${Math.round(w10 * 100)}% within 10 minutes.`));
  }

  // one bar per match (minutes played: dark = started, light = came on, grey mark = out) with xMin as a dot
  function chart(p) {
    const m = p.m, W = Math.max(320, m.length * 16), H = 150, top = 10, bot = 22, h = H - top - bot, bw = W / m.length;
    const y = (v) => top + h - (Math.min(v, 100) / 100) * h;
    const ns = 'http://www.w3.org/2000/svg';
    const s = (tag, a) => { const n = document.createElementNS(ns, tag); Object.entries(a).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'mt-chart', role: 'img', 'aria-label': `${p.n}: xMin and minutes by gameweek` });
    [0, 45, 90].forEach((v) => {
      svg.append(s('line', { x1: 0, x2: W, y1: y(v), y2: y(v), class: 'mt-grid' }));
      const t = s('text', { x: 2, y: y(v) - 2, class: 'mt-ax' }); t.textContent = v; svg.append(t);
    });
    m.forEach(([gw, xm, mi, st, out, opp], i) => {
      const x = i * bw;
      const r = s('rect', { x: x + bw * 0.15, y: y(mi), width: bw * 0.7, height: Math.max(0, y(0) - y(mi)), class: out ? 'mt-out' : st ? 'mt-start' : 'mt-sub' });
      const tip = s('title', {}); tip.textContent = `GW${gw} v ${opp}: xMin ${xm}, played ${mi}${out ? ' (out)' : st ? ' (started)' : mi ? ' (came on)' : ''}`; r.append(tip);
      svg.append(r);
      if (out && !mi) svg.append(s('rect', { x: x + bw * 0.15, y: y(0) - 3, width: bw * 0.7, height: 3, class: 'mt-out' }));
      svg.append(s('circle', { cx: x + bw / 2, cy: y(xm), r: 3.2, class: 'mt-x' }));
      if (i % 2 === 0 || bw > 20) { const t = s('text', { x: x + bw / 2, y: H - 8, class: 'mt-gw' }); t.textContent = gw; svg.append(t); }
    });
    return el('div', { className: 'mt-chart-wrap' }, svg,
      el('p', { className: 'meta' }, el('span', { className: 'mt-key mt-start' }), ' started ', el('span', { className: 'mt-key mt-sub' }), ' came on ',
        el('span', { className: 'mt-key mt-out' }), ' out ', el('span', { className: 'mt-key mt-dot' }), ' xMin'));
  }

  function draw() {
    const list = rows();
    summary(list);
    $('table').tHead.replaceChildren(el('tr', {}, ...COLS.map(([k, label]) => {
      const b = el('button', { type: 'button', textContent: label + (state.sort === k ? (state.dir < 0 ? ' ▼' : ' ▲') : '') });
      b.addEventListener('click', () => { state.dir = state.sort === k ? -state.dir : (k === 'n' ? 1 : -1); state.sort = k; draw(); });
      return el('th', { scope: 'col', className: k === 'n' ? 'player' : '' }, b);
    })));
    const body = [];
    list.slice(0, state.limit).forEach((p) => {
      const key = p.n + '|' + p.t;
      const tr = el('tr', { className: 'mt-row' + (state.open === key ? ' on' : '') },
        el('td', { className: 'player' }, el('b', { textContent: p.n }), el('span', { className: 'meta', textContent: ` ${p.t} ${p.p}` })),
        el('td', { textContent: p.k }), el('td', { textContent: p.xm.toFixed(0) }), el('td', { textContent: p.mi.toFixed(0) }),
        el('td', { className: p.df > 10 ? 'mt-hi' : p.df < -10 ? 'mt-lo' : '', textContent: (p.df >= 0 ? '+' : '') + p.df.toFixed(0) }), el('td', { textContent: p.ms.toFixed(0) }));
      tr.addEventListener('click', () => { state.open = state.open === key ? null : key; draw(); });
      body.push(tr);
      if (state.open === key) body.push(el('tr', { className: 'mt-detail' }, el('td', { colSpan: COLS.length }, chart(p))));
    });
    if (list.length > state.limit) {
      const more = el('button', { type: 'button', className: 'more-rows', textContent: `Show all ${list.length}` });
      more.addEventListener('click', () => { state.limit = 1e9; draw(); });
      body.push(el('tr', {}, el('td', { colSpan: COLS.length }, more)));
    }
    $('table').tBodies[0].replaceChildren(...body);
  }

  fetch('minutes_test.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((d) => {
    state.data = d.players.map(summarise);
    $('status').textContent = `Season ${d.season}: xMin before each match against minutes played`;
    [...new Set(state.data.map((p) => p.t))].sort().forEach((t) => $('team').append(el('option', { value: t, textContent: t })));
    document.querySelectorAll('#filters .seg button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#filters .seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      state.pos = b.dataset.pos; draw();
    }));
    ['search', 'team', 'minx'].forEach((id) => $(id).addEventListener('input', draw));
    draw();
  }).catch(() => {
    $('error').hidden = false;
    $('error').textContent = 'The minutes test is made by the next site update.';
    $('status').textContent = '';
  });
})();
