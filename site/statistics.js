(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  // one row per league match this season, in this order (fpl_xpoints.py export_site)
  const K = ['gw', 'opp', 'mins', 'starts', 'pts', 'g', 'a', 'xg', 'xa', 'xgot', 'pens', 'dc', 'bonus', 'bps', 'cs', 'saves', 'pensave', 'yc', 'rc', 'shots', 'kp', 'sot', 'bcm', 'bcc'];
  const I = Object.fromEntries(K.map((k, i) => [k, i]));
  const NPXG_PEN = 0.79;
  const state = { data: null, pos: '', sort: 'pts', dir: -1, from: 1, to: 1, season: 'cur' };
  const rowsOf = (p) => (state.season === 'last' ? p.lastSeasonGw : p.seasonGw) || [];
  // [key, label, digits, tooltip, group]: digits null = whole number; group colours the column
  const COLS = [['name', 'Player'], ['apps', 'Matches', null, 'League matches he played in (1+ minutes)'], ['pts', 'Total pts', null, 'FPL points'],
    ['ppm', 'Pts/match', 2, 'Points per match played'], ['gwPts', 'GW pts', null, 'Points in the last gameweek of the range'], ['price', 'Price', 1],
    ['mins', 'Minutes', null], ['starts', 'Starts', null],
    ['shots', 'Shots', null, 'Non-penalty shots (FPL Core)', 'att'], ['sot', 'SoT', null, 'Non-penalty shots on target (FPL Core)', 'att'], ['bcm', 'BCM', null, 'Big chances missed, penalties out (FPL Core)', 'att'], ['g', 'G', null, 'Goals', 'att'], ['xg', 'xG', 2, 'Expected goals, penalties included', 'att'], ['npxg', 'npxG', 2, 'Non-penalty xG: xG less 0.79 for each penalty taken', 'att'], ['xgot', 'xGoT', 2, 'Expected goals on target: the shot\'s placement counted too', 'att'], ['gmxg', 'G−xG', 2, 'Goals less xG: above 0 = scoring more than his chances', 'att'],
    ['kp', 'Chances created', null, 'Chances created: passes that led to a shot (FPL Core)', 'att'], ['bcc', 'Big chances created', null, 'Big chances created (FotMob, this season only)', 'att'], ['a', 'A', null, 'Assists as FPL counts them', 'att'], ['xa', 'xA', 2, 'Expected assists', 'att'], ['gi', 'GI', null, 'Goal involvements: goals + FPL assists', 'att'], ['xgi', 'xGI', 2, 'xG + xA', 'att'], ['npxgxa', 'npxG+xA', 2, 'Non-penalty xG + xA', 'att'],
    ['shots90', 'Shots/90', 2, 'Non-penalty shots per 90 minutes', 'att'], ['sot90', 'SoT/90', 2, 'Non-penalty shots on target per 90 minutes', 'att'], ['bcm90', 'BCM/90', 2, 'Big chances missed per 90 minutes', 'att'], ['kp90', 'CC/90', 2, 'Chances created per 90 minutes', 'att'], ['bcc90', 'BCC/90', 2, 'Big chances created per 90 minutes', 'att'], ['xgi90', 'xGI/90', 2, 'xGI per 90 minutes', 'att'], ['npxgxa90', 'npxG+xA/90', 2, 'Non-penalty xG + xA per 90 minutes', 'att'],
    ['cs', 'CS', null, 'Clean sheets', 'def'], ['dc', 'DefCon', null, 'Defensive contributions (FPL)', 'def'], ['dc90', 'DefCon/90', 1, 'DefCon per 90 minutes', 'def'],
    ['saves', 'Saves', null, '', 'def'], ['pensave', 'Pen saves', null, '', 'def'],
    ['bonus', 'Bonus', null, '', 'oth'], ['bps', 'BPS', null, 'Bonus Points System score', 'oth'], ['yc', 'YC', null, 'Yellow cards', 'oth'], ['rc', 'RC', null, 'Red cards', 'oth']];
  const GROUPS = { att: 'Attack', def: 'Defence', oth: 'Bonus and cards' };
  // Show: all columns, or the player plus one group (match stats = the columns without a group)
  const shownCols = () => {
    const v = $('view') ? $('view').value : '';
    return COLS.filter(([k, , , , grp]) => k === 'name' || !v || (v === 'match' ? !grp : grp === v));
  };
  // header row of groups over the columns
  function groupRow(cols) {
    const cells = [];
    cols.forEach(([, , , , grp]) => {
      const last = cells[cells.length - 1];
      if (last && last.grp === (grp || '')) last.n += 1; else cells.push({ grp: grp || '', n: 1 });
    });
    return el('tr', { className: 'grp-row' }, ...cells.map((c) => el('th', { colSpan: c.n, className: c.grp ? `grp-${c.grp}` : '', textContent: GROUPS[c.grp] || '' })));
  }
  const fmt = (v, d) => (v === null || v === undefined || Number.isNaN(v) ? '–' : d === null || d === undefined ? String(Math.round(v)) : v.toFixed(d));

  // totals over the chosen gameweeks
  function stats(p) {
    const rows = rowsOf(p).filter((r) => r[I.gw] >= state.from && r[I.gw] <= state.to);
    const s = Object.fromEntries(['mins', 'starts', 'pts', 'g', 'a', 'xg', 'xa', 'dc', 'bonus', 'bps', 'cs', 'saves', 'pensave', 'yc', 'rc'].map((k) => [k, rows.reduce((t, r) => t + (r[I[k]] || 0), 0)]));
    s.apps = rows.filter((r) => r[I.mins] > 0).length;
    s.ppm = s.apps ? s.pts / s.apps : null;
    s.gwPts = rows.filter((r) => r[I.gw] === state.to).reduce((t, r) => t + r[I.pts], 0);
    s.gi = s.g + s.a;
    s.xgi = s.xg + s.xa;
    s.gmxg = s.g - s.xg;
    const core = rows.some((r) => r[I.xgot] !== null);
    s.xgot = core ? rows.reduce((t, r) => t + (r[I.xgot] || 0), 0) : null;
    const pens = rows.reduce((t, r) => t + (r[I.pens] || 0), 0);
    s.npxg = core ? Math.max(0, s.xg - NPXG_PEN * pens) : null;
    s.npxgxa = core ? s.npxg + s.xa : null;
    const n90 = s.mins / 90;
    s.xgi90 = n90 ? s.xgi / n90 : null;
    s.npxgxa90 = n90 && core ? s.npxgxa / n90 : null;
    s.dc90 = n90 ? s.dc / n90 : null;
    s.shots = core ? rows.reduce((t, r) => t + (r[I.shots] || 0), 0) : null;
    s.kp = core ? rows.reduce((t, r) => t + (r[I.kp] || 0), 0) : null;
    s.shots90 = n90 && core ? s.shots / n90 : null;
    s.kp90 = n90 && core ? s.kp / n90 : null;
    s.sot = core ? rows.reduce((t, r) => t + (r[I.sot] || 0), 0) : null;
    s.sot90 = n90 && core ? s.sot / n90 : null;
    s.bcm = core ? rows.reduce((t, r) => t + (r[I.bcm] || 0), 0) : null;
    s.bcm90 = n90 && core ? s.bcm / n90 : null;
    const fm = rows.some((r) => r[I.bcc] !== null && r[I.bcc] !== undefined);
    s.bcc = fm ? rows.reduce((t, r) => t + (r[I.bcc] || 0), 0) : null;
    s.bcc90 = n90 && fm ? s.bcc / n90 : null;
    s.rows = rows;
    return s;
  }
  const val = (p, k) => (k === 'name' ? p.name.toLowerCase() : k === 'price' ? p.price : p.st[k]);

  function header() {
    const cols = shownCols();
    $('table').tHead.replaceChildren(groupRow(cols), el('tr', {}, ...cols.map(([k, label, , tip, grp]) => {
      const th = el('th', { scope: 'col', title: tip || '', className: grp ? `grp-${grp}` : '' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
        render();
      } }));
      if (state.sort === k) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  // the player's matches, one row per gameweek, in a popup; columns in the same groups as the table
  const GWCOLS = [['gw', 'GW'], ['opp', 'Opp'], ['mins', 'Min'], ['starts', 'Start'], ['pts', 'Pts'],
    ['shots', 'Shots', null, 'att'], ['sot', 'SoT', null, 'att'], ['bcm', 'BCM', null, 'att'], ['g', 'G', null, 'att'], ['xg', 'xG', 2, 'att'], ['npxg', 'npxG', 2, 'att'], ['xgot', 'xGoT', 2, 'att'], ['gmxg', 'G−xG', 2, 'att'],
    ['kp', 'CC', null, 'att'], ['bcc', 'BCC', null, 'att'], ['a', 'A', null, 'att'], ['xa', 'xA', 2, 'att'], ['gi', 'GI', null, 'att'], ['xgi', 'xGI', 2, 'att'], ['npxgxa', 'npxG+xA', 2, 'att'],
    ['cs', 'CS', null, 'def'], ['dc', 'DefCon', null, 'def'], ['saves', 'Saves', null, 'def'], ['pensave', 'Pen saves', null, 'def'],
    ['bonus', 'Bonus', null, 'oth'], ['bps', 'BPS', null, 'oth'], ['yc', 'YC', null, 'oth'], ['rc', 'RC', null, 'oth']];
  function gwValue(r, k) {
    if (k === 'gw') return `GW${r[I.gw]}`;
    if (k === 'opp') return r[I.opp];
    if (k === 'starts') return r[I.starts] ? '✓' : '';
    if (k === 'npxg') return r[I.xgot] === null ? null : Math.max(0, r[I.xg] - NPXG_PEN * (r[I.pens] || 0));
    if (k === 'gmxg') return r[I.g] - r[I.xg];
    if (k === 'gi') return r[I.g] + r[I.a];
    if (k === 'xgi') return r[I.xg] + r[I.xa];
    if (k === 'npxgxa') return r[I.xgot] === null ? null : Math.max(0, r[I.xg] - NPXG_PEN * (r[I.pens] || 0)) + r[I.xa];
    return r[I[k]];
  }
  function openPlayer(p) {
    const cols = GWCOLS.map(([k, l, d, grp]) => [k, l, d, '', grp]);
    const body = p.st.rows.map((r) => el('tr', {}, ...GWCOLS.map(([k, , d, grp]) => {
      const v = gwValue(r, k);
      return el('td', { className: grp ? `grp-${grp}` : '', textContent: typeof v === 'string' ? v : fmt(v, d) });
    })));
    const tot = el('tr', { className: 'total' }, ...GWCOLS.map(([k, , d, grp]) => {
      const map = { gw: 'Total', opp: '', starts: String(p.st.starts), npxg: p.st.npxg, gmxg: p.st.gmxg };
      const v = k in map ? map[k] : p.st[k];
      return el('td', { className: grp ? `grp-${grp}` : '', textContent: typeof v === 'string' ? v : fmt(v, d) });
    }));
    // per 90 minutes: every count over his minutes in the range
    const n90 = p.st.mins / 90;
    const per90 = el('tr', { className: 'total per90' }, ...GWCOLS.map(([k, , , grp]) => {
      const raw = { npxg: p.st.npxg, gmxg: p.st.gmxg }[k] ?? p.st[k];
      const v = k === 'gw' ? 'Per 90' : ['opp', 'mins', 'starts'].includes(k) || !n90 || raw === null || raw === undefined ? '' : (raw / n90).toFixed(2);
      return el('td', { className: grp ? `grp-${grp}` : '', textContent: v });
    }));
    $('pop-title').textContent = `${p.name}, ${p.team} ${p.position} £${p.price.toFixed(1)} · ${state.season === 'last' ? (state.data.lastSeason || 'last season') + ' ' : ''}GW${state.from}–GW${state.to}`;
    $('pop-body').replaceChildren(el('table', { className: 'stats inner' },
      el('thead', {}, groupRow(cols), el('tr', {}, ...GWCOLS.map(([, l, , grp]) => el('th', { textContent: l, className: grp ? `grp-${grp}` : '' })))),
      el('tbody', {}, ...body, tot, per90)));
    $('pop').hidden = false;
  }

  function render() {
    if (!state.data) return;
    header();
    const q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value), mm = parseFloat($('minmins').value) || 0;
    const list = state.data.players.filter((p) => (!state.pos || p.position === state.pos) && (!team || p.team === team)
      && (!(max > 0) || p.price <= max) && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)));
    list.forEach((p) => { p.st = stats(p); });
    const shown = list.filter((p) => p.st.mins >= mm)
      .sort((a, b) => { const x = val(a, state.sort) ?? -1, y = val(b, state.sort) ?? -1; return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    const body = [];
    shown.forEach((p) => {
      const tr = el('tr', { className: 'stat-row' }, ...shownCols().map(([k, , d, , grp]) => {
        if (k === 'name') return el('td', { className: 'player', title: 'Tap for each gameweek' }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position}` }));
        if (k === 'price') return el('td', { textContent: `£${p.price.toFixed(1)}` });
        const td = el('td', { textContent: fmt(p.st[k], d), className: [grp ? `grp-${grp}` : '', k === state.sort ? 'sorted' : ''].join(' ').trim() });
        return td;
      }));
      tr.addEventListener('click', () => openPlayer(p));
      body.push(tr);
    });
    $('table').tBodies[0].replaceChildren(...(body.length ? body : [el('tr', {}, el('td', { colSpan: shownCols().length, className: 'none', textContent: 'No players match these filters.' }))]));
  }

  function fillRange(gws) {
    const opts = (sel) => gws.map((g) => el('option', { value: g, textContent: `GW${g}`, selected: g === sel }));
    $('from').replaceChildren(...opts(state.from));
    $('to').replaceChildren(...opts(state.to));
  }
  // the gameweeks of the chosen season, all of them selected
  function seasonGws() {
    return [...new Set(state.data.players.flatMap((p) => rowsOf(p).map((r) => r[I.gw])))].sort((a, b) => a - b);
  }
  function setSeason() {
    state.season = $('season').value;
    const gws = seasonGws();
    state.from = gws[0] || 1; state.to = gws[gws.length - 1] || 1;
    fillRange(gws);
  }
  $('filters').addEventListener('input', (e) => {
    if (e.target.id === 'season') setSeason();
    if (e.target.id === 'from' || e.target.id === 'to') {
      state.from = Number($('from').value); state.to = Number($('to').value);
      if (state.from > state.to) { [state.from, state.to] = [state.to, state.from]; fillRange([...$('from').options].map((o) => Number(o.value))); }
    }
    render();
  });
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  $('pop-close').addEventListener('click', () => { $('pop').hidden = true; });
  $('pop').addEventListener('click', (e) => { if (e.target === $('pop')) $('pop').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('pop').hidden = true; });
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  fetch('data.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => {
      state.data = d;
      $('season').replaceChildren(el('option', { value: 'cur', textContent: d.season || 'This season' }),
        ...(d.lastSeason ? [el('option', { value: 'last', textContent: d.lastSeason })] : []));
      const gws = seasonGws();
      if (!gws.length) throw new Error('no season data');
      state.from = gws[0]; state.to = gws[gws.length - 1];
      fillRange(gws);
      $('status').textContent = `This season to GW${state.to}, updated ${new Date(d.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}`;
      $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(d.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      render();
    })
    .catch(() => { $('error').textContent = 'Could not load the statistics. Reload the page to try again.'; $('error').hidden = false; $('status').textContent = 'No data yet'; });
})();
