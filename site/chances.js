(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { data: null, pos: '', sort: 'order', dir: 1, hideOut: true, overrides: XMin.load() };
  // key, header, value at full colour, format ('pct', 'pct1' or number of decimals)
  const METRICS = [
    ['pStart', 'Start', 1, 'pct'], ['pApp1', 'Appearance 1+', 1, 'pct'], ['pApp60', 'Appearance 60+', 1, 'pct'], ['pUnder60', 'Under 60', 1, 'pct'], ['pNotPlay', 'Not playing', 1, 'pct'],
    ['pScore', 'Score 1+', 0.6, 'pct'], ['npxGoals', 'NPxGoals', 0.8, 2], ['xPenGoals', 'Pen goals', 0.15, 2], ['pAssist', 'Fantasy Assist 1+', 0.35, 'pct'], ['xAssists', 'xAssists', 0.45, 2],
    ['pCs', 'Clean sheet', 0.6, 'pct'], ['xConceded', 'Conceded', 2.4, 2], ['pDefcon', 'DefCon', 0.7, 'pct'], ['xDefcon', 'DefCon actions', 14, 1], ['xSaves', 'Saves', 4.5, 1],
    ['pPenSave', 'Pen save', 0.03, 'pct1'], ['pPenMiss', 'Pen miss', 0.03, 'pct1'], ['pOwnGoal', 'Own goal', 0.03, 'pct1'],
    ['pRed', 'Red card', 0.02, 'pct1'], ['pYellow', 'Yellow card', 0.4, 'pct'], ['xBps', 'BPS', 32, 0], ['bonus', 'Bonus', 1.5, 2],
  ];
  // (i) on each column: what it is, where it comes from, how xPoints uses it
  const INFO = {
   "pApp1": [
    "Appearance 1+",
    "Chance he plays at least 1 minute",
    "Share of matches he played, weighted 5-4-3-2-1, times the FPL flag",
    "+1 point × this chance"
   ],
   "pApp60": [
    "Appearance 60+",
    "Chance he plays 60+ minutes",
    "As above, counting matches with 60+ minutes",
    "+1 more point × this chance. Also the factor for clean sheet and goals conceded."
   ],
   "pScore": [
    "Score 1+",
    "Chance he scores at least once, penalties included",
    "1 − e<sup>−(NPxGoals + Pen goals)</sup>",
    "For reference only; xPoints uses NPxGoals and Pen goals"
   ],
   "npxGoals": [
    "NPxGoals",
    "Expected open-play goals (no penalties) over 90 minutes",
    "Non-penalty xG per 90, built in steps. (1) A starting figure from his shot volume: his position's average xG per 90 × his shots per 90 against the position's (shots from FPL Core; their weight halves every 6 gameweeks). (2) His own non-penalty xG over up to 38 matches (weight halving every 12 gameweeks), padded with 10 such starting 90s, so a new player leans on his shots and an established one on his xG. (3) Finishing: his non-penalty goals (50%) and xG on target (25%) against his xG, trusted only after about 15 xG. (4) A Poisson model adds recent form, his shots and key passes, his team's attack, the opponent's defence and home or away. NPxG = FPL's xG minus 0.79 per penalty taken.",
    "(NPxGoals + Pen goals) × xMin/90 × goal points (FWD 4, MID 5, DEF 6, GK 10)"
   ],
   "xPenGoals": [
    "Pen goals",
    "Expected penalty goals over 90 minutes",
    "Team penalties per match × his pen share × 0.79 (a penalty's xG: about 21% are missed or saved). His pen share: the number 1 takes every penalty while he is on the pitch; the number 2 takes those left while the number 1 is off, and so on (the chance each is on the pitch comes from his minutes). The Pen share on the <a href=\"setpieces.html\">Set pieces</a> page is this share times xMin/90. If you edit the xMin of a taker above him on the Minutes page, this follows.",
    "Added to NPxGoals as above"
   ],
   "xAssists": [
    "xAssists",
    "Expected assists over 90 minutes",
    "The same way as NPxGoals with key passes: a starting figure from his key passes per 90 (passes that led to a shot) against his position's, his own xA padded with 10 such 90s, how his assists compare with his xA, then form, his key passes and shots, his team's attack, the opponent's defence and home or away.",
    "xAssists × xMin/90 × 3"
   ],
   "pAssist": [
    "Fantasy Assist 1+",
    "Chance of at least one FPL assist",
    "1 − e<sup>−xAssists</sup>",
    "For reference only"
   ],
   "pCs": [
    "Clean sheet",
    "Chance his team keeps a clean sheet",
    "e<sup>−Conceded</sup>: the chance of conceding 0",
    "Appearance 60+ × the chance of no goal while he is on (his minutes in a 60+ match, not always 90) × clean sheet points (GK/DEF 4, MID 1, FWD 0)"
   ],
   "xConceded": [
    "Conceded",
    "Goals his team is expected to concede",
    "His team's defence and the opponent's attack (real goals 70%, xG 30%), home or away",
    "GK/DEF: −1 point per 2 goals conceded, as the expected value of (goals conceded while he is on ÷ 2, rounded down), times Appearance 60+"
   ],
   "xDefcon": [
    "DefCon actions",
    "Defensive actions FPL counts (clearances, blocks, interceptions, tackles; recoveries too for MID and FWD)",
    "His own record, his team and the opponent (data from 2025-26)",
    "Used for DefCon"
   ],
   "pDefcon": [
    "DefCon",
    "Chance of reaching the DefCon threshold: 10 actions for DEF, 12 for MID and FWD",
    "From DefCon actions: the chance of reaching the threshold with that many expected over 90 (a count a little more spread than Poisson, checked on 2025-26 full-90 matches)",
    "2 points × (Appearance 60+ × the chance in his minutes when he plays 60+ + the chance of a short appearance × the chance in those minutes): his DefCon actions × minutes/90 is what he is expected to make, and the chance of reaching 10 or 12 with that many falls fast with fewer minutes (not for GK)."
   ],
   "xSaves": [
    "Saves",
    "Expected saves (GK only)",
    "His save record, his team's defence, the opponent's attack",
    "+1 point per 3 saves: the expected value of (saves ÷ 3, rounded down) × xMin/90"
   ],
   "pPenSave": [
    "Pen save",
    "Chance he saves a penalty (GK only)",
    "Penalties the opponent is expected to win (league rate × the opponent's attack) × the share of penalties saved (about 12%)",
    "Expected number × xMin/90 × 5"
   ],
   "pPenMiss": [
    "Pen miss",
    "Chance he misses a penalty",
    "Penalties he takes × the league miss rate",
    "Expected number × xMin/90 × (−2)"
   ],
   "pOwnGoal": [
    "Own goal",
    "Chance of an own goal",
    "His own rate, pulled hard towards the average because own goals are rare",
    "Expected number × xMin/90 × (−2)"
   ],
   "pRed": [
    "Red card",
    "Chance of a red card",
    "The average for his position; red cards are too rare to judge players one by one",
    "Expected number × xMin/90 × (−3)"
   ],
   "pYellow": [
    "Yellow card",
    "Chance of a yellow card",
    "His yellow card rate over about his last 114 matches, pulled towards the position average",
    "Expected number × xMin/90 × (−1)"
   ],
   "xBps": [
    "BPS",
    "Expected BPS score over 90 minutes",
    "His BPS record, form, his team and the opponent",
    "Used for Bonus"
   ],
   "bonus": [
    "Bonus",
    "Expected bonus points over 90 minutes",
    "The average of two methods. (1) A per-player model from his past bonus and BPS. (2) Each match simulated 2,000 times: goals go to scorers by NPxGoals + Pen goals and to assisters by xAssists, clean sheets are added, plus each player's base BPS. The top 3 BPS from both teams get 3, 2 and 1.",
    "Bonus × xMin/90"
   ],
   "pStart": [
    "Start",
    "Chance he starts the match",
    "The share of his last 5 matches he started, weighted 5-4-3-2-1 (newest first, the same matches as his usual minutes), times the share of his usual minutes he is expected to play now (FPL flags, your edits on the Minutes page)",
    "Not used directly; it places the penalty takers on the pitch (Pen goals)"
   ],
   "pUnder60": [
    "Under 60",
    "Chance he plays 1 to 59 minutes",
    "Appearance 1+ minus Appearance 60+",
    "1 appearance point; no clean sheet; DefCon in his short-match minutes"
   ],
   "pNotPlay": [
    "Not playing",
    "Chance he does not come on",
    "100% minus Appearance 1+",
    "No points (your bench player comes on instead)"
   ]
  };
  const LEAGUE_MISS = 0.22;
  const cache = new Map();
  // Goals split into open play (NPxGoals) and penalties. The penalty share follows the minutes set on the Minutes
  // page for the takers above him, so Score 1+, Pen goals and Pen miss move with them.
  function figures(p, g) {
    if (!p.byGw[g]) return null;
    const d = XMin.withEdits(state.overrides, p, g, p.byGw[g]);
    const key = `${p.id}|${g}`;
    if (cache.has(key)) return cache.get(key);
    const miss = p.penMiss == null ? LEAGUE_MISS : p.penMiss;
    let penModel = 0, pen = 0, missed = 0;
    (d.fx || []).forEach((_, j) => {
      const tp = d.tp ? d.tp[j] : 0;
      penModel += (d.pc ? d.pc[j] : 0) * tp * (1 - miss);
      const pens = XMin.penCond(state.overrides, p, g, j) * tp;
      pen += pens * (1 - miss);
      missed += pens * miss;
    });
    const np = Math.max(0, d.xGoals - penModel);
    const out = { ...d, pUnder60: Math.max(0, d.pApp1 - d.pApp60), pNotPlay: 1 - d.pApp1, pStart: XMin.startChance(state.overrides, p, g), npxGoals: np, xPenGoals: pen, pScore: 1 - Math.exp(-(np + pen)), pPenMiss: d.fx ? 1 - Math.exp(-missed) : d.pPenMiss };
    cache.set(key, out);
    return out;
  }
  // One match of a double gameweek on its own: the same figures for that match only.
  function matchFigures(p, g, j) {
    const d = p.byGw[g], m = XMin.withEdits(state.overrides, p, g, d.byMatch[j], j);
    const miss = p.penMiss == null ? LEAGUE_MISS : p.penMiss;
    const tp = d.tp ? d.tp[j] : 0;
    const penModel = (d.pc ? d.pc[j] : 0) * tp * (1 - miss);
    const pens = XMin.penCond(state.overrides, p, g, j) * tp;
    const np = Math.max(0, m.xGoals - penModel), pen = pens * (1 - miss);
    return { ...m, opp: [m.opp], pUnder60: Math.max(0, m.pApp1 - m.pApp60), pNotPlay: 1 - m.pApp1, pStart: XMin.startChanceAt(state.overrides, p, g, j), npxGoals: np, xPenGoals: pen,
      pScore: 1 - Math.exp(-(np + pen)), pPenMiss: 1 - Math.exp(-pens * miss), match: j + 1, of: d.byMatch.length };
  }
  // the rows of a player in gameweek g: one, or one per match in a double gameweek
  const rowsOf = (p, g) => (p.byGw[g].byMatch && p.byGw[g].byMatch.length > 1 ? p.byGw[g].byMatch.map((_, j) => matchFigures(p, g, j)) : [figures(p, g)]);
  const isChance = (fmt) => fmt === 'pct' || fmt === 'pct1';
  const notApplicable = (p, key) => ((key === 'pDefcon' || key === 'xDefcon') && p.position === 'GK') || ((key === 'xSaves' || key === 'pPenSave') && p.position !== 'GK');

  function heat(cell, t) {
    const v = Math.max(0, Math.min(1, t));
    cell.style.background = `color-mix(in srgb, #0e5a41 ${Math.round(v * 100)}%, #edf3ec)`;
    cell.style.color = v > 0.68 ? '#fff' : '#17261f';
  }

  function showInfo(key) {
    const [label, what, from, use] = INFO[key];
    let pop = document.getElementById('infoPop');
    if (!pop) {
      pop = el('div', { id: 'infoPop', className: 'info-pop', role: 'dialog' });
      document.body.append(pop);
      document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('#infoPop') && !e.target.closest('.info-btn')) pop.hidden = true; });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true; });
    }
    const para = (t, h) => { const n = el('p', {}); n.innerHTML = `<b>${t}</b> ${h}`; return n; };
    pop.replaceChildren(el('div', { className: 'info-head' }, el('b', { textContent: label }),
      el('button', { type: 'button', className: 'info-close', textContent: '×', 'aria-label': 'Close', onclick: () => { pop.hidden = true; } })),
      para('What it is:', what), para('Where it comes from:', from), para('In xPoints:', use));
    pop.hidden = false;
  }
  function header() {
    const cols = [['name', 'Player'], ['price', 'Price'], ['opp', 'Opponent'], ...METRICS.map(([k, l]) => [k, l])];
    $('table').tHead.replaceChildren(el('tr', {}, ...cols.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' || key === 'opp' ? 1 : -1; }
        render();
      } }));
      if (INFO[key]) th.append(el('button', { type: 'button', className: 'info-btn', textContent: 'i', 'aria-label': `About ${label}`, onclick: (e) => { e.stopPropagation(); showInfo(key); } }));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  function row(p, d) {
    const name = el('td', { className: 'player', title: p.news || p.fullName }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position}` }));
    if (p.role && p.role !== p.position) name.querySelector('b').append(' ', el('span', { className: 'oop', textContent: 'OOP', title: `Listed as ${p.position} but plays as ${p.role}` }));
    const cells = METRICS.map(([key, , full, fmt]) => {
      if (notApplicable(p, key)) return el('td', { className: 'none', textContent: '–' });
      const v = d[key];
      const text = fmt === 'pct' ? `${Math.round(v * 100)}%` : fmt === 'pct1' ? `${(v * 100).toFixed(1)}%` : v.toFixed(fmt);
      const c = el('td', { className: 'gw prob' }, el('strong', { textContent: text }));
      heat(c, v / full);
      return c;
    });
    const opp = el('td', { className: 'opp', textContent: d.opp.join(', ') });
    if (d.match) opp.append(el('span', { className: 'dgw-tag', textContent: ` (${d.match} of ${d.of})` }));
    return el('tr', { className: d.match > 1 ? 'dgw-next' : '' }, name, el('td', { textContent: `£${p.price.toFixed(1)}` }), opp, ...cells);
  }

  function render() {
    if (!state.data) return;
    header();
    $('order').setAttribute('aria-pressed', String(state.sort === 'order'));
    const gw = $('gw').value, q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value);
    const rank = state.sort === 'order' ? XMin.order(state.data, state.overrides) : null;
    const value = (p, d) => (rank ? rank(p) : state.sort === 'name' ? p.name.toLowerCase() : state.sort === 'price' ? p.price : state.sort === 'opp' ? d.opp.join() : d[state.sort]);
    const list = state.data.players
      .filter((p) => p.byGw[gw] && !(state.hideOut && Math.round(p.byGw[gw].pApp1 * 100) === 0 && Math.round(p.byGw[gw].pApp60 * 100) === 0) && (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
      .flatMap((p) => rowsOf(p, gw).map((d) => [p, d]))
      .sort(([a, da], [b, db]) => { const x = value(a, da), y = value(b, db); return (x < y ? -1 : x > y ? 1 : 0) * state.dir || (da.match || 0) - (db.match || 0); });
    $('table').tBodies[0].replaceChildren(...(list.length ? list.map(([p, d]) => row(p, d))
      : [el('tr', {}, el('td', { colSpan: METRICS.length + 3, className: 'none', textContent: 'No players match these filters. Widen the price, team or position.' }))]));
  }

  $('filters').addEventListener('input', render);
  $('order').addEventListener('click', () => { state.sort = 'order'; state.dir = 1; render(); });
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') { state.overrides = XMin.load(); cache.clear(); render(); } });
  $('hide-out').addEventListener('click', () => {
    state.hideOut = !state.hideOut;
    $('hide-out').setAttribute('aria-pressed', String(state.hideOut));
    render();
  });
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('#filters .seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('#filters .seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));

  fetch('data.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      state.data = data;
      XMin.setPlayers(data.players, data.penPatterns, data.dcSize);
      $('gw').replaceChildren(...data.gws.map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
      $('team').append(...[...new Set(data.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      const when = new Date(data.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
      $('status').textContent = `Updated ${when}`;
      $('wrap').hidden = false;
      render();
    })
    .catch(() => {
      $('error').textContent = 'Could not load the data. Check the latest run in the GitHub Actions tab, then reload this page.';
      $('error').hidden = false;
      $('status').textContent = 'No data yet';
    });

  // Accuracy tab: the Chance 90min figures tested on last season's matches where the player played the full 90
  let accLoaded = false;
  function showView(v) {
    document.querySelectorAll('#viewSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    const acc = v === 'accuracy';
    $('accBox').hidden = !acc;
    $('filters').hidden = acc;
    document.querySelector('main').hidden = acc;
    const notes = document.querySelector('footer'); if (notes) notes.hidden = acc;
    if (acc && !accLoaded) {
      accLoaded = true;
      fetch('backtest.txt', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(drawAcc).catch((e) => $('accBox').replaceChildren(el('p', { className: 'error', textContent: `Could not load the accuracy figures (${e.message}).` })));
    }
  }
  function drawAcc(text) {
    const sec = {};
    let cur = null;
    text.split('\n').forEach((line) => {
      const m = line.match(/^=== (.+?) ===/);
      if (m) { cur = m[1]; sec[cur] = []; return; }
      if (cur && line.includes(' | ')) sec[cur].push(line.split(' | ').map((x) => x.trim()));
    });
    const table = (head, rows) => el('div', { className: 'wrap' }, el('table', { className: 'acc-table' },
      el('thead', {}, el('tr', {}, ...head.map((h, k) => el('th', { scope: 'col', className: k ? 'num' : '', textContent: h })))),
      el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c, k) => el('td', { className: k ? 'num' : '', textContent: c })))))));
    const block = (name, title, intro) => {
      const main = (sec[name] || []).slice(1);
      const bands = (sec[`${name}, by predicted chance`] || []).slice(1);
      if (!main.length) return null;
      const out = [el('h2', { textContent: title }), ...intro.map((t) => el('p', { textContent: t })),
        table(['Figure', 'Matches', 'Predicted', 'Real', 'Skill', 'AUC'], main)];
      const byFig = {};
      bands.forEach((r) => { (byFig[r[0]] = byFig[r[0]] || []).push(r.slice(1)); });
      Object.entries(byFig).forEach(([fig, rows]) => {
        out.push(el('h3', { textContent: fig === 'Saves' ? 'Saves: by expected saves' : `${fig}: by predicted chance` }), table(fig === 'Saves' ? ['Expected saves', 'Predicted', 'Real', 'Matches'] : ['Predicted chance', 'Predicted', 'Real', 'Matches'], rows));
      });
      const ym = (sec[`${name}, yellow card by minutes played`] || []).slice(1);
      if (ym.length) out.push(el('h3', { textContent: 'Yellow card: by minutes he played' }), table(['Minutes', 'Predicted', 'Real', 'Matches'], ym));
      return el('section', { className: 'acc-card' }, ...out);
    };
    const explain = 'Predicted = the average chance the model gave (for saves: the average number); Real = how often it happened (the real number). Skill: how much better than giving every player his position\'s average (0 = no better, 1 = perfect). AUC: how well it puts the matches where it happened above those where it did not (0.5 = a coin flip, 1 = perfect).';
    const cards = [
      block('Chance 90min at real minutes', 'How accurate the Chance 90min figures are: at the minutes he really played, every match', [
        'Tested on last season (2025-26): every figure was worked out before each match, the same way as now, and checked against what happened. Every match he played (1 minute or more) is used. Each per-90 figure is scaled to the minutes he really played in that match (a 30-minute cameo gets a third of the 90-minute rate; DefCon uses his expected actions for those minutes). This tests the per-90 rates on all matches, still without any minutes guess.', explain]),
      block('Chance 90min on full-90 matches', 'How accurate the Chance 90min figures are: full-90 matches only', [
        'Only matches where the player played the full 90 minutes are used, because that is exactly what this page shows (every column assumes 90 minutes), so no minutes guess gets in the way.', explain]),
    ].filter(Boolean);
    if (!cards.length) { $('accBox').replaceChildren(el('p', { className: 'meta', textContent: 'No accuracy figures yet.' })); return; }
    if (cards.length > 1) {
      // two tests on this tab: say so at the top, with a jump to the second
      cards[1].id = 'acc-full90';
      cards.unshift(el('p', { className: 'meta' }, 'Two tests below: every match at the minutes he really played, then ',
        el('a', { href: '#acc-full90', textContent: 'full-90 matches only' }), '.'));
    }
    cards.push(el('p', { className: 'meta', textContent: 'Groups with few matches move a lot by luck alone: a group of 100 matches at 20% can come out anywhere from about 12% to 28%.' }));
    $('accBox').replaceChildren(...cards);
  }
  document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
})();
