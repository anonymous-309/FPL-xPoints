(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  // SHA-256 of the password. This only keeps casual visitors out: the GitHub token is what allows saving.
  const PASS = 'a5d9a53097f41fe4cff463a5b0d8fec6bbb6bf363f642a5cb56f54f9998a4f81';
  const TOKEN_KEY = 'admin-gh-token';
  const FILE = 'admin_minutes.json';
  const REPO = (() => {
    const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'anonymous-309';
    const name = location.pathname.split('/').filter(Boolean)[0] || 'FPL-xPoints';
    return `${owner}/${name.endsWith('.html') ? 'FPL-xPoints' : name}`;
  })();
  const API = `https://api.github.com/repos/${REPO}/contents/${FILE}`;
  const state = { players: [], admin: {}, sha: null, pending: {}, pos: '', onlySet: false };

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
      const [data] = await Promise.all([fetch('data.json', { cache: 'no-store' }).then((r) => r.json()), loadAdminFile()]);
      state.players = data.players.slice().sort((a, b) => (b.minModel ?? b.minUsual) - (a.minModel ?? a.minUsual));
      $('team').replaceChildren(el('option', { value: '', textContent: 'All' }), ...[...new Set(state.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      $('panel').hidden = false;
      render();
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
  window.addEventListener('beforeunload', (e) => { if (Object.keys(state.pending).length) { e.preventDefault(); e.returnValue = ''; } });

  if (store.get('admin-open', sessionStorage)) openPanel();
})();
