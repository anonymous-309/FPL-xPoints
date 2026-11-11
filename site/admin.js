(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  // SHA-256 of the password. This only keeps casual visitors out: the GitHub token is what allows saving.
  const PASS = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const TOKEN_KEY = 'admin-gh-token';
  const FILE = 'admin_minutes.json';
  const REPO = (() => {
    const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'anonymous-309';
    const name = location.pathname.split('/').filter(Boolean)[0] || 'FPL-xPoints';
    return `${owner}/${name.endsWith('.html') ? 'FPL-xPoints' : name}`;
  })();
  const API = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
  const INJ_API = `https://api.github.com/repos/${REPO}/contents/admin_injuries.json`;
  const state = { players: [], admin: {}, sha: null, pending: {}, pos: '', onlySet: false,
    inj: { manual: [], startOverrides: {} }, injSha: null, injDirty: false, auto: [] };

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

  async function loadAdminFile() {
    const r = await fetch(`${API}?ref=main`, { headers: headers(), cache: 'no-store' });
    if (r.status === 404) { state.admin = {}; state.sha = null; return; }
    if (r.status === 401 || r.status === 403) throw new Error('token');
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    state.sha = j.sha;
    state.admin = JSON.parse(unb64(j.content) || '{}');
  }

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
    if (r.status === 409) throw new Error('changed');
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()).content.sha;
  }
  const label = (p) => `${p.name} · ${p.team} ${p.position}`;

  function renderInjuries() {
    const byId = new Map(state.players.map((p) => [p.id, p]));
    const del = (i) => el('button', { type: 'button', className: 'reset', textContent: 'Delete', onclick: () => { state.inj.manual.splice(i, 1); state.injDirty = true; renderInjuries(); } });
    $('injManual').tBodies[0].replaceChildren(...(state.inj.manual.length ? state.inj.manual.map((m, i) => el('tr', { className: m.unsaved ? 'changed' : '' },
      el('td', { className: 'player' }, el('b', { textContent: m.name }), el('span', { textContent: `${m.team} ${m.position || ''}` })),
      el('td', { textContent: `GW${m.startGw}` }), el('td', { textContent: m.endGw ? `GW${m.endGw}` : 'Still out' }),
      el('td', { className: 'note', textContent: m.note || '' }), el('td', {}, del(i))))
      : [el('tr', {}, el('td', { colSpan: 5, className: 'none', textContent: 'None yet.' }))]));
    $('injAuto').tBodies[0].replaceChildren(...state.auto.map((r) => {
      const auto = r.startGwAuto ?? r.startGw;
      const mine = state.inj.startOverrides[r.id];
      const input = el('input', { className: 'xmin-input', type: 'number', min: 1, max: 38, inputMode: 'numeric', value: mine ?? '', placeholder: `GW${auto}` });
      input.setAttribute('aria-label', `Start gameweek for ${r.name}`);
      input.addEventListener('change', () => {
        const n = Math.round(Number(input.value));
        if (input.value.trim() === '' || n === auto) delete state.inj.startOverrides[r.id];
        else if (n >= 1 && n <= 38) state.inj.startOverrides[r.id] = n; else { input.value = mine ?? ''; return; }
        state.injDirty = true; renderInjuries();
      });
      const p = byId.get(r.pid);
      return el('tr', { className: mine !== undefined ? 'changed' : '' },
        el('td', { className: 'player' }, el('b', { textContent: r.name }), el('span', { textContent: `${r.team} ${p ? p.position : ''}` })),
        el('td', { textContent: `GW${auto}` }), el('td', { className: mine !== undefined ? 'fut edited' : 'fut' }, input), el('td', { className: 'note', textContent: r.news || '' }));
    }));
    $('injSave').disabled = !state.injDirty;
  }

  async function saveInjuries() {
    $('injSave').disabled = true;
    $('injSaved').textContent = 'Saving…';
    try {
      const latest = await ghGet(INJ_API, { manual: [], startOverrides: {} });
      const data = { manual: state.inj.manual.map(({ unsaved, ...m }) => m), startOverrides: state.inj.startOverrides };
      state.injSha = await ghPut(INJ_API, data, latest.sha, `Admin injuries: ${data.manual.length} added by hand, ${Object.keys(data.startOverrides).length} start corrections`);
      state.inj = data;
      state.injDirty = false;
      $('injSaved').textContent = `Saved at ${new Date().toLocaleTimeString('en-GB', { timeStyle: 'short' })}. The site uses them in about 10 minutes.`;
    } catch (e) {
      $('injSaved').textContent = '';
      fail(e.message === 'token' ? 'GitHub refused the token. Tap Forget token and enter one with Contents: Read and write.' : `Could not save the injuries (${e.message}). Your changes are still here; try Save again.`);
    }
    renderInjuries();
  }

  function value(p) {
    if (p.id in state.pending) return state.pending[p.id];
    return state.admin[p.id] ? state.admin[p.id].min : null;
  }

  function row(p) {
    const v = value(p);
    const formula = p.minModel ?? p.minUsual;
    const input = el('input', { className: 'xmin-input', type: 'text', inputMode: 'numeric', value: v === null ? '' : v, placeholder: String(Math.round(formula)) });
    input.setAttribute('aria-label', `Admin minutes for ${p.name}`);
    input.dataset.pid = p.id;
    const changed = p.id in state.pending;
    return el('tr', { className: changed ? 'changed' : '' },
      el('td', { className: 'player' }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position} £${p.price.toFixed(1)}` })),
      el('td', { className: 'usual', textContent: Math.round(formula) }),
      el('td', { className: v === null ? 'fut' : 'fut edited' }, input),
      el('td', { className: 'note', textContent: [changed ? 'Not saved' : '', p.minNote || ''].filter(Boolean).join('; ') }));
  }

  function render() {
    const q = $('search').value.trim().toLowerCase(), team = $('team').value;
    const list = state.players.filter((p) => (!state.pos || p.position === state.pos) && (!team || p.team === team)
      && (!state.onlySet || value(p) !== null || p.id in state.pending)
      && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)));
    $('table').tBodies[0].replaceChildren(...(list.length ? list.slice(0, 300).map(row)
      : [el('tr', {}, el('td', { colSpan: 4, className: 'none', textContent: 'No players match these filters.' }))]));
    const n = Object.keys(state.pending).length;
    $('save').disabled = n === 0;
    $('save').textContent = n ? `Save ${n} change${n === 1 ? '' : 's'}` : 'Save';
    const set = Object.keys(state.admin).length;
    $('status').textContent = `${set} player${set === 1 ? '' : 's'} with admin minutes`;
  }

  async function save() {
    $('save').disabled = true;
    $('saved').textContent = 'Saving…';
    try {
      await loadAdminFile();  // latest copy, in case it changed elsewhere
      const next = { ...state.admin };
      const byId = new Map(state.players.map((p) => [p.id, p]));
      const lines = [];
      Object.entries(state.pending).forEach(([pid, v]) => {
        const p = byId.get(pid);
        if (v === null) { delete next[pid]; lines.push(`${p ? p.name : pid} cleared`); } else { next[pid] = { min: v, name: p ? p.name : pid, team: p ? p.team : '' }; lines.push(`${p ? p.name : pid} ${v}`); }
      });
      const body = { message: `Admin minutes: ${lines.join(', ')}`.slice(0, 200), content: b64(JSON.stringify(next, null, 1) + '\n'), branch: 'main' };
      if (state.sha) body.sha = state.sha;
      const r = await fetch(API, { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error('token');
      if (!r.ok) throw new Error(String(r.status));
      state.sha = (await r.json()).content.sha;
      state.admin = next;
      state.pending = {};
      $('saved').textContent = `Saved at ${new Date().toLocaleTimeString('en-GB', { timeStyle: 'short' })}. The site shows the new minutes in about 10 minutes.`;
    } catch (e) {
      $('saved').textContent = '';
      fail(e.message === 'token' ? 'GitHub refused the token. Check it has Contents: Read and write on FPL-xPoints, or tap Forget token and enter a new one.'
        : `Could not save (${e.message}). Your changes are still here; try Save again.`);
    }
    render();
  }

  async function openPanel() {
    $('gate').hidden = true;
    if (!store.get(TOKEN_KEY)) { $('tokenForm').hidden = false; return; }
    $('tokenForm').hidden = true;
    $('error').hidden = true;
    try {
      const [data, inj, log] = await Promise.all([fetch('data.json', { cache: 'no-store' }).then((r) => r.json()),
        ghGet(INJ_API, { manual: [], startOverrides: {} }), fetch('injury_log.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).catch(() => []), loadAdminFile()]);
      state.inj = { manual: inj.data.manual || [], startOverrides: inj.data.startOverrides || {} };
      state.injSha = inj.sha;
      state.auto = log.filter((r) => !r.manual && r.status === 'out').sort((a, b) => a.name.localeCompare(b.name));
      state.players = data.players.slice().sort((a, b) => (b.minModel ?? b.minUsual) - (a.minModel ?? a.minUsual));
      $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(state.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      $('panel').hidden = false;
      $('injPanel').hidden = false;
      $('playerList').replaceChildren(...state.players.map((p) => el('option', { value: label(p) })));
      render();
      renderInjuries();
    } catch (e) {
      if (e.message === 'token') { store.del(TOKEN_KEY); $('tokenForm').hidden = false; fail('GitHub refused the token. Enter a token with Contents: Read and write on FPL-xPoints.'); } else fail('Could not load the players. Reload the page to try again.');
    }
  }

  $('gate').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await sha256($('pass').value) === PASS) { store.set('admin-open', '1', sessionStorage); openPanel(); } else { fail('Wrong password.'); $('pass').value = ''; }
  });
  $('tokenForm').addEventListener('submit', (e) => { e.preventDefault(); store.set(TOKEN_KEY, $('token').value.trim()); $('token').value = ''; openPanel(); });
  $('forget').addEventListener('click', () => { store.del(TOKEN_KEY); $('panel').hidden = true; $('tokenForm').hidden = false; });
  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('onlySet').addEventListener('click', () => { state.onlySet = !state.onlySet; $('onlySet').setAttribute('aria-pressed', String(state.onlySet)); render(); });
  $('save').addEventListener('click', save);
  $('injSave').addEventListener('click', saveInjuries);
  $('injAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = state.players.find((x) => label(x) === $('injPlayer').value.trim()) || state.players.find((x) => x.name.toLowerCase() === $('injPlayer').value.trim().toLowerCase());
    const start = Math.round(Number($('injStart').value)), endText = $('injEnd').value.trim(), end = endText === '' ? null : Math.round(Number(endText));
    if (!p) { fail('Pick a player from the list.'); return; }
    if (!(start >= 1 && start <= 38) || (end !== null && !(end >= start && end <= 38))) { fail('Start GW must be 1-38, and End GW empty or not before Start GW.'); return; }
    $('error').hidden = true;
    state.inj.manual.push({ id: `${p.id}-admin-GW${start}-${Date.now().toString(36)}`, pid: p.id, name: p.name, team: p.team, position: p.position,
      startGw: start, endGw: end, note: $('injNote').value.trim(), at: new Date().toISOString(), unsaved: true });
    state.injDirty = true;
    $('injAdd').reset();
    renderInjuries();
  });
  $('table').tBodies[0].addEventListener('change', (e) => {
    if (!e.target.matches('.xmin-input')) return;
    const pid = e.target.dataset.pid, text = e.target.value.trim();
    const n = Number(text);
    const v = text === '' ? null : Number.isFinite(n) ? Math.round(Math.max(0, Math.min(90, n))) : undefined;
    if (v === undefined) { e.target.value = ''; return; }
    const saved = state.admin[pid] ? state.admin[pid].min : null;
    if (v === saved) delete state.pending[pid]; else state.pending[pid] = v;
    render();
  });
  $('table').tBodies[0].addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.xmin-input')) { e.preventDefault(); e.target.blur(); } });
  window.addEventListener('beforeunload', (e) => { if (Object.keys(state.pending).length || state.injDirty) { e.preventDefault(); e.returnValue = ''; } });

  if (store.get('admin-open', sessionStorage)) openPanel();
})();
