// Team news: FPL's flags and news for every club, with a likely XI from our expected minutes.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k != null)); return n; };
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const state = { team: '', q: '', sort: 'name' };
  let data;

  const gmt = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  function ago(iso) {
    if (!iso) return '';
    const h = (Date.now() - new Date(iso)) / 36e5;
    if (h < 1) return 'just now';
    if (h < 24) return `${Math.floor(h)}h ago`;
    const d = Math.floor(h / 24);
    return d < 14 ? `${d}d ago` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  const kind = (n) => (n.status === 's' ? 'banned' : n.status === 'd' ? 'doubt' : n.status === 'i' || n.status === 'n' ? 'out' : 'other');
  const chanceClass = (c) => (c == null ? '' : c >= 75 ? 'c75' : c >= 50 ? 'c50' : c > 0 ? 'c25' : 'c0');
  const match = (n) => !state.q || n.name.toLowerCase().includes(state.q);

  function newsRow(n) {
    return el('li', { className: `tn-item ${kind(n)}` },
      el('div', { className: 'tn-who' },
        el('b', { textContent: n.name }), el('span', { className: 'tn-pos', textContent: n.pos }),
        n.status === 'd' && n.chance != null ? el('span', { className: `tn-chance ${chanceClass(n.chance)}`, textContent: `${n.chance}%` }) : null,
        el('span', { className: 'tn-when', textContent: ago(n.added), title: n.added ? gmt(n.added) + ' GMT' : '' })),
      n.news ? el('p', { textContent: n.news }) : null);
  }

  function block(title, items, cls) {
    if (!items.length) return null;
    return el('div', { className: `tn-block ${cls}` }, el('h3', { textContent: `${title} (${items.length})` }), el('ul', {}, ...items.map(newsRow)));
  }

  function card(t) {
    const news = t.news.filter(match);
    const nx = t.next.length ? t.next.map((m) => `${m.opp} (${m.home ? "H" : "A"})${m.t ? ' ' + gmt(m.t) : ''}`).join(' + ') : 'No league match this gameweek';
    const chance = new Map(t.news.filter((n) => n.status === 'd').map((n) => [n.name, n.chance]));
    const changes = t.xi.filter((x) => x.new);
    const gone = (t.lastXi && t.lastXi.out) || [];
    const vs = t.lastXi ? (t.lastXi.home && t.lastXi.away ? `${t.lastXi.home} ${t.lastXi.away ? 'v ' + t.lastXi.away : ''}` : '') : '';
    const pitch = t.xi.length ? el('div', { className: 'tn-xi' },
      el('h3', { textContent: `Likely XI${t.formation ? ' · ' + t.formation : ''}` }),
      el('div', { className: 'tn-pitch', role: 'img', ariaLabel: `Likely line-up: ${t.xi.map((x) => x.name).join(', ')}` },
        el('span', { className: 'tn-box top' }), el('span', { className: 'tn-box bottom' }), el('span', { className: 'tn-half' }), el('span', { className: 'tn-circle' }),
        ...t.xi.map((x) => {
          const c = chance.get(x.name);
          const node = el('span', { className: `tn-p${x.new ? ' new' : ''}${c != null ? ' doubt' : ''}`, title: `${x.name}${x.role ? ' · ' + x.role : ''} · ${x.xmin} expected minutes${x.new ? ' · not in the last league XI' : ''}${c != null ? ' · ' + c + '% chance of playing' : ''}` },
            el('i', { className: `tn-shirt ${x.pos}` }, c != null ? el('em', { textContent: `${c}%` }) : null),
            el('b', { textContent: x.name }), el('small', { textContent: `${x.xmin}'` }));
          node.style.left = `${((1 - x.x) * 100).toFixed(1)}%`; // FotMob draws the team attacking upwards; with the keeper on top, mirror so left back is on the left
          node.style.top = `${(x.y * 100).toFixed(1)}%`;
          return node;
        })),
      el('p', { className: 'tn-changes' }, changes.length || gone.length ? `Changes from the last league XI${vs ? ' (' + vs + ')' : ''}: in ${changes.map((x) => x.name).join(', ') || '–'}; out ${gone.join(', ') || '–'}` : t.formation ? `Same XI as the last league match${vs ? ' (' + vs + ')' : ''}` : 'No recent line-up: the players with the most expected minutes')) : null;
    return el('article', { className: 'sp-card tn-card' },
      el('div', { className: 'sp-head' },
        el('h2', { textContent: t.name }),
        el('p', {}, `Next: ${nx}`),
        t.lastNews ? el('p', { className: 'tn-upd', textContent: `News last changed ${ago(t.lastNews)}` }) : null),
      pitch,
      block('Out', news.filter((n) => kind(n) === 'out'), 'out'),
      block('Doubts', news.filter((n) => kind(n) === 'doubt'), 'doubt'),
      block('Banned', news.filter((n) => kind(n) === 'banned'), 'banned'),
      block('Other news', news.filter((n) => kind(n) === 'other'), 'other'),
      !news.length && !state.q ? el('p', { className: 'tn-none', textContent: 'No flagged players.' }) : null,
      t.watch.length && data.yellowLimit ? el('p', { className: 'tn-watch' },
        el('b', { textContent: `One booking from a ban (${data.yellowLimit.cards} by GW${data.yellowLimit.gw}): ` }), t.watch.map((w) => w.name).join(', ')) : null);
  }

  function render() {
    document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort)));
    let teams = data.teams.filter((t) => !state.team || t.short === state.team);
    if (state.q) teams = teams.filter((t) => t.news.some(match));
    if (state.sort === 'latest') teams = teams.slice().sort((a, b) => (b.lastNews || '').localeCompare(a.lastNews || ''));
    $('#cards').replaceChildren(...teams.map(card));
    if (!teams.length) $('#cards').append(el('p', { className: 'tn-none', textContent: 'No player matches the search.' }));
    const recent = data.teams.flatMap((t) => t.news.map((n) => Object.assign({ team: t.short }, n)))
      .filter((n) => n.added && (!state.team || n.team === state.team) && match(n))
      .sort((a, b) => b.added.localeCompare(a.added)).slice(0, 12);
    $('#latest').hidden = !recent.length;
    $('#latest ol').replaceChildren(...recent.map((n) => el('li', { className: kind(n) },
      el('span', { className: 'tn-when', textContent: ago(n.added), title: gmt(n.added) + ' GMT' }),
      el('b', { textContent: n.name }), el('span', { className: 'tn-pos', textContent: n.team }),
      n.status === 'd' && n.chance != null ? el('span', { className: `tn-chance ${chanceClass(n.chance)}`, textContent: `${n.chance}%` }) : el('span', { className: `tn-tag ${kind(n)}`, textContent: { out: 'Out', banned: 'Banned', other: 'News', doubt: 'Doubt' }[kind(n)] }),
      el('span', { className: 'tn-text', textContent: n.news }))));
    store.set('tn-view', JSON.stringify({ team: state.team, sort: state.sort }));
  }

  fetch('team_news.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`team_news.json: HTTP ${r.status}`); return r.json(); }).then((raw) => {
    data = raw;
    try { Object.assign(state, JSON.parse(store.get('tn-view') || '{}')); } catch (e) { /* ignore */ }
    if (!data.teams.some((t) => t.short === state.team)) state.team = '';
    $('#team').append(...data.teams.map((t) => el('option', { value: t.short, textContent: t.name })));
    $('#team').value = state.team;
    $('#team').addEventListener('change', (e) => { state.team = e.target.value; render(); });
    $('#search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
    document.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => { state.sort = b.dataset.sort; render(); }));
    $('#status').textContent = `GW${data.gw}${data.deadline ? ' · deadline ' + gmt(data.deadline) + ' GMT' : ''} · FPL news checked ${ago(new Date(data.updatedAt).toISOString())}`;
    render();
  }).catch((e) => {
    $('#status').textContent = 'Team news not loaded';
    $('#error').textContent = String(e.message || e);
    $('#error').hidden = false;
  });
})();
