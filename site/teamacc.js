// Team odds page, Accuracy tab: the team goals and clean sheet figures tested on the last full season (backtest.txt).
window.TeamAcc = (function () {
  'use strict';
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== '')); return n; };
  const p = (...kids) => el('p', {}, ...kids);
  const b = (t) => el('b', { textContent: t });
  const table = (head, rows) => el('div', { className: 'wrap' }, el('table', { className: 'acc-table' },
    el('thead', {}, el('tr', {}, ...head.map((h, k) => el('th', { scope: 'col', className: k ? 'num' : '', textContent: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c, k) => el('td', { className: k ? 'num' : '', textContent: c })))))));
  const card = (title, ...kids) => el('section', { className: 'acc-card' }, el('h2', { textContent: title }), ...kids);
  // a small SVG chart: bars (counts) or lines (several series), x labels under each point
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, a, txt) => { const n = document.createElementNS(NS, tag); Object.entries(a).forEach(([k, v]) => n.setAttribute(k, v)); if (txt !== undefined) n.textContent = txt; return n; };
  function svgChart({ labels, series, bars, yTitle, xTitle, yMin, yMax, every = 1 }) {
    const W = 640, H = 260, L = 44, R = 10, T = 12, B = 44;
    const all = series.flatMap((x) => x.values.filter((v) => v !== null));
    const lo = yMin !== undefined ? yMin : 0;
    const nice = (x) => { const e = Math.pow(10, Math.floor(Math.log10(x))); return [1, 2, 2.5, 5, 10].map((m) => m * e).find((v) => v >= x); };
    const hi = yMax !== undefined ? yMax : nice(Math.max(...all) * 1.02 / 4) * 4;
    const n = labels.length, bw = (W - L - R) / n;
    const X = (i) => L + bw * (i + 0.5), Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const g = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'acc-chart', role: 'img' });
    const step = (hi - lo) / 4;
    for (let k = 0; k <= 4; k++) {
      const v = lo + step * k, y = Y(v);
      g.append(sv('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: 'var(--line)' }));
      g.append(sv('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, hi > 10 ? Math.round(v) : v.toFixed(1)));
    }
    labels.forEach((lab, i) => i % every === 0 && g.append(sv('text', { x: X(i), y: H - B + 16, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--muted)' }, lab)));
    g.append(sv('text', { x: (L + W - R) / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 11.5, fill: 'var(--ink)' }, xTitle));
    g.append(sv('text', { x: 12, y: (T + H - B) / 2, 'text-anchor': 'middle', 'font-size': 11.5, fill: 'var(--ink)', transform: `rotate(-90 12 ${(T + H - B) / 2})` }, yTitle));
    series.forEach((s) => {
      if (bars) {
        s.values.forEach((v, i) => { const r = sv('rect', { x: X(i) - bw * 0.38, width: bw * 0.76, y: Y(v), height: Y(lo) - Y(v), fill: s.color, rx: 2 });
          r.append(sv('title', {}, `${labels[i]}: ${v}`)); g.append(r); });
      } else {
        const pts = s.values.map((v, i) => (v === null ? null : `${X(i)},${Y(v)}`)).filter(Boolean);
        g.append(sv('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2.2, 'stroke-dasharray': s.dash || '' }));
        s.values.forEach((v, i) => { if (v !== null && !s.dash) g.append(sv('circle', { cx: X(i), cy: Y(v), r: 3.2, fill: s.color })); });
      }
    });
    const legend = series.length > 1 ? el('div', { className: 'acc-legend' }, ...series.map((s) => el('span', {},
      el('i', { style: `background:${s.color}` }), s.name))) : null;
    return el('div', { className: 'acc-chart-wrap' }, g, legend);
  }
  function sections(text) {
    const out = {};
    let cur = null;
    text.split('\n').forEach((line) => {
      const m = line.match(/^=== (.+?) ===/);
      if (m) { cur = m[1]; out[cur] = []; return; }
      if (cur) out[cur].push(line);
    });
    return out;
  }
  let loaded = null;
  function render(box) {
    if (!loaded) loaded = fetch('backtest.txt', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
    loaded.then((text) => draw(box, sections(text))).catch((e) => box.replaceChildren(el('p', { className: 'error', textContent: `Could not load the accuracy figures (${e.message}).` })));
  }
  function draw(box, S) {
    const out = [];
    const tmKey = Object.keys(S).find((k) => k.startsWith('Team goals and clean sheets'));
    // clean sheet chance in steps of 2%: how many matches at each, and the real share against the predicted
    const csCharts = (rows) => {
      if (!rows.length) return [];
      const labels = rows.map((r) => r[0]), n = rows.map((r) => +r[1]);
      const ok = rows.filter((r) => +r[1] >= 20);
      return [
        el('h3', { textContent: 'How often each clean sheet chance came up' }),
        p('Every team-match by its predicted clean sheet chance, in steps of 2% (20% means 20–21.9%).'),
        svgChart({ labels, every: 1, series: [{ name: 'Matches', values: n, color: 'var(--turf)' }], bars: true, yTitle: 'Matches', xTitle: 'Predicted clean sheet chance' }),
        el('h3', { textContent: 'Real clean sheets at each predicted chance' }),
        p('The real share of clean sheets in each step of 2% against the middle of the step; only steps with 20 matches or more. A clean sheet is yes or no, so with about 50 matches a step the real share moves about 6 points either way by luck alone: read the line as a whole, not each point.'),
        svgChart({ labels: ok.map((r) => r[0]), yTitle: 'Clean sheet %', xTitle: 'Predicted clean sheet chance', yMin: 0, yMax: 48,
          series: [{ name: 'Real share', values: ok.map((r) => parseFloat(r[2])), color: 'var(--turf)' },
            { name: 'Predicted (middle of the step)', values: ok.map((r) => parseFloat(r[0]) + 1), color: '#c58a00', dash: '5 4' }] }),
      ];
    };
    // expected goals in steps of 0.1: how many matches at each, and the real goals against the expected
    const goalCharts = (rows) => {
      if (!rows.length) return [];
      const labels = rows.map((r) => r[0]), n = rows.map((r) => +r[1]);
      const ok = rows.filter((r) => +r[1] >= 15);
      return [
        el('h3', { textContent: 'How often each expected figure came up' }),
        p('Every team-match by its expected goals, in steps of 0.1 (0.8 means 0.80–0.89).'),
        svgChart({ labels, series: [{ name: 'Matches', values: n, color: 'var(--turf)' }], bars: true, yTitle: 'Matches', xTitle: 'Expected goals' }),
        el('h3', { textContent: 'Real goals at each expected figure' }),
        p('The average real goals in each step of 0.1 against the middle of the step; only steps with 15 matches or more (fewer are too few to read).'),
        svgChart({ labels: ok.map((r) => r[0]), yTitle: 'Goals', xTitle: 'Expected goals', yMin: 0.4, yMax: 2.4,
          series: [{ name: 'Real average', values: ok.map((r) => +r[2]), color: 'var(--turf)' },
            { name: 'Expected (middle of the step)', values: ok.map((r) => +r[0] + 0.05), color: '#c58a00', dash: '5 4' }] }),
      ];
    };
    if (tmKey) {
      const L = S[tmKey];
      const after = (title) => { const i = L.findIndex((l) => l.trim() === title); return i < 0 ? [] : L.slice(i + 1); };
      const rowsOf = (title) => { const ls = after(title); const n = ls.length ? ls[0].split('|').length : 0; const out = [];
        for (let j = 1; j < ls.length && ls[j].trim() && ls[j].split('|').length === n; j++) out.push(ls[j].split('|').map((x) => x.trim())); return out; };
      const kv = (title) => Object.fromEntries(rowsOf(title).map((r) => [r[0], r[1]]));
      const g = kv('Goals per match'), c = kv('Clean sheets');
      const clubs = rowsOf('Season totals by club');
      const corr = (L.find((l) => l.startsWith('correlation of season totals')) || '').split('|')[1] || '';
      box.replaceChildren(card('How accurate the team odds are',
        p(`Every club's expected goals and clean sheet chance in each of the ${g.matches || ''} team-matches of the test season (the figures on this page, worked out before each match), against what happened.`),
        el('h3', { textContent: 'Goals' }),
        p('On average: expected ', b(g['expected goals, average'] || '–'), ' goals a match, real ', b(g['real goals, average'] || '–'),
          '. A single match is hard to call (average miss ', b(g['average miss'] || '–'), ' goals, against ', b(g['average miss, everyone at the league home/away average'] || '–'),
          ' if every team got the league average), but grouped by the expected figure the real goals follow it closely:'),
        ...goalCharts(rowsOf('Expected goals in steps of 0.1')),
        el('h3', { textContent: 'Clean sheets' }),
        p('Predicted ', b(c['predicted share'] || '–'), ' of matches, real ', b(c['real share'] || '–'), '. A clean sheet means the opponent scores 0, so the two figures go together: the more goals the opponent is expected to score, the lower the chance. The clean sheet chance is e to the minus the opponent\'s expected goals.'),
        ...csCharts(rowsOf('Clean sheet chance in steps of 2%')),
        el('h3', { textContent: 'Season totals by club' }),
        p(`How close the season adds up for each club (correlation: ${corr.trim()}).`),
        table(['Club', 'Matches', 'Predicted goals', 'Real goals', 'Predicted CS', 'Real CS'], clubs)));
    }

    if (!tmKey) box.replaceChildren(el('p', { className: 'meta', textContent: 'No accuracy figures yet.' }));
  }
  return { render, svgChart };
})();
