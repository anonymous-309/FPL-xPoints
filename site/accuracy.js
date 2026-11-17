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
  const card = (title, ...kids) => el('section', { className: 'acc-card' }, el('h2', { textContent: title }), ...kids);
  const p = (...kids) => el('p', {}, ...kids);
  const b = (t) => el('b', { textContent: t });

  function render(text) {
    const season = (text.match(/training before (\d{4}-\d{2})/) || [])[1] || 'a past season';
    const S = sections(text);
    const out = [];
    const NAMES = { 'Model': 'This site', 'Trailing 4 GW': 'Points in his last 4 GWs', 'Long-run PPG': 'Points per game, long run' };

    // 1. points
    const acc = S['Prediction accuracy'] || [];
    const all = block(acc, 'All player-GWs'), reg = block(acc, 'Regulars (prior avg >=45 min)');
    if (all.length) {
      const row = (name) => all.find((r) => r[0] === name);
      const m = row('Model'), t4 = row('Trailing 4 GW');
      const better = m && t4 ? (1 - num(m[3]) / num(t4[3])) * 100 : NaN;
      out.push(card('How close are the points?',
        p(`Tested on every player in every gameweek of ${season}. `, b('Average miss'), ' is how far, on average, the prediction was from the points he really scored. ', b('Order'),
          ' (0 to 1) is how well the predictions put players in the right order from best to worst: 1 would be perfect.'),
        table(['Way of guessing', 'Average miss (points)', 'Order (all players)', 'Order (regular starters)'],
          all.filter((r) => !/^FPL xP/.test(r[0])).map((r) => { const rr = reg.find((x) => x[0] === r[0]); return [NAMES[r[0]] || r[0], f(num(r[3]), 2), f(num(r[5]), 2), rr ? f(num(rr[5]), 2) : '–']; }),
          { mark: (r) => r[0] === 'This site' }),
        Number.isFinite(better) ? p('This site misses by about ', b(`${f(better, 0)}% less`), ' than going by recent points, and puts players in a better order than either simple way. Any one gameweek is still very random: a regular starter is typically off by 2 to 3 points either way, from goals, assists and bonus nobody can call.') : null,
));
    }

    // 1b. top scorers
    const topKey = Object.keys(S).find((k) => k.startsWith('Top FPL scorers'));
    if (topKey) {
      const lines = S[topKey];
      const head = lines.findIndex((l) => /\bgroup\b/.test(l) && /\bMAE\b/.test(l));
      const rows = [];
      for (let j = head + 1; head >= 0 && j < lines.length && lines[j].trim(); j++) rows.push(lines[j].split('|').map((x) => x.trim()));
      for (let j = rows.length - 1; j >= 0; j--) if (/^FPL xP/.test(rows[j][1])) rows.splice(j, 1);
      const POS = { GK: 'Goalkeepers (top 10)', DEF: 'Defenders (top 20)', MID: 'Midfielders (top 20)', FWD: 'Forwards (top 10)', All: 'All 60' };
      const groups = [...new Set(rows.map((r) => r[0]))];
      const tIdx = lines.findIndex((l) => /^Top scorers, season totals/.test(l.trim()));
      const tot = [];
      for (let j = tIdx + 2; tIdx >= 0 && j < lines.length && lines[j].trim(); j++) tot.push(lines[j].split('|').map((x) => x.trim()));
      out.push(card('The players who matter most',
        p(`The top scorers of ${season}: 10 goalkeepers, 20 defenders, 20 midfielders and 10 forwards by FPL points. Every gameweek of theirs, `, b('Average miss'), ' (points), ', b('Bias'),
          ' (above 0: predicted too high on average) and ', b('Order'), ' (how well the predictions follow their good and bad weeks, 0 to 1).'),
        table(['Group', 'Way of guessing', 'Average miss', 'Bias', 'Order'],
          groups.flatMap((g) => rows.filter((r) => r[0] === g).map((r) => [POS[g] || g, NAMES[r[1]] || r[1], f(num(r[3]), 2), `${num(r[4]) >= 0 ? '+' : ''}${f(num(r[4]), 2)}`, f(num(r[5]), 2)])),
          { mark: (r) => r[1] === 'This site' }),
        (() => { const all = rows.find((r) => r[0] === 'All' && r[1] === 'Model'); if (!all) return null; const bias = num(all[4]);
          return p(bias < 0 ? `Over all 60, the predictions were ${f(-bias, 2)} points a gameweek below what they scored. Some of that is expected: these players were picked out after the season, partly for the good luck they had, which no forecast made beforehand can see.`
            : `Over all 60, the predictions were ${f(bias, 2)} points a gameweek above what they scored.`); })(),
        tot.length ? el('details', {}, el('summary', { textContent: 'Each of the 60: season points against the sum of the predictions' }),
          table(['Pos', 'Player', 'Team', 'Real', 'Predicted', 'Difference', 'GWs'], tot.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]]))) : null));
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

    // 4. minutes
    const mins = (S['Minutes by weighted last-5 average: predicted vs actual, per match'] || []).filter((l) => /^\(/.test(l.trim()));
    const minErr = (text.match(/Minutes MAE, regulars: ([\d.]+)/) || [])[1];
    if (mins.length) {
      out.push(card('How close are the minutes?',
        p('Players grouped by their recent minutes (the 5-4-3-2-1 average). Predicted minutes and chance of 60+ next to what happened.'),
        table(['Recent minutes', 'xMin', 'Real minutes', 'Chance of 60+', 'Real 60+', 'Matches'],
          mins.map((l) => { const m = l.trim().match(/^\(([-\d.]+), ([\d.]+)\]\s+(.*)$/); if (!m) return null; const r = m[3].trim().split(/\s+/);
            return [`${Math.max(0, num(m[1]))}–${m[2]}`, f(num(r[0]), 0), f(num(r[1]), 0), pct(num(r[2]) * 100), pct(num(r[3]) * 100), r[4]]; }).filter(Boolean)),
        p(minErr ? `For regular starters xMin is off by about ${f(num(minErr), 0)} minutes a match on average. ` : '',
          'Players on 85-90 minutes really average around 80: some go off injured, are rested or dropped without warning. The minutes rules (injuries, bans, rests) take care of what is known before the deadline.')));
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
        p('Each chance on the Chance 90min page, judged two ways.'),
        p(b('On average'), ': the average predicted chance next to how often it really happened. Excellent when they are within 5% of each other (26.1% against 25.5% is 2% apart), Good within 10%, Average within 20%, Off beyond that.'),
        p(b('Sorting'), ': how often a match where it happened was rated above one where it did not (0.5 is a coin flip, 1 is perfect). How high it can go depends on the event, not only on the model: a clean sheet is close to a coin flip even for the best team, so even exactly right chances would only reach about 0.65, while whether a player starts can be called much better. ',
          b('Best possible'), ' is the score the chances would get if each one were exactly right, and the grade compares the two: Excellent at 95% or more of the way from a coin flip to the best possible, Good from 85%, Average from 70%, Weak below. Above the best possible means the chances were too cautious: the players rated high did even better than said.'),
        table(['Figure', 'Predicted', 'Happened', 'On average', 'Sorting', 'Best possible', 'Sorting grade'], ch.map((l) => {
          const m = l.trim().match(/^(.+?)\s+(\d+)\s+([\d.]+%)\s+([\d.]+%)\s+\S+\s+\S+\s+([\d.]+|nan)\s+([\d.]+|nan)$/);
          return m ? [m[1], m[3], m[4], avgGrade(pc(m[3]), pc(m[4])), m[5], m[6], sortGrade(parseFloat(m[5]), parseFloat(m[6]))] : null; }).filter(Boolean)),
        p('Playing at all and playing 60+ minutes are predicted very well. Goals, assists and clean sheets are right on average and sort about as well as such chancy events allow. Penalty saves and red cards are too rare to call at all, so everyone gets about the average.')));
    }

    // 6. goals / assists by band
    const ga = S['Chance to score / assist: predicted vs actual (players who played)'] || [];
    const gl = block(ga, 'Goals'), as = block(ga, 'Assists');
    if (gl.length) {
      const fix = (rows) => rows.map((r) => [r[0].replace(/[(\]]/g, '').replace('-0.001', '0').split(', ').map((x) => pct(num(x) * 100)).join('–'), pct(num(r[1]) * 100), pct(num(r[2]) * 100), r[3]]);
      out.push(card('Chance to score and to assist',
        p('Players who played, grouped by their predicted chance; the real share who scored (or assisted) in each group.'),
        el('h3', { textContent: 'Goals' }), table(['Predicted band', 'Predicted', 'Scored', 'Matches'], fix(gl)),
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

  fetch('backtest.txt', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then((t) => render(t.split('\n').filter((l) => !/Warning|^\s+(df|self|tm|return)\b/.test(l)).join('\n')))
    .catch(() => { $('error').hidden = false; $('error').textContent = 'Could not load the test results. They appear here once the GitHub update has run.'; $('status').textContent = ''; });
})();
