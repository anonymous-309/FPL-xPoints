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

    // (minutes of the players worth buying: on the Minutes page, Accuracy tab)

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

    // (team goals and clean sheets: on the Team odds page, Accuracy tab)

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
