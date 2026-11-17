// Fixtures: every club's matches in every competition, laid out by FPL gameweek (deadline to next deadline).
(function () {
  'use strict';
  const COMPS = [['PL', 'Premier League'], ['UCL', 'Champions League'], ['UEL', 'Europa League'], ['UECL', 'Conference League'],
    ['EFL', 'EFL Cup'], ['FAC', 'FA Cup']];
  // International breaks of the season, from the Premier League (first and last day, dates in England).
  const BREAKS = [['2026-09-21', '2026-10-06'], ['2026-11-09', '2026-11-17'], ['2027-03-22', '2027-03-30']];
  const NAME = Object.fromEntries(COMPS);
  const OFF_BY_DEFAULT = new Set();
  const $ = (s) => document.querySelector(s);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k != null)); return n; };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  const state = { view: 'grid', team: '', range: '12', on: new Set(), tz: 'UTC' };
  let data, windows, teams;

  // Times are shown in the chosen zone (UTC unless changed); matches are grouped into weekend (Fri-Mon) and midweek
  // (Tue-Thu) slots by the date in England, so a slot means the same round of matches wherever you are.
  const ZONES = [['UTC', 'GMT+0 (UTC)'], ['Europe/London', 'UK time'], ['Europe/Paris', 'Central Europe'], ['Asia/Bangkok', 'GMT+7 (Vietnam, Thailand)'],
    ['Asia/Singapore', 'GMT+8 (Singapore, Malaysia)'], ['Asia/Tokyo', 'GMT+9 (Japan, Korea)'], ['Australia/Sydney', 'Sydney'],
    ['America/New_York', 'US Eastern'], ['America/Los_Angeles', 'US Pacific'], ['local', 'This device']];
  const tz = () => (state.tz === 'local' ? undefined : state.tz);
  const day = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: tz() });
  const hm = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz() });
  const when = (d) => d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz() });
  const UK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric' });
  const ukDay = (d) => { const p = Object.fromEntries(UK.formatToParts(d).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day); };
  const dShort = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  function slotOf(d) {
    const ms = ukDay(d);
    const wd = new Date(ms).getUTCDay(); // 0 Sun .. 6 Sat
    const back = { 5: 0, 6: 1, 0: 2, 1: 3, 2: 0, 3: 1, 4: 2 }[wd];
    const start = ms - back * 864e5;
    return { key: start, kind: wd >= 2 && wd <= 4 ? 'mid' : 'wkd', start };
  }

  function prepare(raw) {
    const gws = raw.gws.slice().sort((a, b) => a.gw - b.gw);
    windows = gws.map((g, i) => {
      const from = new Date(g.deadline);
      const to = gws[i + 1] ? new Date(gws[i + 1].deadline) : new Date(from.getTime() + 8 * 864e5);
      return { gw: g.gw, from, to, current: g.current, next: g.next };
    });
    const windowOf = (m) => {
      if (m.comp === 'PL') return m.gw || null;
      if (!m.date) return null;
      const w = windows.find((x) => m.date >= x.from && m.date < x.to);
      return w ? w.gw : null;
    };
    teams = raw.teams.map((t) => {
      const ms = t.matches.filter((m) => NAME[m.comp]).map((m) => Object.assign({}, m, { date: m.t ? new Date(m.t) : null }));
      ms.forEach((m) => { m.col = windowOf(m); m.slot = m.date ? slotOf(m.date) : null; });
      // Days since the club's previous competitive match (friendlies left out).
      let last = null;
      ms.filter((m) => m.comp !== 'FR' && m.date).sort((a, b) => a.date - b.date).forEach((m) => {
        m.rest = last ? (m.date - last) / 864e5 : null;
        last = m.date;
      });
      // Two league matches in one gameweek
      const per = {};
      ms.filter((m) => m.comp === 'PL' && m.gw).forEach((m) => { per[m.gw] = (per[m.gw] || 0) + 1; });
      ms.forEach((m) => { m.dgw = m.comp === 'PL' && per[m.gw] > 1; });
      return { name: t.name, short: t.short, matches: ms, plGws: per };
    });
  }

  // Date range of the chosen number of gameweeks, from the one being played now (or the next one).
  function shownRange() {
    if (state.range === 'all') return [null, null];
    const cur = windows.find((w) => w.current) || null;
    const nxt = windows.find((w) => w.next) || windows[0];
    const start = cur && cur.to > new Date() ? cur : nxt;
    const i = windows.indexOf(start);
    const end = windows[Math.min(windows.length - 1, i + Number(state.range) - (start === cur ? 0 : 1))];
    return [new Date(ukDay(new Date())), end.to];
  }

  function slots() {
    const [from, to] = shownRange();
    const map = new Map();
    teams.forEach((t) => t.matches.forEach((m) => {
      if (!m.slot || !state.on.has(m.comp)) return;
      if (from != null && (m.date < from || m.date >= to)) return;
      const s = map.get(m.slot.key) || Object.assign({ gws: {}, days: new Set() }, m.slot);
      if (m.comp === 'PL' && m.gw) s.gws[m.gw] = (s.gws[m.gw] || 0) + 1;
      s.days.add(ukDay(m.date));
      map.set(m.slot.key, s);
    }));
    // Every weekend and midweek in the range, with or without matches, so a gap shows as the rounds it takes.
    const keys = [...map.keys()].sort((x, y) => x - y);
    if (!keys.length) return [];
    let k = from != null ? slotOf(new Date(Math.max(+from, 0))).key : keys[0];
    const end = from != null ? slotOf(new Date(+to - 1)).key : keys[keys.length - 1];
    const brk = BREAKS.map(([x, y]) => [Date.parse(x + 'T00:00:00Z'), Date.parse(y + 'T00:00:00Z')]);
    const out = [];
    for (; k <= end; k += (new Date(k).getUTCDay() === 2 ? 3 : 4) * 864e5) {
      const kind = new Date(k).getUTCDay() === 2 ? 'mid' : 'wkd';
      const lastDay = k + (kind === 'mid' ? 2 : 3) * 864e5;
      const s = map.get(k);
      const intl = brk.some(([x, y]) => k <= y && lastDay >= x) && !(s && Object.keys(s.gws).length);
      if (s) {
        s.main = Number(Object.entries(s.gws).sort((x, y) => y[1] - x[1])[0]?.[0]) || null;
        const d = [...s.days].sort((x, y) => x - y);
        Object.assign(s, { first: d[0], last: d[d.length - 1], intl });
        out.push(s);
      } else {
        out.push({ key: k, kind, start: k, first: k, last: lastDay, gws: {}, days: new Set(), empty: true, intl });
      }
    }
    return out;
  }

  const label = (m) => (m.home ? m.oppShort.toUpperCase() : m.oppShort.toLowerCase());

  function chip(m) {
    const past = m.score != null;
    const title = `${NAME[m.comp] || m.comp}${m.gw ? ' GW' + m.gw : ''} · ${m.opp} (${m.home ? 'H' : 'A'}) · ${m.date ? when(m.date) : 'date to be set'}${past ? ' · ' + m.score : ''}${m.stage ? ' · ' + m.stage : ''}${m.rest != null && m.comp !== 'FR' ? ` · ${Math.round(m.rest)} days after the last match` : ''}`;
    return el('span', { className: `fx-m c-${m.comp}${past ? ' past' : ''}${m.dgw ? ' dgw' : ''}${m.rest != null && m.rest < 3.5 && m.comp !== 'FR' ? ' short' : ''}`, title },
      m.comp === 'PL' ? null : el('b', { textContent: m.comp }), label(m),
      el('i', { textContent: past ? m.score.replace(/\s/g, '') : (m.date ? `${day(m.date)} ${hm(m.date)}` : 'TBC') }));
  }

  function renderGrid() {
    const ss = slots();
    const head = el('tr', {}, el('th', { scope: 'col', className: 'fx-team', textContent: 'Team' }),
      ...ss.map((s) => el('th', { scope: 'col', className: `fx-gw ${s.kind}${s.intl ? ' intl' : s.empty ? ' none' : ''}` },
        el('span', { className: 'gwn', textContent: s.kind === 'mid' ? 'Midweek' : 'Weekend' }),
        el('span', { className: 'gwd', textContent: s.first === s.last ? dShort(s.first) : `${dShort(s.first)} – ${dShort(s.last)}` }),
        Object.keys(s.gws).length ? el('span', { className: 'gwt', textContent: Object.keys(s.gws).map((g) => 'GW' + g).join(' + ') })
          : s.intl ? el('span', { className: 'gwb', textContent: 'International break' }) : s.empty ? el('span', { className: 'gwb', textContent: 'No matches' }) : s.kind === 'wkd' ? el('span', { className: 'gwb', textContent: 'No league matches' }) : null)));
    $('.fx-grid thead').replaceChildren(head);
    const rows = teams.map((t) => {
      const cells = ss.map((s) => {
        if (s.empty) return el('td', { className: `fx-cell ${s.kind}${s.intl ? ' intl' : ' none'}` });
        const ms = t.matches.filter((m) => m.slot && m.slot.key === s.key && state.on.has(m.comp)).sort((a, b) => a.date - b.date);
        const blank = state.on.has('PL') && s.main && !t.plGws[s.main] && !t.matches.some((m) => m.comp === 'PL' && m.gw === s.main && !m.date);
        const kids = ms.map(chip);
        if (blank) kids.push(el('span', { className: 'fx-none', textContent: `Blank GW${s.main}` }));
        return el('td', { className: `fx-cell ${s.kind}${blank ? ' blank' : ''}${s.intl ? ' intl' : ''}` }, ...kids);
      });
      const btn = el('button', { type: 'button', className: 'linkish', textContent: t.name });
      btn.addEventListener('click', () => { state.team = t.short; state.view = 'team'; sync(); });
      return el('tr', {}, el('td', { className: 'player fx-team' }, btn), ...cells);
    });
    $('.fx-grid tbody').replaceChildren(...rows);
  }

  function renderList() {
    const t = teams.find((x) => x.short === state.team) || teams[0];
    const ms = t.matches.filter((m) => state.on.has(m.comp));
    const now = new Date();
    let marked = false;
    const rows = ms.map((m) => {
      const tr = el('tr', { className: m.score != null ? 'past' : '' },
        el('td', { className: 'fx-date', textContent: m.date ? when(m.date) : 'To be set' }),
        el('td', { textContent: m.col ? `GW${m.col}` : '' }),
        el('td', { textContent: m.slot ? (m.slot.kind === 'mid' ? 'Midweek' : 'Weekend') : '' }),
        el('td', {}, el('span', { className: `fx-m c-${m.comp}`, textContent: NAME[m.comp] || m.comp }), m.stage ? el('span', { className: 'fx-stage', textContent: ' ' + m.stage }) : null),
        el('td', { className: 'fx-opp', textContent: m.opp }),
        el('td', { textContent: m.home ? 'Home' : 'Away' }),
        el('td', { textContent: m.score || '' }),
        el('td', { className: m.rest != null && m.rest < 3.5 ? 'fx-short' : '', textContent: m.rest != null && m.comp !== 'FR' ? `${Math.round(m.rest)}d` : '' }));
      if (!marked && m.date && m.date > now) { tr.id = 'fx-next'; marked = true; }
      return tr;
    });
    $('.fx-list tbody').replaceChildren(...rows);
    const n = document.getElementById('fx-next');
    if (n) $('#list').scrollTop = Math.max(0, n.offsetTop - 120);
  }

  function sync() {
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    document.querySelectorAll('[data-comp]').forEach((b) => b.setAttribute('aria-pressed', String(state.on.has(b.dataset.comp))));
    $('#team').value = state.team;
    $('#team').closest('label').hidden = state.view !== 'team';
    $('#range').closest('label').hidden = state.view !== 'grid';
    $('#grid').hidden = state.view !== 'grid';
    $('#list').hidden = state.view !== 'team';
    store.set('fx-view', JSON.stringify({ view: state.view, team: state.team, range: state.range, on: [...state.on], tz: state.tz }));
    $('#tz').value = state.tz;
    if (state.view === 'grid') renderGrid(); else renderList();
  }

  function setup() {
    const present = new Set(teams.flatMap((t) => t.matches.map((m) => m.comp)));
    const comps = COMPS.filter(([c]) => present.has(c) || c === 'FAC');
    let saved = null;
    try { saved = JSON.parse(store.get('fx-view') || 'null'); } catch (e) { saved = null; }
    state.on = new Set(saved && Array.isArray(saved.on) ? saved.on : comps.map(([c]) => c).filter((c) => !OFF_BY_DEFAULT.has(c)));
    if (saved) Object.assign(state, { view: saved.view === 'team' ? 'team' : 'grid', team: saved.team || '', range: ['8', '12', 'all'].includes(saved.range) ? saved.range : '12', tz: ZONES.some(([z]) => z === saved.tz) ? saved.tz : 'UTC' });
    $('#tz').replaceChildren(...ZONES.map(([z, n]) => el('option', { value: z, textContent: n })));
    $('#tz').addEventListener('change', (e) => { state.tz = e.target.value; sync(); });
    $('.fx-comps').replaceChildren(...comps.map(([c, n]) => {
      const b = el('button', { type: 'button', className: `toggle fx-tog c-${c}`, textContent: c === 'PL' ? 'League' : n });
      b.dataset.comp = c;
      b.addEventListener('click', () => { state.on.has(c) ? state.on.delete(c) : state.on.add(c); sync(); });
      return b;
    }));
    $('#team').replaceChildren(...teams.map((t) => el('option', { value: t.short, textContent: t.name })));
    if (!teams.some((t) => t.short === state.team)) state.team = teams[0].short;
    $('#range').value = state.range;
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; sync(); }));
    $('#team').addEventListener('change', (e) => { state.team = e.target.value; sync(); });
    $('#range').addEventListener('change', (e) => { state.range = e.target.value; sync(); });
  }

  fetch('fixtures.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`fixtures.json: HTTP ${r.status}`); return r.json(); }).then((raw) => {
    data = raw;
    prepare(raw);
    setup();
    sync();
    const n = teams.reduce((s, t) => s + t.matches.length, 0);
    $('#status').textContent = `${n} matches · updated ${new Date(raw.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    if (raw.note) { $('#error').textContent = raw.note; $('#error').hidden = false; }
  }).catch((e) => {
    $('#status').textContent = 'Fixtures not loaded';
    $('#error').textContent = String(e.message || e);
    $('#error').hidden = false;
  });
})();
