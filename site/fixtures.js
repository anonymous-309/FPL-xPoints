// Fixtures: every club's matches in every competition, laid out by FPL gameweek (deadline to next deadline).
(function () {
  'use strict';
  const COMPS = [['PL', 'Premier League'], ['UCL', 'Champions League'], ['UEL', 'Europa League'], ['UECL', 'Conference League'],
    ['EFL', 'EFL Cup'], ['FAC', 'FA Cup'], ['CS', 'Community Shield'], ['FR', 'Friendlies']];
  const NAME = Object.fromEntries(COMPS);
  const OFF_BY_DEFAULT = new Set(['CS', 'FR']);
  const $ = (s) => document.querySelector(s);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k != null)); return n; };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  const state = { view: 'grid', team: '', range: '12', on: new Set() };
  let data, windows, teams;

  const day = (d) => d.toLocaleDateString(undefined, { weekday: 'short' });
  const dateShort = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const when = (d) => d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function prepare(raw) {
    const gws = raw.gws.slice().sort((a, b) => a.gw - b.gw);
    windows = gws.map((g, i) => {
      const from = new Date(g.deadline);
      const to = gws[i + 1] ? new Date(gws[i + 1].deadline) : new Date(from.getTime() + 8 * 864e5);
      return { gw: g.gw, from, to, current: g.current, next: g.next, days: (to - from) / 864e5 };
    });
    const windowOf = (m) => {
      if (m.comp === 'PL') return m.gw || null;
      if (!m.date) return null;
      const w = windows.find((x) => m.date >= x.from && m.date < x.to);
      return w ? w.gw : null;
    };
    teams = raw.teams.map((t) => {
      const ms = t.matches.map((m) => Object.assign({}, m, { date: m.t ? new Date(m.t) : null }));
      ms.forEach((m) => { m.col = windowOf(m); });
      // Days since the club's previous competitive match (friendlies left out).
      let last = null;
      ms.filter((m) => m.comp !== 'FR' && m.date).sort((a, b) => a.date - b.date).forEach((m) => {
        m.rest = last ? (m.date - last) / 864e5 : null;
        last = m.date;
      });
      return { name: t.name, short: t.short, matches: ms };
    });
  }

  function shownWindows() {
    const cur = windows.find((w) => w.current) || null;
    const nxt = windows.find((w) => w.next) || windows[0];
    if (state.range === 'all') return windows;
    const start = cur && cur.to > new Date() ? cur : nxt;
    const i = windows.indexOf(start);
    return windows.slice(i, i + Number(state.range) + (start === cur ? 1 : 0));
  }

  const label = (m) => (m.home ? m.oppShort.toUpperCase() : m.oppShort.toLowerCase());

  function chip(m) {
    const past = m.score != null;
    const title = `${NAME[m.comp] || m.comp} · ${m.opp} (${m.home ? 'H' : 'A'}) · ${m.date ? when(m.date) : 'date to be set'}${past ? ' · ' + m.score : ''}${m.stage ? ' · ' + m.stage : ''}`;
    return el('span', { className: `fx-m c-${m.comp}${past ? ' past' : ''}`, title },
      m.comp === 'PL' ? null : el('b', { textContent: m.comp }), label(m), el('i', { textContent: past ? m.score.replace(/\s/g, '') : (m.date ? day(m.date) : 'TBC') }));
  }

  function renderGrid() {
    const ws = shownWindows();
    const head = el('tr', {}, el('th', { scope: 'col', className: 'fx-team', textContent: 'Team' }),
      ...ws.map((w) => el('th', { scope: 'col', className: 'fx-gw' + (w.current ? ' now' : '') },
        el('span', { className: 'gwn', textContent: `GW${w.gw}` }),
        el('span', { className: 'gwd', textContent: `${dateShort(w.from)} – ${dateShort(new Date(w.to - 1))}` }),
        w.days >= 12 ? el('span', { className: 'gwb', textContent: 'intl break' }) : null)));
    $('.fx-grid thead').replaceChildren(head);
    const rows = teams.map((t) => {
      const cells = ws.map((w) => {
        const ms = t.matches.filter((m) => m.col === w.gw && state.on.has(m.comp)).sort((a, b) => (a.date || 0) - (b.date || 0));
        const pl = t.matches.filter((m) => m.col === w.gw && m.comp === 'PL').length;
        const n = ms.filter((m) => m.comp !== 'FR').length;
        const cls = ['fx-cell', n >= 3 ? 'n3' : n === 2 ? 'n2' : '', state.on.has('PL') && pl === 0 ? 'blank' : '', pl >= 2 ? 'double' : ''].filter(Boolean).join(' ');
        return el('td', { className: cls }, ...(ms.length ? ms.map(chip) : [el('span', { className: 'fx-none', textContent: pl === 0 && state.on.has('PL') ? 'Blank' : '' })]));
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
    store.set('fx-view', JSON.stringify({ view: state.view, team: state.team, range: state.range, on: [...state.on] }));
    if (state.view === 'grid') renderGrid(); else renderList();
  }

  function setup() {
    const present = new Set(teams.flatMap((t) => t.matches.map((m) => m.comp)));
    const comps = COMPS.filter(([c]) => present.has(c) || c === 'FAC');
    let saved = null;
    try { saved = JSON.parse(store.get('fx-view') || 'null'); } catch (e) { saved = null; }
    state.on = new Set(saved && Array.isArray(saved.on) ? saved.on : comps.map(([c]) => c).filter((c) => !OFF_BY_DEFAULT.has(c)));
    if (saved) Object.assign(state, { view: saved.view === 'team' ? 'team' : 'grid', team: saved.team || '', range: ['8', '12', 'all'].includes(saved.range) ? saved.range : '12' });
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
