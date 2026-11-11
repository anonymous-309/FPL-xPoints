(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  // SHA-256 of the password. This only keeps casual visitors out: the GitHub token is what allows saving.
  const PASS = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const TOKEN_KEY = 'admin-gh-token';
  const REPO = (() => {
    const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'anonymous-309';
    const name = location.pathname.split('/').filter(Boolean)[0] || 'FPL-xPoints';
    return `${owner}/${name.endsWith('.html') ? 'FPL-xPoints' : name}`;
  })();
  const MIN_API = `https://api.github.com/repos/${REPO}/contents/admin_minutes.json`;
  const INJ_API = `https://api.github.com/repos/${REPO}/contents/admin_injuries.json`;
  const EMPTY_INJ = { manual: [], startOverrides: {} };
  const state = { players: [], admin: {}, inj: { manual: [], startOverrides: {} }, auto: [], pos: { inj: '', min: '' }, tab: 'abs', busy: false };

  const store = {
    get: (k, s = localStorage) => { try { return s.getItem(k); } catch (e) { return null; } },
    set: (k, v, s = localStorage) => { try { s.setItem(k, v); } catch (e) { /* this visit only */ } },
    del: (k, s = localStorage) => { try { s.removeItem(k); } catch (e) { /* fine */ } },
  };
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const b64 = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const unb64 = (text) => new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  function fail(msg) { $('error').textContent = msg; $('error').hidden = false; }
  const headers = () => ({ Authorization: `Bearer ${store.get(TOKEN_KEY)}`, Accept: 'application/vnd.github+json' });
  const when = () => new Date().toLocaleTimeString('en-GB', { timeStyle: 'short' });
  const label = (p) => `${p.name} · ${p.team} ${p.position}`;
  const formula = (p) => Math.round(p.minModel ?? p.minUsual);

  async function ghGet(url, empty) {
    const r = await fetch(`${url}?ref=main`, { headers: headers(), cache: 'no-store' });
    if (r.status === 404) return { data: empty, sha: null };
    if (r.status === 401 || r.status === 403) throw new Error('token');
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    return { data: JSON.parse(unb64(j.content) || 'null') || empty, sha: j.sha };
  }
  async function ghPut(url, data, sha, message) {
    const body = { message: message.slice(0, 200), content: b64(JSON.stringify(data, null, 1) + '\n'), branch: 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(url, { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error('token');
    if (!r.ok) throw new Error(String(r.status));
  }

  // Each change is saved straight away: read the latest file, apply the change to it, write it back.
  async function commit(url, empty, change, message, statusId) {
    if (state.busy) return false;
    state.busy = true;
    $(statusId).textContent = 'Saving…';
    $('error').hidden = true;
    try {
      const latest = await ghGet(url, empty);
      const next = change(JSON.parse(JSON.stringify(latest.data)));
      await ghPut(url, next, latest.sha, message);
      $(statusId).textContent = `Saved at ${when()}. The site uses it in about 10 minutes.`;
      return next;
    } catch (e) {
      $(statusId).textContent = '';
      fail(e.message === 'token' ? 'GitHub refused the token. Tap Forget token and enter one with Contents: Read and write on FPL-xPoints.'
        : `Could not save (${e.message}). Try again.`);
      return false;
    } finally { state.busy = false; }
  }

  // ---- shared player picker (position buttons + team) ----
  function pickList(kind) {
    const team = $(`${kind}Team`).value, pos = state.pos[kind];
    const list = state.players.filter((p) => (!pos || p.position === pos) && (!team || p.team === team))
      .slice().sort((a, b) => a.name.localeCompare(b.name));
    $(`${kind}Players`).replaceChildren(...list.map((p) => el('option', { value: label(p) })));
  }
  function findPlayer(text) {
    const q = text.trim().toLowerCase();
    return state.players.find((x) => label(x).toLowerCase() === q) || state.players.find((x) => x.name.toLowerCase() === q) || null;
  }
  const playerCell = (name, sub) => el('td', { className: 'player' }, el('b', { textContent: name }), el('span', { textContent: sub }));

  // ---- Absences ----
  function renderInjuries() {
    const del = (m) => el('button', { type: 'button', className: 'reset', textContent: 'Delete', onclick: async () => {
      const next = await commit(INJ_API, EMPTY_INJ, (d) => ({ manual: (d.manual || []).filter((x) => x.id !== m.id), startOverrides: d.startOverrides || {} }),
        `Admin injuries: removed ${m.name} GW${m.startGw}`, 'injSaved');
      if (next) { state.inj = next; renderInjuries(); renderMinutes(); }
    } });
    const manual = state.inj.manual.slice().sort((a, b) => b.startGw - a.startGw || a.name.localeCompare(b.name));
    $('injManual').tBodies[0].replaceChildren(...(manual.length ? manual.map((m) => el('tr', {},
      playerCell(m.name, `${m.team} ${m.position || ''}`),
      el('td', { textContent: m.type || 'Injury' }),
      el('td', { textContent: `GW${m.startGw}` }), el('td', { textContent: m.endGw ? `GW${m.endGw}` : 'Still out' }),
      el('td', { className: 'note', textContent: m.note || '' }), el('td', {}, del(m))))
      : [el('tr', {}, el('td', { colSpan: 6, className: 'none', textContent: 'None yet.' }))]));
    const byId = new Map(state.players.map((p) => [p.id, p]));
    $('injAuto').tBodies[0].replaceChildren(...(state.auto.length ? state.auto.map((r) => {
      const auto = r.startGwAuto ?? r.startGw;
      const mine = state.inj.startOverrides[r.id];
      const input = el('input', { className: 'xmin-input', type: 'number', min: 1, max: 38, inputMode: 'numeric', value: mine ?? '', placeholder: `GW${auto}` });
      input.setAttribute('aria-label', `Start gameweek for ${r.name}`);
      input.addEventListener('change', async () => {
        const n = Math.round(Number(input.value));
        const clear = input.value.trim() === '' || n === auto;
        if (!clear && !(n >= 1 && n <= 38)) { input.value = mine ?? ''; return; }
        const next = await commit(INJ_API, EMPTY_INJ, (d) => {
          const so = { ...(d.startOverrides || {}) };
          if (clear) delete so[r.id]; else so[r.id] = n;
          return { manual: d.manual || [], startOverrides: so };
        }, `Admin injuries: ${r.name} start ${clear ? 'from the log' : 'GW' + n}`, 'injSaved');
        if (next) state.inj = next;
        renderInjuries();
      });
      const p = byId.get(r.pid);
      return el('tr', {}, playerCell(r.name, `${r.team} ${p ? p.position : ''}`),
        el('td', { textContent: `GW${auto}` }), el('td', { className: mine !== undefined ? 'fut edited' : 'fut' }, input), el('td', { className: 'note', textContent: r.news || '' }));
    }) : [el('tr', {}, el('td', { colSpan: 4, className: 'none', textContent: 'Nobody is out right now.' }))]));
  }

  $('injAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = findPlayer($('injPlayer').value);
    const start = Math.round(Number($('injStart').value)), endText = $('injEnd').value.trim(), end = endText === '' ? null : Math.round(Number(endText));
    if (!p) { fail('Pick a player from the list.'); return; }
    if (!(start >= 1 && start <= 38) || (end !== null && !(end >= start && end <= 38))) { fail('Start GW must be 1-38, and End GW empty or not before Start GW.'); return; }
    const entry = { id: `${p.id}-admin-GW${start}-${Date.now().toString(36)}`, pid: p.id, name: p.name, team: p.team, position: p.position,
      type: $('injType').value, startGw: start, endGw: end, note: $('injNote').value.trim(), at: new Date().toISOString() };
    const next = await commit(INJ_API, EMPTY_INJ, (d) => ({ manual: [...(d.manual || []), entry], startOverrides: d.startOverrides || {} }),
      `Admin injuries: ${p.name} ${entry.type} GW${start}${end ? '-' + end : '+'}`, 'injSaved');
    if (next) { state.inj = next; $('injAdd').reset(); renderInjuries(); renderMinutes(); }
  });

  // ---- Minutes ----
  function renderMinutes() {
    const byId = new Map(state.players.map((p) => [p.id, p]));
    const rows = Object.entries(state.admin).map(([pid, v]) => ({ pid, v, p: byId.get(pid) }))
      .sort((a, b) => (a.p ? a.p.name : a.v.name || a.pid).localeCompare(b.p ? b.p.name : b.v.name || b.pid));
    $('minSet').tBodies[0].replaceChildren(...(rows.length ? rows.map(({ pid, v, p }) => el('tr', {},
      playerCell(p ? p.name : v.name || pid, p ? `${p.team} ${p.position} £${p.price.toFixed(1)}` : v.team || 'Not in the current data'),
      el('td', { className: 'usual', textContent: p ? formula(p) : '–' }),
      el('td', { className: 'usual admin-set', textContent: v.min }),
      el('td', {}, el('button', { type: 'button', className: 'reset', textContent: 'Delete', onclick: async () => {
        const next = await commit(MIN_API, {}, (d) => { delete d[pid]; return d; }, `Admin minutes: ${p ? p.name : pid} back to the formula`, 'saved');
        if (next) { state.admin = next; renderMinutes(); }
      } }))))
      : [el('tr', {}, el('td', { colSpan: 4, className: 'none', textContent: 'None yet. Every player uses the formula.' }))]));
    const n = rows.length, a = state.inj.manual.length;
    $('status').textContent = `${n} player${n === 1 ? '' : 's'} with admin minutes, ${a} absence${a === 1 ? '' : 's'} added`;
  }

  function showFormula() {
    const p = findPlayer($('minPlayer').value);
    $('minFormula').textContent = p ? `${formula(p)} min` : '–';
    if (p && state.admin[p.id] && $('minValue').value === '') $('minValue').value = state.admin[p.id].min;
  }
  $('minPlayer').addEventListener('input', showFormula);
  $('minAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = findPlayer($('minPlayer').value);
    const v = Math.round(Number($('minValue').value));
    if (!p) { fail('Pick a player from the list.'); return; }
    if (!($('minValue').value.trim() !== '' && v >= 0 && v <= 90)) { fail('Admin min must be 0-90.'); return; }
    const next = await commit(MIN_API, {}, (d) => ({ ...d, [p.id]: { min: v, name: p.name, team: p.team } }), `Admin minutes: ${p.name} ${v}`, 'saved');
    if (next) { state.admin = next; $('minAdd').reset(); $('minFormula').textContent = '–'; renderMinutes(); }
  });

  // ---- tabs, sign-in, loading ----
  function showTab(name) {
    state.tab = name === 'min' ? 'min' : 'abs';
    store.set('admin-tab', state.tab);
    [['tab-abs', 'abs', 'injPanel'], ['tab-min', 'min', 'panel']].forEach(([tab, key, panel]) => {
      $(tab).setAttribute('aria-selected', String(state.tab === key));
      $(tab).tabIndex = state.tab === key ? 0 : -1;
      $(panel).hidden = state.tab !== key;
    });
    $('error').hidden = true;
  }

  async function openPanel() {
    $('gate').hidden = true;
    if (!store.get(TOKEN_KEY)) { $('tokenForm').hidden = false; return; }
    $('tokenForm').hidden = true;
    $('error').hidden = true;
    try {
      const [data, inj, log, mins] = await Promise.all([fetch('data.json', { cache: 'no-store' }).then((r) => r.json()), ghGet(INJ_API, EMPTY_INJ),
        fetch('injury_log.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).catch(() => []), ghGet(MIN_API, {})]);
      state.inj = { manual: inj.data.manual || [], startOverrides: inj.data.startOverrides || {} };
      state.admin = mins.data || {};
      state.auto = log.filter((r) => !r.manual && r.status === 'out').sort((a, b) => a.name.localeCompare(b.name));
      state.players = data.players.slice();
      const teams = [...new Set(state.players.map((p) => p.team))].sort();
      ['injTeam', 'minTeam'].forEach((id) => $(id).replaceChildren(el('option', { value: '', textContent: 'All' }), ...teams.map((t) => el('option', { value: t, textContent: t }))));
      $('tabs').hidden = false;
      showTab(store.get('admin-tab') || 'abs');
      pickList('inj');
      pickList('min');
      renderInjuries();
      renderMinutes();
    } catch (e) {
      if (e.message === 'token') { store.del(TOKEN_KEY); $('tokenForm').hidden = false; fail('GitHub refused the token. Enter a token with Contents: Read and write on FPL-xPoints.'); } else fail('Could not load the players. Reload the page to try again.');
    }
  }

  ['inj', 'min'].forEach((kind) => {
    const form = $(`${kind}Pick`);
    form.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
      state.pos[kind] = b.dataset.pos;
      form.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      pickList(kind);
    }));
    $(`${kind}Team`).addEventListener('change', () => pickList(kind));
    form.addEventListener('submit', (e) => e.preventDefault());
  });
  [['tab-abs', 'abs'], ['tab-min', 'min']].forEach(([id, name]) => $(id).addEventListener('click', () => showTab(name)));
  $('tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    showTab(state.tab === 'abs' ? 'min' : 'abs');
    $(state.tab === 'abs' ? 'tab-abs' : 'tab-min').focus();
  });
  $('gate').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await sha256($('pass').value) === PASS) { store.set('admin-open', '1', sessionStorage); openPanel(); } else { fail('Wrong password.'); $('pass').value = ''; }
  });
  $('tokenForm').addEventListener('submit', (e) => { e.preventDefault(); store.set(TOKEN_KEY, $('token').value.trim()); $('token').value = ''; openPanel(); });
  $('forget').addEventListener('click', () => { store.del(TOKEN_KEY); ['panel', 'injPanel', 'tabs'].forEach((id) => { $(id).hidden = true; }); $('tokenForm').hidden = false; });

  if (store.get('admin-open', sessionStorage)) openPanel();
})();
