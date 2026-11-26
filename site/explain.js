// Worked example on the How it works page: every player's xPoints for the next gameweek, part by part.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k !== null && k !== undefined && k !== '')); return n; };
  // part key, column, how its minutes factor works
  const PARTS = [
    ['app', 'Appear\u00adance', 'app'], ['goal', 'Goals', 'm'], ['assist', 'Assists', 'm'], ['cs', 'Clean sheet', 'p60'], ['conceded', 'Goals conceded', 'p60'],
    ['saves', 'Saves', 'm'], ['pensave', 'Pen saves', 'm'], ['defcon', 'DefCon', 'dc'], ['bonus', 'Bonus', 'm'],
    ['penmiss', 'Pen misses', 'm'], ['own', 'Own goals', 'm'], ['cards', 'Cards', 'm'],
  ];
  const f2 = (x) => (Math.abs(x) < 0.005 ? '0.00' : x.toFixed(2));
  const pc = (x) => `${Math.round(x * 100)}%`;
  const state = { pos: '', sort: 'xpts', dir: -1 };
  let data = null, gw = null;

  const m60Of = (d) => (d.m60 && d.m60.length ? d.m60.reduce((a, b) => a + b, 0) / d.m60.length : 90);
  function how(d, key, kind) {
    const full = (d.full || {})[key] || 0, n = d.opp.length, on = Math.round(m60Of(d));
    if (kind === 'app') return `Appearance 1+ ${pc(d.pApp1)} + Appearance 60+ ${pc(d.pApp60)}`;
    if (kind === 'p60') return `${f2(full)} over 90 × Appearance 60+ ${pc(d.pApp60)}, counting only the goals in his ${on} minutes on`;
    if (kind === 'dc') { const mu = d.dm && d.dm.length ? d.dm[0] : null;
      return `${f2(full)} over 90 (DefCon chance ${pc(full / 2)}${mu ? ` from ${mu.toFixed(1)} actions over 90` : ''}) × Appearance 60+ ${pc(d.pApp60)}, in his ${on} minutes${mu ? ` about ${(mu * on / 90).toFixed(1)} actions` : ''}, plus almost nothing from short appearances`; }
    return `${f2(full)} over 90 × ${Math.round(d.xmin / n)}/90 minutes`;
  }
  const value = (p, d, key) => (key === 'name' ? p.name.toLowerCase() : key === 'opp' ? d.opp.join() : key === 'xpts' ? d.xpts
    : key === 'xmin' ? d.xmin : key === 'p1' ? d.pApp1 : key === 'p60' ? d.pApp60 : key === 'm60' ? m60Of(d) : (d.parts[key] || 0));
  const COLS = [['name', 'Player'], ['opp', 'Opp'], ['xmin', 'xMin'], ['p1', 'Appear\u00adance 1+'], ['p60', 'Appear\u00adance 60+'], ['m60', 'Min when 60+'],
    ...PARTS.map(([k, l]) => [k, l]), ['xpts', 'xPoints']];

  function header() {
    $('exTable').tHead.replaceChildren(el('tr', {}, ...COLS.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', innerHTML: label, onclick: () => {
        if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' || key === 'opp' ? 1 : -1; }
        render();
      } }));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  function render() {
    if (!data) return;
    header();
    const q = $('player').value.trim().toLowerCase(), hide = $('hideOut').checked;
    const list = data.players.filter((p) => p.byGw[gw] && (!state.pos || p.position === state.pos)
      && (!hide || p.byGw[gw].pApp1 >= 0.005)
      && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q) || p.team.toLowerCase() === q))
      .sort((a, b) => { const x = value(a, a.byGw[gw], state.sort), y = value(b, b.byGw[gw], state.sort); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    const rows = list.map((p) => {
      const d = p.byGw[gw];
      const cells = PARTS.map(([k, , kind]) => {
        const v = d.parts[k] || 0;
        if (Math.abs(v) < 0.005 && !(d.full || {})[k] && k !== 'app') return el('td', { className: 'none', textContent: '–' });
        return el('td', { title: how(d, k, kind), className: 'ex-cell', textContent: f2(v) });
      });
      return el('tr', {}, el('td', { className: 'player' }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position}` })),
        el('td', { className: 'opp', textContent: d.opp.join(', ') }), el('td', { textContent: Math.round(d.xmin) }),
        el('td', { textContent: pc(d.pApp1) }), el('td', { textContent: pc(d.pApp60) }), el('td', { textContent: d.pApp60 > 0 ? Math.round(m60Of(d)) : '–' }),
        ...cells, el('td', { className: 'ex-total', textContent: f2(d.xpts) }));
    });
    $('exTable').tBodies[0].replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colSpan: COLS.length, className: 'none', textContent: 'No players match.' }))]));
  }

  $('filters').addEventListener('input', render);
  document.querySelectorAll('#exPos button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('#exPos button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  fetch('data.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((json) => {
      data = json;
      gw = String(json.gws.filter((g) => !(json.pastGws || []).includes(g))[0]);
      $('exIntro').textContent = `Every player's xPoints for GW${gw}, part by part. Tap a figure to see how it is worked out: the figure over 90 minutes and the minutes factor it is multiplied by. Tap a column to sort. Opponents in capitals are home matches.`;
      render();
    })
    .catch((e) => { $('error').hidden = false; $('error').textContent = `Could not load the data (${e.message}).`; });
})();
