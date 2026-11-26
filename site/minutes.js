(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { data: null, pos: '', sort: null, dir: -1, flagged: false, overrides: XMin.load() };

  const futureGws = () => state.data.gws.slice(0, Number($('horizon').value));
  const pastGws = () => state.data.pastGws || [];
  const flaggedPlayer = (p) => Boolean(p.minNote) || (p.status && p.status !== 'a');
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const pastMins = (p, g) => (p.pastMin && p.pastMin[g]) || null;
  const nextMins = (p, g) => { const m = XMin.minutes(state.overrides, p, g); return m ? sum(m.mins) : -1; };

  function save(p) {
    XMin.tidy(state.overrides, p.id);
    XMin.save(state.overrides);
    updateReset();
    const tr = $('table').tBodies[0].querySelector(`tr[data-pid="${CSS.escape(p.id)}"]`);
    if (tr) tr.replaceWith(row(p));
  }
  function updateReset() {
    const n = Object.keys(state.overrides).length;
    $('reset').hidden = n === 0;
    $('reset').textContent = `Reset your minutes (${n})`;
  }

  // ---- weekends and midweeks, as on the Fixtures page --------------------------------------------------
  // Every weekend (Friday to Monday) and midweek (Tuesday to Thursday) by the date in England, international
  // breaks and empty ones included; a column holds the league gameweek played in it and the club's cup matches.
  const BREAKS = [['2026-09-21', '2026-10-06'], ['2026-11-09', '2026-11-17'], ['2027-03-22', '2027-03-30']];
  const UK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric', day: 'numeric' });
  const ukDay = (d) => { const q = Object.fromEntries(UK.formatToParts(d).map((x) => [x.type, x.value])); return Date.UTC(+q.year, +q.month - 1, +q.day); };
  const slotKey = (t) => { const ms = ukDay(new Date(t)); const wd = new Date(ms).getUTCDay(); return ms - { 5: 0, 6: 1, 0: 2, 1: 3, 2: 0, 3: 1, 4: 2 }[wd] * 864e5; };
  const nextKey = (k) => k + (new Date(k).getUTCDay() === 2 ? 3 : 4) * 864e5;
  const dShort = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  let cal = { gwSlot: {}, days: new Map() };
  function calendar(fx) {
    const per = {};
    const days = new Map();
    (fx ? fx.teams : []).forEach((t) => t.matches.forEach((m) => {
      if (!m.t || !(m.comp === 'PL' || CUP_NAME[m.comp])) return;
      const k = slotKey(m.t);
      if (!days.has(k)) days.set(k, new Set());
      days.get(k).add(ukDay(new Date(m.t)));
      if (m.comp === 'PL' && m.gw) { per[m.gw] = per[m.gw] || {}; per[m.gw][k] = (per[m.gw][k] || 0) + 1; }
    }));
    const gwSlot = {};
    Object.entries(per).forEach(([g, by]) => { gwSlot[g] = Number(Object.entries(by).sort((x, y) => y[1] - x[1])[0][0]); });
    cal = { gwSlot, days };
  }
  // The columns between two keys (inclusive), each with its gameweeks
  function slotsBetween(from, to, gws, past) {
    const out = [];
    if (from == null || to == null) return out;
    const brk = BREAKS.map(([x, y]) => [Date.parse(x + 'T00:00:00Z'), Date.parse(y + 'T00:00:00Z')]);
    for (let k = from; k <= to; k = nextKey(k)) {
      const kind = new Date(k).getUTCDay() === 2 ? 'mid' : 'wkd';
      const last = k + (kind === 'mid' ? 2 : 3) * 864e5;
      const g = gws.filter((x) => cal.gwSlot[x] === k);
      const d = [...(cal.days.get(k) || [])].sort((x, y) => x - y);
      out.push({ key: k, kind, past, gws: g, first: d[0], last: d[d.length - 1], empty: !d.length,
        intl: !g.length && brk.some(([x, y]) => k <= y && last >= x) });
    }
    return out;
  }
  const prevKey = (k) => k - (new Date(k).getUTCDay() === 5 ? 3 : 4) * 864e5;
  // worked out once per gameweek range (not for every row)
  let colsMemo = { key: null, val: null };
  function slotCols() {
    const memoKey = `${$('horizon').value}|${state.data.gws[0]}|${cal.days.size}|${eplOnly}`;
    if (colsMemo.key === memoKey) return colsMemo.val;
    const past = pastGws().map(String), fut = futureGws().map(String);
    const known = (l) => l.filter((g) => cal.gwSlot[g] != null);
    const p = known(past), f = known(fut);
    let val;
    if (!cal.days.size) {
      // without the calendar, one column per gameweek as before
      val = { past: past.map((g) => ({ key: g, gws: [g], past: true, plain: true })), fut: fut.map((g) => ({ key: g, gws: [g], plain: true })) };
    } else {
      const fStart = f.length ? cal.gwSlot[f[0]] : null;
      let pEnd = fStart != null ? fStart : null;
      if (pEnd != null) { let k = p.length ? cal.gwSlot[p[0]] : pEnd; let prev = null; for (; k < pEnd; k = nextKey(k)) prev = k; pEnd = prev; }
      else pEnd = p.length ? cal.gwSlot[p[p.length - 1]] : null;
      // from the midweek just before GW1 (pre-season friendlies and earlier matches left out)
      const first = cal.gwSlot['1'] != null ? cal.gwSlot['1'] : (p.length ? cal.gwSlot[p[0]] : null);
      const start = first != null ? prevKey(first) : null;
      val = {
        past: p.length ? slotsBetween(start, pEnd, p, true) : [],
        fut: f.length ? slotsBetween(fStart, cal.gwSlot[f[f.length - 1]], f, false) : [],
      };
    }
    if (eplOnly) val = { past: val.past.filter((x) => x.gws.length), fut: val.fut.filter((x) => x.gws.length) };
    colsMemo = { key: memoKey, val };
    return val;
  }
  const slotSortKey = (s) => (s.gws.length ? `${s.past ? 'p' : 'f'}${s.gws[0]}` : null);

  function columns() {
    const { past, fut } = slotCols();
    return [
      ['name', 'Player'],
      ...past.map((s) => [slotSortKey(s), s]),
      ['usual', 'Usual EPL min', 'last 5'], ['adjust', 'Adjust min', 'all GWs'],
      ...fut.map((s) => [slotSortKey(s), s]),
      ['note', 'Injury / ban'],
    ];
  }
  // Same order as the xPoints page.
  const xpointsOrder = () => XMin.order(state.data, state.overrides);
  function sortValue(key) {
    if (key === 'order') return xpointsOrder();
    if (key === 'name') return (p) => p.name.toLowerCase();
    if (key === 'usual') return (p) => p.minUsual;
    if (key === 'adjust') return (p) => { const o = state.overrides[p.id]; return o && o.all !== undefined ? o.all : -1; };
    if (key === 'note') return (p) => p.minNote || '';
    if (key[0] === 'p') { const g = key.slice(1); return (p) => { const m = pastMins(p, g); return m ? sum(m) : -1; }; }
    const g = key.slice(1);
    return (p) => nextMins(p, g);
  }

  function slotHead(s) {
    if (s.plain) return [el('span', { className: 'gwn', textContent: `GW${s.gws[0]}` }), el('small', { textContent: s.past ? 'played' : 'xMin' })];
    // the dates are on hover, as the column title
    const kids = [el('span', { className: 'gwn', textContent: s.kind === 'mid' ? 'Midweek' : 'Weekend' })];
    if (s.gws.length) kids.push(el('span', { className: 'gwt', textContent: s.gws.map((g) => 'GW' + g).join(', ') }));
    else if (s.intl) kids.push(el('span', { className: 'gwb', textContent: 'International break' }));
    return kids;
  }
  const slotClass = (s) => (s.plain ? (s.past ? 'past' : '') : `fx-gw ${s.kind}${s.past ? ' done' : ''}${s.intl ? ' intl' : ''}`);
  const slotDates = (s) => (s.plain ? '' : `${s.kind === 'mid' ? 'Midweek' : 'Weekend'} ${s.first != null ? (s.first === s.last ? dShort(s.first) : `${dShort(s.first)} – ${dShort(s.last)}`) : `${dShort(s.key)} – ${dShort(s.key + (s.kind === 'mid' ? 2 : 3) * 864e5)}`}${s.gws.length ? `: GW${s.gws.join(', GW')} ${s.past ? '(minutes played)' : '(xMin, editable)'}` : s.intl ? ': international break' : ''}`);

  function header() {
    const head = el('tr', {}, ...columns().map(([key, label, sub]) => {
      const slot = typeof label === 'object' ? label : null;
      const kids = slot ? slotHead(slot) : [label, ...(sub ? [el('small', { textContent: sub })] : [])];
      const th = el('th', { scope: 'col', className: slot ? slotClass(slot) : (key === 'usual' || key === 'adjust' ? 'keycol' : ''), title: slot ? slotDates(slot) : '' },
        key ? el('button', { type: 'button', onclick: () => {
          if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' || key === 'note' ? 1 : -1; }
          render();
        } }, ...kids) : el('div', { className: 'th-static' }, ...kids));
      if (key && state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    }));
    $('table').tHead.replaceChildren(head);
  }

  function input(value, placeholder, label, data) {
    const i = el('input', { className: 'xmin-input', type: 'text', inputMode: 'numeric', value: value === undefined ? '' : value, placeholder });
    i.setAttribute('aria-label', label);
    Object.assign(i.dataset, data);
    return i;
  }

  function row(p) {
    const meta = el('span', { textContent: `${p.team} ${p.position} £${p.price.toFixed(1)}` });
    const name = el('td', { className: 'player', title: p.news || p.fullName }, el('b', { textContent: p.name }), meta);
    if (p.status && p.status !== 'a') meta.append(' ', el('span', { className: 'flag', textContent: 'Flagged' }));
    const o = state.overrides[p.id] || {};
    const adjust = el('td', { className: 'xmin keycol' }, input(o.all, String(Math.round(p.minUsual)), `Minutes per match for ${p.name} in every gameweek`, { all: '1' }));
    const usual = p.adminMin !== null && p.adminMin !== undefined
      ? el('td', { className: 'usual keycol admin-set', textContent: Math.round(p.minUsual), title: `Set by admin (formula ${Math.round(p.minModel ?? p.minUsual)})` })
      : el('td', { className: 'usual keycol', textContent: Math.round(p.minUsual), title: p.w5Min !== null && Math.round(p.w5Min) !== Math.round(p.minUsual) ? `${Math.round(p.w5Min)} counting his current absence` : '' });
    const { past: pastS, fut: futS } = slotCols();
    const cups = cupBySlot(p);
    // one cell per weekend or midweek: the league gameweek in it, then the club's cup matches
    // as on the Fixtures page: one cell per weekend or midweek, a chip per match
    const slotCell = (s) => {
      const chips = cupChips(cups.get(String(s.key)) || []);
      if (s.plain) return s.past ? pastCell(s.gws[0]) : futCell(s.gws[0]);
      const td = el('td', { className: `fx-cell mslot ${s.kind}${s.intl ? ' intl' : ''}` });
      // every match of the weekend or midweek side by side: league, then cups and internationals in date order
      const items = [];
      if (s.gws.length) {
        if (s.past) items.push(el('div', { className: 'mitem lg' }, ...pastCell(s.gws[0]).childNodes));
        else { const f = futCell(s.gws[0]); td.className += ` ${f.className}`; items.push(el('div', { className: 'mitem' }, ...f.childNodes)); }
      }
      items.push(...chips);
      if (items.length) td.append(el('div', { className: 'mrow' }, ...items));
      return td;
    };
    // played league matches: opponent and minutes; a match left out of the formula in red, the reason on hover or tap
    function leaguePast(g) {
      const m = pastMins(p, g);
      if (!m) return [el('span', { className: 'fx-m lg nil', textContent: '–' })];
      const opp = (p.pastOpp && p.pastOpp[g]) || [];
      const why = (p.pastWhy && p.pastWhy[g]) || [];
      const notes = (p.pastNote && p.pastNote[g]) || [];
      return m.map((x, i) => {
        const w = why[i];
        const tip = w ? `${notes[i] || WHY[w] || 'Left out of the formula'}${notes[i] ? '. Left out of the formula.' : ''}` : `GW${g} v ${opp[i] || ''}: ${Math.round(x)} minutes`;
        const n = el('b', { className: w ? 'out-zero' : '', textContent: String(Math.round(x)) });
        const chip = el('span', { className: `fx-m lg${w ? ' out' : ''}`, title: tip }, opp[i] || '', n);
        if (w) {
          chip.tabIndex = 0;
          chip.setAttribute('role', 'button');
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            const cell = chip.closest('td');
            const old = cell.querySelector('.why-note');
            if (old) { old.remove(); if (old.dataset.i === `${g}-${i}`) return; }
            const note = el('small', { className: 'why-note', textContent: tip });
            note.dataset.i = `${g}-${i}`;
            cell.append(note);
          });
        }
        return chip;
      });
    }
    const past = pastS.map(slotCell);
    function pastCell(g) {
      const m = pastMins(p, g);
      if (!m) return el('td', { className: 'past none', textContent: '–' });
      const opp = (p.pastOpp && p.pastOpp[g]) || [];
      // Every match left out of the formula is shown in red, with the reason on hover.
      const why = (p.pastWhy && p.pastWhy[g]) || [];
      const notes = (p.pastNote && p.pastNote[g]) || [];
      const WHY0 = {
        b: 'Banned: left out of the formula',
        c: 'Sent off in this match: left out of the formula',
        g: 'Came on for the injured goalkeeper: left out of the formula',
        i: 'Injured or unavailable: left out of the formula',
        h: 'Taken off injured in this match: left out of the formula',
        m: 'In an absence set by the admin: left out of the formula',
    x: 'Not used by the Usual minutes',
        x: 'Not used by the Usual minutes',
        r: 'Reduced minutes after injury: under his usual minutes from before it, left out of the formula',
        d: 'Flagged doubtful: the match he got hurt in, or missed since, left out of the formula',
      };
      const nums = el('span', {});
      m.forEach((x, i) => {
        if (i) nums.append('+');
        const w = why[i];
        const tip = w ? `${notes[i] || WHY0[w] || 'Left out of the formula'}${notes[i] ? '. Left out of the formula.' : ''}` : '';
        if (!w) { nums.append(String(Math.round(x))); return; }
        const b = el('b', { className: 'out-zero', textContent: String(Math.round(x)), title: tip, tabIndex: 0, role: 'button', ariaLabel: tip });
        // a tap shows the reason too (phones have no hover)
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const cell = b.closest('td');
          const old = cell.querySelector('.why-note');
          if (old) { old.remove(); if (old.dataset.i === String(i)) return; }
          const n = el('small', { className: 'why-note', textContent: tip });
          n.dataset.i = String(i);
          cell.append(n);
        });
        nums.append(b);
      });
      return el('td', { className: 'past' }, nums, opp.length ? el('small', { textContent: opp.join(', ') }) : '');
    }
    const future = futS.map(slotCell);
    function futCell(g) {
      const m = XMin.minutes(state.overrides, p, g);
      if (!m) return el('td', { className: 'none', textContent: 'Blank' });
      const model = XMin.model(p, g);
      const own = o.gw && o.gw[g] !== undefined;
      const td = el('td', { className: `fut ${m.source !== 'model' ? 'edited' : ''} ${sum(m.mins) === 0 ? 'zero' : ''}` },
        input(own ? o.gw[g] : undefined, XMin.join(m.source === 'all' ? m.mins : model.mins), `Minutes per match for ${p.name} in gameweek ${g}`, { gw: String(g) }),
        el('small', { textContent: p.byGw[g].opp.join(', ') }));
      return td;
    }
    const note = el('td', { className: 'note', textContent: p.minNote || '', title: p.news || '' });
    const tr = el('tr', {}, name, ...past, usual, adjust, ...future, note);
    tr.dataset.pid = p.id;
    return tr;
  }

  const WHY = {
    b: 'Banned: left out of the formula',
    c: 'Sent off in this match: left out of the formula',
    g: 'Came on for the injured goalkeeper: left out of the formula',
    i: 'Injured or unavailable: left out of the formula',
    h: 'Taken off injured in this match: left out of the formula',
    m: 'In an absence set by the admin: left out of the formula',
    x: 'Not used by the Usual minutes',
    r: 'Reduced minutes after injury: under his usual minutes from before it, left out of the formula',
    d: 'Flagged doubtful: the match he got hurt in, or missed since, left out of the formula',
  };
  const CUP_NAME = { UCL: 'Champions League', UEL: 'Europa League', UECL: 'Conference League', EFL: 'EFL Cup', FAC: 'FA Cup', INT: 'International' };
  // Cup and European matches, for reference only: the formula and xMin use league matches.
  // Played: [competition, opponent, minutes, kick-off] per player; coming: [competition, opponent, kick-off] per club.
  function cupBySlot(p) {
    const out = new Map();
    const add = (k, x) => { if (!out.has(k)) out.set(k, []); out.get(k).push(x); };
    Object.values(p.cupPast || {}).forEach((l) => l.forEach(([c, o, mins, t]) => t && add(String(slotKey(t)), { c, o, mins, t, past: true })));
    (p.intlPast || []).forEach(([nat, o, mins, t, comp]) => t && add(String(slotKey(t)), { c: 'INT', o, mins, t, past: true, nat, comp }));
    const nx = (state.data.cupNext && state.data.cupNext[p.team]) || {};
    Object.values(nx).forEach((l) => l.forEach(([c, o, t]) => t && add(String(slotKey(t)), { c, o, t, past: false })));
    out.forEach((l) => l.sort((x, y) => (x.t < y.t ? -1 : 1)));
    return out;
  }
  const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  // Same chips as the Fixtures page: competition, opponent (capitals at home), then minutes played or day and kick-off.
  const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dd = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short' });
  // which cups show (buttons as on the Fixtures page), remembered on this device
  const COMP_BTNS = [['UCL', 'Champions League'], ['UEL', 'Europa League'], ['UECL', 'Conference League'], ['EFL', 'EFL Cup'], ['FAC', 'FA Cup'], ['INT', 'International']];
  let compsOn = new Set(COMP_BTNS.map(([c]) => c));
  // "Show only EPL": league gameweeks only, no cup or international columns or chips
  let eplOnly = false;
  eplOnly = true; // the default: league only, easier to read
  try { const v = localStorage.getItem('minutes-epl-only'); if (v !== null) eplOnly = v === '1'; } catch (e) { /* private mode */ }
  try { const v = JSON.parse(localStorage.getItem('minutes-comps') || 'null'); if (Array.isArray(v)) compsOn = new Set(v); } catch (e) { /* private mode */ }
  function eplButton() {
    const b = $('eplOnly');
    b.textContent = eplOnly ? 'Show all fixtures' : 'Show only EPL';
    b.setAttribute('aria-pressed', String(eplOnly));
    document.querySelector('.fx-comps').style.display = eplOnly ? 'none' : '';
  }
  $('eplOnly').addEventListener('click', () => {
    eplOnly = !eplOnly;
    try { localStorage.setItem('minutes-epl-only', eplOnly ? '1' : '0'); } catch (e) { /* private mode */ }
    eplButton();
    render();
  });
  function compButtons() {
    const box = document.querySelector('.fx-comps');
    box.replaceChildren(...COMP_BTNS.map(([c, n]) => {
      const b = el('button', { type: 'button', className: `toggle fx-tog c-${c}`, textContent: n });
      b.setAttribute('aria-pressed', String(compsOn.has(c)));
      b.addEventListener('click', () => {
        compsOn.has(c) ? compsOn.delete(c) : compsOn.add(c);
        try { localStorage.setItem('minutes-comps', JSON.stringify([...compsOn])); } catch (e) { /* private mode */ }
        b.setAttribute('aria-pressed', String(compsOn.has(c)));
        render();
      });
      return b;
    }));
  }
  // a played cup or international match: his minutes on top, the competition and opponent under it (as league
  // matches show the minutes over the opponent); a coming one: a chip with the competition and opponent
  const cupChips = (l) => l.filter((m) => !eplOnly && compsOn.has(m.c)).map((m) => (m.past
    ? el('div', { className: 'mitem cup', title: `${m.c === 'INT' ? `${m.nat}, ${m.comp}` : CUP_NAME[m.c]} v ${m.o}, ${when(m.t)}: ${m.mins} minutes (shown only, not used by the formula)` },
      el('span', { textContent: String(m.mins) }), el('small', { className: `cuptag c-${m.c}` }, el('b', { textContent: m.c === 'INT' ? natCode(m.nat) : m.c }), ` ${m.o}`))
    : el('div', { className: 'mitem' }, el('span', { className: `fx-m c-${m.c}`, title: `${CUP_NAME[m.c]} v ${m.o} (${m.o === m.o.toUpperCase() ? 'H' : 'A'}), ${when(m.t)} (shown only: xMin is not changed for it)` }, el('b', { textContent: m.c }), m.o))));
  // three letters for a national team: "Italy" ITA, "Côte d'Ivoire" CÔT
  const natCode = (n) => (n || 'INT').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z ]/g, '').trim().slice(0, 3).toUpperCase();

  function render() {
    if (!state.data) return;
    if (!state.sort || (state.sort !== 'order' && !columns().some(([k]) => k === state.sort))) { state.sort = 'order'; state.dir = 1; }
    header();
    $('order').setAttribute('aria-pressed', String(state.sort === 'order'));
    const q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value);
    const value = sortValue(state.sort);
    const list = state.data.players
      .filter((p) => (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!state.flagged || flaggedPlayer(p)) && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)));
    const v = new Map(list.map((p) => [p, value(p)]));
    list.sort((a, b) => { const x = v.get(a), y = v.get(b); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    // rows are drawn a page at a time as you scroll, so the page opens quickly
    pending = list.slice();
    $('table').tBodies[0].replaceChildren(...(list.length ? [] : [el('tr', {}, el('td', { colSpan: columns().length, className: 'none', textContent: 'No players match these filters.' }))]));
    more();
  }
  const PAGE = 40;
  let pending = [];
  function more() {
    const chunk = pending.splice(0, PAGE);
    if (chunk.length) $('table').tBodies[0].append(...chunk.map(row));
    $('more').hidden = !pending.length;
    $('more').textContent = `Show more (${pending.length} left)`;
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && pending.length) more(); }, { rootMargin: '600px' }).observe(document.getElementById('more'));
  }
  document.getElementById('more').addEventListener('click', more);

  function show(data) {
    state.data = data;
    XMin.setPlayers(data.players, data.penPatterns, data.dcSlope);
    $('empty').hidden = true;
    $('wrap').hidden = false;
    const when = new Date(data.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
    $('status').textContent = `From GW${data.gws[0]}, updated ${when}`;
    $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(data.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
    updateReset();
    compButtons();
    eplButton();
    render();
  }

  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('order').addEventListener('click', () => { state.sort = 'order'; state.dir = 1; render(); });
  $('flagged').addEventListener('click', () => {
    state.flagged = !state.flagged;
    $('flagged').setAttribute('aria-pressed', String(state.flagged));
    render();
  });
  $('table').tBodies[0].addEventListener('change', (e) => {
    if (!e.target.matches('.xmin-input')) return;
    const p = state.data.players.find((x) => x.id === e.target.closest('tr').dataset.pid);
    const v = XMin.parse(e.target.value);
    if (v === undefined) { e.target.value = ''; return; }
    const o = state.overrides[p.id] || (state.overrides[p.id] = {});
    if (e.target.dataset.all) {
      // Adjust min applies to every gameweek, so it replaces single-gameweek edits.
      delete o.gw;
      if (v === null) delete o.all; else o.all = v;
    } else {
      const g = e.target.dataset.gw;
      o.gw = o.gw || {};
      if (v === null) delete o.gw[g]; else o.gw[g] = v;
    }
    save(p);
  });
  $('table').tBodies[0].addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.xmin-input')) { e.preventDefault(); e.target.blur(); }
  });
  $('reset').addEventListener('click', () => { state.overrides = {}; XMin.save(state.overrides); updateReset(); render(); });
  window.addEventListener('storage', (e) => { if (e.key === null || e.key === 'xmin-overrides') { state.overrides = XMin.load(); updateReset(); render(); } });

  // the calendar (fixtures.json) only adds the weekend and midweek columns; without it, one column per gameweek
  const fx = window.siteFetch('fixtures.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  window.siteFetch('data.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => fx.then((f) => { calendar(f); show(d); }))
    .catch(() => {
      $('error').textContent = 'Could not load the minutes. Check the latest run in the GitHub Actions tab, then reload this page.';
      $('error').hidden = false;
      $('status').textContent = 'No data yet';
    });
})();
