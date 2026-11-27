// Minutes page, Accuracy tab: how close xMin was to the real minutes (xmin_accuracy.json, from tools/xmin_backtest.py).
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== '')); return n; };
  const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  const p = (...kids) => el('p', {}, ...kids);
  const b = (t) => el('b', { textContent: t });
  const card = (title, ...kids) => el('section', { className: 'acc-card' }, el('h2', { textContent: title }), ...kids);
  const table = (head, rows, opts = {}) => el('div', { className: 'wrap' }, el('table', { className: 'acc-table' },
    el('thead', {}, el('tr', {}, ...head.map((h, k) => el('th', { scope: 'col', className: k ? 'num' : '', textContent: h })))),
    el('tbody', {}, ...rows.map((r) => el('tr', { className: opts.mark && opts.mark(r) ? 'on' : '' }, ...r.map((c, k) => el('td', { className: k ? 'num' : '', textContent: c })))))));
  let loaded = false;
  function sections(text) {
    const sec = {};
    let cur = null;
    text.split('\n').forEach((line) => {
      const m = line.match(/^=== (.+?) ===/);
      if (m) { cur = m[1]; sec[cur] = []; return; }
      if (cur && line.trim()) sec[cur].push(line);
    });
    return sec;
  }
  const rowsOf = (lines) => (lines || []).filter((l) => l.includes(' | ')).slice(1).map((l) => l.split(' | ').map((x) => x.trim()));
  // the chances (Start, Appearance 1+, 60+, Under 60, Not playing) and Min60 / Min1, from backtest.txt
  function drawChances(text) {
    const S = sections(text);
    const main = rowsOf(S['Minutes chances']);
    if (!main.length) return null;
    const intro = (S['Minutes chances'] || []).find((l) => l.startsWith('Every')) || '';
    const out = [el('h2', { textContent: 'How accurate the minutes chances are' }),
      p(`Tested on last season (2025-26): each chance was worked out before the match, the same way as now, and checked against what happened. ${intro}.`),
      p(b('Predicted'), ' = the average chance; ', b('Real'), ' = how often it happened. ', b('Skill'), ': how much better than giving every match the same average chance (0 = no better, 1 = perfect). ', b('AUC'), ': how well it puts the matches where it happened above those where it did not (0.5 = a coin flip, 1 = perfect).'),
      table(['Figure', 'Matches', 'Predicted', 'Real', 'Skill', 'AUC'], main)];
    const byFig = {};
    rowsOf(S['Minutes chances, by predicted chance']).forEach((r) => { (byFig[r[0]] = byFig[r[0]] || []).push(r.slice(1)); });
    Object.entries(byFig).forEach(([fig, rows]) => out.push(el('h3', { textContent: `${fig}: by predicted chance` }), table(['Predicted chance', 'Predicted', 'Real', 'Matches'], rows)));
    return el('section', { className: 'acc-card' }, ...out);
  }
  function draw([text, xm]) {
    const box = $('accBox');
    const first = text ? drawChances(text) : null;
    // 4b. minutes of the players worth buying (xMin 60+), from tools/xmin_backtest.py
    if (xm && xm.bands) {
      const pc = (x) => `${Math.round(x * 100)}%`, sg = (x) => `${x >= 0 ? '+' : ''}${f(x)}`;
      const top = xm.bands[0], tp = xm.top_by_pos || {};
      box.replaceChildren(...(first ? [first] : []), card('How accurate xMin is: players worth buying (xMin 60+)',
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

    else box.replaceChildren(first || el('p', { className: 'meta', textContent: 'No minutes accuracy figures yet.' }));
  }
  function show(v) {
    document.querySelectorAll('#viewSeg button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === v)));
    const acc = v === 'accuracy';
    $('accBox').hidden = !acc;
    $('filters').hidden = acc;
    document.querySelector('main').hidden = acc;
    const ft = document.querySelector('footer'); if (ft) ft.hidden = acc;
    if (acc && !loaded) {
      loaded = true;
      Promise.all([fetch('backtest.txt', { cache: 'no-cache' }).then((r) => (r.ok ? r.text() : null)).catch(() => null),
        fetch('xmin_accuracy.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)]).then(draw)
        .catch((e) => $('accBox').replaceChildren(el('p', { className: 'error', textContent: `Could not load the figures (${e.message}).` })));
    }
  }
  document.querySelectorAll('#viewSeg button').forEach((x) => x.addEventListener('click', () => show(x.dataset.view)));
})();
