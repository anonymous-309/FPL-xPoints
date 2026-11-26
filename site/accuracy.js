// Accuracy page: reads backtest.txt (the model tested on a past season) and shows the main results in plain words.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== '')); return n; };
  const num = (s) => Number(String(s).replace('%', ''));
  const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const pct = (x) => `${Math.round(x)}%`;

  // "=== Title ===" sections, each a list of lines
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
  // rows of a block: the line after the title is the header; columns split on 2+ spaces
  function block(lines, title) {
    const i = lines.findIndex((l) => l.trim() === title);
    if (i < 0) return [];
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim(); j++) rows.push(lines[j].trim().split(/\s{2,}/));
    return rows;
  }
  const table = (head, rows, opts = {}) => el('div', { className: 'wrap' }, el('table', { className: 'acc-table' },
    el('thead', {}, el('tr', {}, ...head.map((h, k) => el('th', { scope: 'col', className: k ? 'num' : '', textContent: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', { className: opts.mark && opts.mark(r) ? 'on' : '' }, ...r.map((c, k) => el('td', { className: k ? 'num' : '', textContent: c })))))));
  const sum100 = (s) => (s.match(/\d+/g) || []).reduce((a, x) => a + Number(x), 0);
  const card = (title, ...kids) => el('section', { className: 'acc-card' }, el('h2', { textContent: title }), ...kids);
  // a small SVG chart: bars (counts) or lines (several series), x labels under each point
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, a, txt) => { const n = document.createElementNS(NS, tag); Object.entries(a).forEach(([k, v]) => n.setAttribute(k, v)); if (txt !== undefined) n.textContent = txt; return n; };
  function svgChart({ labels, series, bars, yTitle, xTitle, yMin, yMax }) {
    const W = 640, H = 260, L = 44, R = 10, T = 12, B = 44;
    const all = series.flatMap((x) => x.values.filter((v) => v !== null));
    const lo = yMin !== undefined ? yMin : 0, hi = yMax !== undefined ? yMax : Math.ceil(Math.max(...all) * 1.05 / 20) * 20;
    const n = labels.length, bw = (W - L - R) / n;
    const X = (i) => L + bw * (i + 0.5), Y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const g = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'acc-chart', role: 'img' });
    const step = (hi - lo) / 4;
    for (let k = 0; k <= 4; k++) {
      const v = lo + step * k, y = Y(v);
      g.append(sv('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: 'var(--line)' }));
      g.append(sv('text', { x: L - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, hi > 10 ? Math.round(v) : v.toFixed(1)));
    }
    labels.forEach((lab, i) => g.append(sv('text', { x: X(i), y: H - B + 16, 'text-anchor': 'middle', 'font-size': 10.5, fill: 'var(--muted)' }, lab)));
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
  const p = (...kids) => el('p', {}, ...kids);
  const b = (t) => el('b', { textContent: t });

  function render(text, xm) {
    const season = (text.match(/training before (\d{4}-\d{2})/) || [])[1] || 'a past season';
    const S = sections(text);
    const out = [];
    const NAMES = { 'Model': 'This site', 'Model, real minutes': 'This site at his real minutes', 'Trailing 4 GW': 'Points in his last 4 GWs', 'Long-run PPG': 'Points per game, long run' };

    // pipe tables: the rows after a header line that matches, up to the first line that is not a row
    const pipe = (lines, re) => {
      const i = lines.findIndex((l) => re.test(l.trim()));
      const rows = [];
      const n = i >= 0 ? lines[i].split('|').length : 0;  // a row has as many cells as the header
      for (let j = i + 1; i >= 0 && j < lines.length && lines[j].trim() && lines[j].split('|').length === n; j++) rows.push(lines[j].split('|').map((x) => x.trim()));
      return rows;
    };
    const POSN = { GK: 'Goalkeepers', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards', All: 'All' };

    // 1c. the core group
    const coreKey = Object.keys(S).find((k) => k.startsWith('Core group'));
    if (coreKey) {
      const L = S[coreKey];
      const xm = pipe(L, /^group \| matches \| xMin/);
      const parts = pipe(L, /^group \| part \| real/);
      const ch = pipe(L, /^figure \| matches \| predicted/);
      const rk = pipe(L, /^group \| predicted \(xMin\)/);
      const pl = pipe(L, /^position \| real rank/);
      const tot = pipe(L, /^group \| players \| real \| xPoints/);
      const fc = pipe(L, /^group \| found \| of/);
      const size = (coreKey.match(/\((.+?)\)/) || [])[1] || '';
      const PARTS = ['Goals', 'Assists', 'Bonus', 'Clean sheet', 'Saves', 'DefCon and other', 'Total'];
      const ratio = (g, part) => { const r = parts.find((x) => x[0] === g && x[1] === part); return r ? f(num(r[4]), 2) : '–'; };
      out.push(card('The core group',
        p(`The ${sum100(size)} players who mattered most in ${season}: the top scorers by position (${size}). Three questions: is their xMin right, are the Chance 90min figures right once their real minutes are put in, and are they ranked in the right order?`),
        el('h3', { textContent: 'xMin, per match' }),
        table(['Group', 'Matches', 'xMin', 'Real minutes', 'Bias', 'Average miss', 'Within 10 min', 'Chance of 60+', 'Real 60+'],
          xm.filter((r) => !r[0].includes('(')).map((r) => [POSN[r[0]] || r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]), { mark: (r) => r[0] === 'All' }),
        p('Bias below 0: xMin a little too low. For the players who matter, xMin is about right on average; the miss in a single match is mostly a substitution or a rest.'),
        el('h3', { textContent: 'Chance 90min at their real minutes: real points / predicted' }),
        p('Each figure for a full 90, times the minutes he really played; penalty goals and misses left out. 1.00 = right, 1.20 = they really got 20% more.'),
        table(['Part', 'GK', 'DEF', 'MID', 'FWD', 'All'], PARTS.map((pt) => [pt === 'DefCon and other' ? 'DefCon' : pt, ...['GK', 'DEF', 'MID', 'FWD', 'All'].map((g) => ratio(g, pt))]), { mark: (r) => r[0] === 'Total' }),
        table(['Per match he played', 'Predicted', 'Happened', 'Sorting (0.5 coin flip, 1 perfect)'], ch.map((r) => [r[0], r[2], r[3], r[4]])),
        p('Saves, clean sheets and DefCon come out close. Goals, assists and bonus come out short, partly because this group was picked after the season for scoring the most (their good luck is in it), and most for midfielders and defenders.'),
        el('h3', { textContent: 'Season points: real against xPoints' }),
        table(['Group', 'Players', 'Real points', 'xPoints', 'Real / xPoints', 'Real, no pens', 'xPoints at real minutes, no pens', 'Real / at real minutes'],
          tot.map((r) => [POSN[r[0]] || r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]]), { mark: (r) => r[0] === 'All' }),
        p('xPoints added up over the season, each gameweek predicted before it. These players were picked after the season for scoring the most, so their good luck is in the real points and they come out above their xPoints.'),
        el('h3', { textContent: 'Is the order right?' }),
        fc.length ? table(['Group', 'Model\'s top found in the core', 'Real points of its picks', 'Real points of the core'],
          fc.map((r) => [POSN[r[0]] || r[0], `${r[1]} of ${r[2]}`, r[3], r[4]]), { mark: (r) => r[0] === 'All' }) : null,
        fc.length ? p('The model\'s own top by position (its season total of predictions, the same numbers as the core), and how many of them are in the core.') : null,
        table(['Group', 'Predicted points', 'At real minutes', 'xMin total vs real minutes'], rk.map((r) => [POSN[r[0]] || r[0], r[1], r[2], r[3]]), { mark: (r) => r[0] === 'All' }),
        p('Rank correlation inside the group: 1 = the same order as their real season points, 0 = no relation. The last column shows the minutes alone are ordered almost perfectly, so a wrong place comes from the per-90 figures.'),
        pl.length ? el('details', {}, el('summary', { textContent: 'Each player of the core: real rank and the model\'s rank' }),
          table(['Pos', 'Real rank', 'Model rank', 'Player', 'Team', 'Predicted', 'Real', 'At real minutes (no pens)', 'Real (no pens)', 'Minutes', 'xMin'], pl.map((r) => r.slice(0, 11)))) : null));
    }

    // 1d. picking players ahead, every 4 gameweeks
    const f4Key = Object.keys(S).find((k) => k.startsWith('Finding the best players, each 4'));
    if (f4Key) {
      const f4 = pipe(S[f4Key], /^position \| way \| share/);
      out.push(card('Picking players before each 4 gameweeks',
        p('Each way names its top players before 4 gameweeks start, the same numbers as the core group (GK 15, DEF 35, MID 35, FWD 15), using only what it knew then, against the real top of those 4 gameweeks, averaged over the season. Over just 4 gameweeks luck decides most of it, so no way finds even half; what matters is which finds more.'),
        table(['Position', 'Way of guessing', 'Real top found', 'Points of its picks / points of the real top'],
          f4.map((r) => [POSN[r[0]] || r[0], NAMES[r[1]] || r[1], r[2], r[3]]), { mark: (r) => r[1] === 'This site' })));
    }

    // 2. decisions
    const dec = (S['Decisions: mean actual points per GW'] || []).filter((l) => l.trim());
    if (dec.length > 1) {
      const rows = dec.slice(1).map((l) => l.trim().split(/\s{2,}/));
      out.push(card('Would it have picked the right players?',
        p('Each gameweek, the player each way rated highest as captain, and the 10 it rated highest: their ', b('real'), ' points per gameweek on average (captain not doubled).'),
        table(['Way of guessing', 'Captain pick', 'Top 10 average'], rows.filter((r) => !/^FPL xP/.test(r[0])).map((r) => [NAMES[r[0]] || r[0], f(num(r[1]), 2), f(num(r[2]), 2)]), { mark: (r) => r[0] === 'This site' })));
    }

    // 3. calibration
    const cal = (S['Calibration, regulars'] || []).filter((l) => l.trim());
    if (cal.length > 1) {
      const rows = cal.slice(1).map((l) => l.trim().split(/\s+/));
      out.push(card('Are the numbers too high or too low?',
        p('Regular starters, split into 10 equal groups from the lowest predictions to the highest. In each group, the average prediction next to the average real points. Close together means the numbers can be taken at face value.'),
        table(['Group', 'Predicted', 'Real', 'Player-GWs'], rows.map((r, k) => [String(k + 1), r[0], r[1], r[2]])),
        p('The top groups come out a little high (about 0.2 to 0.4 points a gameweek), so treat the very biggest numbers as slightly generous.')));
    }

    // 4b. minutes of the players worth buying (xMin 60+), from tools/xmin_backtest.py
    if (xm && xm.bands) {
      const pc = (x) => `${Math.round(x * 100)}%`, sg = (x) => `${x >= 0 ? '+' : ''}${f(x)}`;
      const top = xm.bands[0], tp = xm.top_by_pos || {};
      out.push(card('Minutes of the players worth buying (xMin 60+)',
        p(`Every league match of ${xm.seasons.join(' and ')} where a player's xMin before the match was 60 or more, with the injuries and bans known from FotMob and Soccerway taken into account. Matches with a red card (${xm.removed.red}), a ban (${xm.removed.ban}) or an injury picked up in the match (${xm.removed.injured_in_match}) are left out: no forecast can see those coming. `,
          b('Average miss'), ' is how far xMin was from his real minutes; ', b('Bias'), ' above 0 means xMin was too high.'),
        table(['xMin', 'xMin (avg)', 'Real (avg)', 'Bias', 'Average miss', 'Within 10 min', 'Real 60+', 'Matches'],
          xm.bands.map((r) => [r.band, f(r.pred), f(r.real), sg(r.bias), f(r.mae), pc(r.within10), pc(r.real60), String(r.n)]), { mark: (r) => r[0] === '80–90' }),
        el('h3', { textContent: 'What really happened' }),
        table(['xMin', '0 min', '1–59', '60–89', '90', 'Not in the starting XI', 'When he started: average miss', 'Bias'],
          xm.bands.map((r) => [r.band, pc(r.zero), pc(r.sub), pc(r.p60_89), pc(r.full), `${r.not_started} (${pc(r.not_started / r.n)})`, f(r.started_mae), sg(r.started_bias)])),
        p(b('80–90'), `: regular starters. They started ${pc(1 - top.not_started / top.n)} of these matches, and when they started xMin was off by only ${f(top.started_mae)} minutes. Almost all the bias comes from the ${pc(top.not_started / top.n)} of matches (about 1 in ${Math.round(top.n / top.not_started)}) where he was left out of the starting XI without an injury or ban on record: `,
          ['GK', 'DEF', 'MID', 'FWD'].filter((k) => tp[k]).map((k) => `${k} ${pc(tp[k].not_started / tp[k].n)}`).join(', '), '. Some of these were surely unrecorded knocks, so the true share of surprise benchings is a little lower.'),
        xm.bench_by_gw ? el('h3', { textContent: `Left out of the starting XI by gameweek, ${xm.bench_by_gw.season} (xMin 80+)` }) : null,
        xm.bench_by_gw ? p('Players on 80+ xMin who did not start, with no injury or ban on record (red cards, bans and injuries picked up in the match left out). Midweek rounds and a few special weeks stand out; a normal weekend is about 1 in 20.') : null,
        xm.bench_by_gw ? (() => { const R = xm.bench_by_gw.rows; const all = R.reduce((a, r) => [a[0] + r.not_started, a[1] + r.n], [0, 0]);
          const norm = R.filter((r) => !r.midweek && !r.note).reduce((a, r) => [a[0] + r.not_started, a[1] + r.n], [0, 0]);
          return el('details', {}, el('summary', { textContent: `By gameweek: ${all[0]} of ${all[1]} (${pc(all[0] / all[1])}); normal weekends ${pc(norm[0] / norm[1])}` }),
            table(['GW', 'Date', 'Round', 'Not started', 'Of them 0 min', 'Players on 80+', 'Share'],
              R.map((r) => [`GW${r.gw}`, r.date, [r.midweek ? 'Midweek' : 'Weekend', r.note].filter(Boolean).join(', '), String(r.not_started), String(r.zero), String(r.n), `${(r.not_started / r.n * 100).toFixed(1)}%`]),
              { mark: (r) => parseFloat(r[6]) >= 9 })); })() : null,
        p(b('70–80'), ' and ', b('60–70'), ': rotation risks. They miss the starting XI in about 1 match in 6 and 1 in 3. When they do start they play more than their xMin, so the figure is right as an average (for expected points) but any one match is a gamble.')));
    }

    // 5. chances
    const ch = (S['Chance 90min: each chance against what happened (test season)'] || []).filter((l) => /\d/.test(l) && !/^Skill/.test(l.trim()));
    if (ch.length) {
      // Sorting is judged against the best a model could do (its ceiling), averages against what happened.
      const sortGrade = (auc, top) => { if (!(auc > 0) || !(top > 0.5)) return '–'; const r = (auc - 0.5) / (top - 0.5);
        return r >= 0.95 ? 'Excellent' : r >= 0.85 ? 'Good' : r >= 0.7 ? 'Average' : 'Weak'; };
      const avgGrade = (pr, ha) => { const e = Math.abs(pr - ha) / Math.max(ha, 1e-9);
        return e <= 0.05 ? 'Excellent' : e <= 0.1 ? 'Good' : e <= 0.2 ? 'Average' : 'Off'; };
      const pc = (x) => parseFloat(x) / 100;
      out.push(card('Chance 90min figures',
        p('Each chance on the Chance 90min page, judged two ways. Goals (Score 1+ and xGoals) leave penalties out, both predicted and real: past seasons have no penalty order to share penalties by.'),
        p(b('On average'), ': the average predicted chance next to how often it really happened. Excellent when they are within 5% of each other (26.1% against 25.5% is 2% apart), Good within 10%, Average within 20%, Off beyond that.'),
        p(b('Sorting'), ': how often a match where it happened was rated above one where it did not (0.5 is a coin flip, 1 is perfect). How high it can go depends on the event, not only on the model: a clean sheet is close to a coin flip even for the best team, so even exactly right chances would only reach about 0.65, while whether a player starts can be called much better. ',
          b('Best possible'), ' is the score the chances would get if each one were exactly right, and the grade compares the two: Excellent at 95% or more of the way from a coin flip to the best possible, Good from 85%, Average from 70%, Weak below. Above the best possible means the chances were too cautious: the players rated high did even better than said.'),
        table(['Figure', 'Predicted', 'Happened', 'On average', 'Sorting', 'Best possible', 'Sorting grade'], ch.map((l) => {
          const m = l.trim().match(/^(.+?)\s+(\d+)\s+([\d.]+%)\s+([\d.]+%)\s+\S+\s+\S+\s+([\d.]+|nan)\s+([\d.]+|nan)$/);
          return m ? [m[1], m[3], m[4], avgGrade(pc(m[3]), pc(m[4])), m[5], m[6], sortGrade(parseFloat(m[5]), parseFloat(m[6]))] : null; }).filter(Boolean)),
        p('Playing at all and playing 60+ minutes are predicted very well. Goals, assists and clean sheets are right on average and sort about as well as such chancy events allow. Penalty saves and red cards are too rare to call at all, so everyone gets about the average.')));
    }

    // 5b. team goals and clean sheets (the Team odds page)
    const tmKey = Object.keys(S).find((k) => k.startsWith('Team goals and clean sheets'));
    // clean sheet chance in steps of 2%: how many matches at each, and the real share against the predicted
    const csCharts = (rows) => {
      if (!rows.length) return [];
      const labels = rows.map((r) => r[0]), n = rows.map((r) => +r[1]);
      const ok = rows.filter((r) => +r[1] >= 20);
      return [
        el('h3', { textContent: 'How often each clean sheet chance came up' }),
        p('Every team-match by its predicted clean sheet chance, in steps of 2% (20% means 20–21.9%).'),
        svgChart({ labels, series: [{ name: 'Matches', values: n, color: 'var(--turf)' }], bars: true, yTitle: 'Matches', xTitle: 'Predicted clean sheet chance' }),
        el('h3', { textContent: 'Real clean sheets at each predicted chance' }),
        p('The real share of clean sheets in each step of 2% against the middle of the step; only steps with 20 matches or more. A clean sheet is yes or no, so with about 50 matches a step the real share moves about 6 points either way by luck alone; the 7 equal groups above are steadier.'),
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
      const gb = rowsOf('Goals by expected band'), cb = rowsOf("Clean sheets by the opponent's expected goals"), clubs = rowsOf('Season totals by club');
      const corr = (L.find((l) => l.startsWith('correlation of season totals')) || '').split('|')[1] || '';
      out.push(card('Team goals and clean sheets',
        p(`Every club's expected goals and clean sheet chance in each of the ${g.matches || ''} team-matches of the test season (the figures on the Team odds page), against what happened.`),
        el('h3', { textContent: 'Goals' }),
        p('On average: expected ', b(g['expected goals, average'] || '–'), ' goals a match, real ', b(g['real goals, average'] || '–'),
          '. A single match is hard to call (average miss ', b(g['average miss'] || '–'), ' goals, against ', b(g['average miss, everyone at the league home/away average'] || '–'),
          ' if every team got the league average), but in 7 groups with the same number of matches, by the expected figure, the real goals match it closely:'),
        table(['Expected goals', 'Matches', 'Expected', 'Real'], gb),
        ...goalCharts(rowsOf('Expected goals in steps of 0.1')),
        el('h3', { textContent: 'Clean sheets' }),
        p('Predicted ', b(c['predicted share'] || '–'), ' of matches, real ', b(c['real share'] || '–'), '. A clean sheet means the opponent scores 0, so the two figures go together: the more goals the opponent is expected to score, the lower the chance. Grouped by the opponent\'s expected goals, in 7 groups with the same number of matches:'),
        table(["Opponent's expected goals", 'Matches', 'Opponent expected', 'Clean sheet predicted', 'Clean sheet real', 'Goals conceded real'], cb),
        ...csCharts(rowsOf('Clean sheet chance in steps of 2%')),
        el('h3', { textContent: 'Season totals by club' }),
        p(`How close the season adds up for each club (correlation: ${corr.trim()}).`),
        table(['Club', 'Matches', 'Expected goals', 'Real goals', 'Expected CS', 'Real CS'], clubs)));
    }

    // 6. goals / assists by band
    const gaKey = Object.keys(S).find((k) => k.startsWith('Chance to score / assist'));
    const ga = gaKey ? S[gaKey] : [];
    const gl = block(ga, 'Goals (no pens)').length ? block(ga, 'Goals (no pens)') : block(ga, 'Goals'), as = block(ga, 'Assists');
    if (gl.length) {
      const fix = (rows) => rows.map((r) => [r[0].replace(/[(\]]/g, '').replace('-0.001', '0').split(', ').map((x) => pct(num(x) * 100)).join('–'), pct(num(r[1]) * 100), pct(num(r[2]) * 100), r[3]]);
      out.push(card('Chance to score and to assist',
        p('Players who played, grouped by their predicted chance; the real share who scored (or assisted) in each group. Goals leave penalties out, both predicted and real: past seasons have no penalty order to share penalties by, so the test judges open-play goals only.'),
        el('h3', { textContent: 'Goals (no penalties)' }), table(['Predicted band', 'Predicted', 'Scored', 'Matches'], fix(gl)),
        as.length ? el('h3', { textContent: 'Assists' }) : null, as.length ? table(['Predicted band', 'Predicted', 'Assisted', 'Matches'], fix(as)) : null));
    }

    // 7. the rest as text
    const cards = S['Cards and DEFCON: predicted vs actual'] || [];
    const lines = cards.filter((l) => /: predicted/.test(l));
    if (lines.length) {
      out.push(card('Cards, saves and goals conceded', el('ul', {}, ...lines.map((l) => el('li', { textContent: l.trim().replace('predicted', 'predicted').replace(/, n=\d+/, '') })))));
    }
    out.push(el('details', { className: 'acc-raw' }, el('summary', { textContent: 'Technical details (full output)' }), el('pre', { textContent: text })));
    $('out').replaceChildren(...out);
    $('status').textContent = `The model tested on ${season}, a season it was not trained on`;
  }

  const xmin = fetch('xmin_accuracy.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  fetch('backtest.txt', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(async (t) => render(t.split('\n').filter((l) => !/Warning|^\s+(df|self|tm|return)\b/.test(l)).join('\n'), await xmin))
    .catch(() => { $('error').hidden = false; $('error').textContent = 'Could not load the test results. They appear here once the GitHub update has run.'; $('status').textContent = ''; });
})();
