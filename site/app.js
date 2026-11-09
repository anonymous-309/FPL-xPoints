(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORE = 'xmin-overrides';
  const state = { data: null, pos: '', sort: 'total', dir: -1, overrides: loadOverrides(), detail: null };
  const PARTS = { app: 'Ra sân', goal: 'Bàn thắng', assist: 'Kiến tạo', bonus: 'Bonus', cs: 'Sạch lưới', conceded: 'Bàn thua', saves: 'Cản phá', defcon: 'DEFCON', cards: 'Thẻ' };
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const f1 = (x) => x.toFixed(1);

  function loadOverrides() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function saveOverrides() { try { localStorage.setItem(STORE, JSON.stringify(state.overrides)); } catch (e) { /* edits still work for this visit */ } updateReset(); }
  const parseMinutes = (text) => {
    if (text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(90, n))) : undefined;
  };
  function overrideFor(p, g) {
    const o = state.overrides[p.id];
    if (!o) return null;
    if (o.gw && o.gw[g] !== undefined) return o.gw[g];
    return o.all === undefined ? null : o.all;
  }
  // Points for a gameweek, rescaled when the viewer has set their own minutes per match.
  function view(p, g) {
    const d = p.byGw[g];
    if (!d) return null;
    const x = overrideFor(p, g);
    if (x === null) return d;
    const n = d.opp.length, r = x / 90, f = d.full, full = x >= 60;
    const parts = { app: (x <= 0 ? 0 : full ? 2 : 1) * n, goal: f.goal * r, assist: f.assist * r, bonus: f.bonus * r, cs: full ? f.cs : 0, conceded: f.conceded * r, saves: f.saves * r, defcon: full ? f.defcon : 0, cards: f.cards * r };
    return { ...d, parts, xpts: Object.values(parts).reduce((a, b) => a + b, 0), xmin: x * n, xg: f.xg * r, xa: f.xa * r, edited: true };
  }
  const breakdownText = (d) => Object.entries(PARTS).map(([k, label]) => `${label}: ${d.parts[k] >= 0 ? '+' : ''}${d.parts[k].toFixed(2)}`).join('\n') + `\nxG ${d.xg.toFixed(2)}, xA ${d.xa.toFixed(2)}`;
  const findPlayer = (id) => state.data.players.find((p) => p.id === id);
  function refreshRow(p) {
    const tr = $('table').tBodies[0].querySelector(`tr[data-pid="${CSS.escape(p.id)}"]`);
    if (tr) tr.replaceWith(row(p, visibleGws()));
  }
  function updateReset() {
    const n = Object.keys(state.overrides).length;
    $('reset').hidden = n === 0;
    $('reset').textContent = `Khôi phục xMin mặc định (${n})`;
  }
  function openText(text) {
    state.detail = null;
    $('detail-text').textContent = text;
    $('detail-min-row').hidden = true;
    $('detail').hidden = false;
  }
  function openGw(p, g) {
    state.detail = { id: p.id, g };
    const d = view(p, g);
    $('detail-text').textContent = `${p.name}, GW${g} gặp ${d.opp.join(', ')}\nDự kiến ${f1(d.xpts)} điểm, ${Math.round(d.xmin)} phút\n${breakdownText(d)}`;
    const o = state.overrides[p.id];
    $('detail-min').value = o && o.gw && o.gw[g] !== undefined ? o.gw[g] : '';
    $('detail-min').placeholder = Math.round(d.xmin / d.opp.length);
    $('detail-min-row').hidden = false;
    $('detail').hidden = false;
  }
  function tidy(id) {
    const o = state.overrides[id];
    if (o && o.gw && !Object.keys(o.gw).length) delete o.gw;
    if (o && o.all === undefined && !o.gw) delete state.overrides[id];
  }

  function heat(cell, x) {
    const t = Math.max(0, Math.min(1, (x - 1) / 6));
    cell.style.background = `color-mix(in srgb, #0e5a41 ${Math.round(t * 100)}%, #edf3ec)`;
    cell.style.color = t > 0.68 ? '#fff' : '#17261f';
  }

  function visibleGws() { return state.data.gws.slice(0, Number($('horizon').value)); }
  const total = (p, gws) => gws.reduce((s, g) => s + (p.byGw[g] ? view(p, g).xpts : 0), 0);
  const nextXmin = (p, gws) => { const d = view(p, gws[0]); return d ? d.xmin / d.opp.length : 0; };

  function filtered(gws) {
    const q = $('search').value.trim().toLowerCase();
    const team = $('team').value;
    const max = parseFloat($('price').value);
    const value = {
      name: (p) => p.name.toLowerCase(), price: (p) => p.price, xmin: (p) => nextXmin(p, gws), total: (p) => total(p, gws),
    }[state.sort] || ((p) => (p.byGw[state.sort] ? view(p, state.sort).xpts : -99));
    return state.data.players
      .filter((p) => (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
      .sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
  }

  function header(gws) {
    const columns = [['name', 'Cầu thủ'], ['price', 'Giá'], ['xmin', 'xMin'], ...gws.map((g) => [String(g), `GW${g}`]), ['total', 'Tổng']];
    $('table').tHead.replaceChildren(el('tr', {}, ...columns.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; }
        render();
      } }));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  function row(p, gws) {
    const meta = el('span', { textContent: `${p.team} ${p.position}` });
    const name = el('td', { className: 'player', title: p.news || p.fullName }, el('b', { textContent: p.name }), meta);
    if (p.news) name.dataset.news = `${p.name}: ${p.news}`;
    if (p.status && p.status !== 'a') meta.append(' ', el('span', { className: 'flag', textContent: 'Có tin vắng' }));
    const cells = gws.map((g) => {
      const d = view(p, g);
      if (!d) return el('td', { className: 'none', textContent: 'Không đá' });
      const c = el('td', { className: 'gw', title: breakdownText(d), tabIndex: 0 }, el('strong', { textContent: f1(d.xpts) }), el('small', { textContent: d.opp.join(', ') }));
      c.dataset.gw = g;
      heat(c, d.xpts / Math.max(1, d.opp.length) * (d.opp.length > 1 ? 1.25 : 1));
      return c;
    });
    const first = p.byGw[gws[0]];
    const saved = state.overrides[p.id] && state.overrides[p.id].all;
    const input = el('input', {
      className: 'xmin-input', type: 'number', min: 0, max: 90, step: 1, inputMode: 'numeric',
      value: saved === undefined ? '' : saved,
      placeholder: first ? String(Math.round(first.xmin / first.opp.length)) : '',
    });
    input.setAttribute('aria-label', `Số phút mỗi trận của ${p.name}`);
    const tr = el('tr', {}, name, el('td', { textContent: `£${p.price.toFixed(1)}` }), el('td', { className: 'xmin' }, input), ...cells, el('td', { className: 'total', textContent: f1(total(p, gws)) }));
    tr.dataset.pid = p.id;
    return tr;
  }

  function render() {
    if (!state.data) return;
    const gws = visibleGws();
    if (/^\d+$/.test(state.sort) && !gws.includes(Number(state.sort))) state.sort = 'total';
    header(gws);
    const list = filtered(gws);
    const body = list.length ? list.map((p) => row(p, gws))
      : [el('tr', {}, el('td', { colSpan: gws.length + 4, className: 'none', textContent: 'Không có cầu thủ nào khớp bộ lọc. Hãy nới bộ lọc giá, đội hoặc vị trí.' }))];
    $('table').tBodies[0].replaceChildren(...body);
  }

  function show(data) {
    state.data = data;
    $('empty').hidden = true;
    $('wrap').hidden = false;
    const when = new Date(data.updatedAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
    $('status').textContent = `Từ GW${data.gws[0]}, cập nhật lúc ${when}`;
    $('warnings').textContent = data.warnings.join(' ');
    const current = $('team').value;
    $('team').replaceChildren(el('option', { value: '', textContent: 'Tất cả' }), ...[...new Set(data.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
    $('team').value = current;
    updateReset();
    render();
  }

  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  const tbody = $('table').tBodies[0];
  tbody.addEventListener('click', (e) => {
    const gwCell = e.target.closest('td.gw');
    if (gwCell) { openGw(findPlayer(gwCell.closest('tr').dataset.pid), Number(gwCell.dataset.gw)); return; }
    const nameCell = e.target.closest('td.player');
    if (nameCell && nameCell.dataset.news) openText(nameCell.dataset.news);
  });
  tbody.addEventListener('keydown', (e) => {
    const td = e.target.closest('td.gw');
    if (td && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openGw(findPlayer(td.closest('tr').dataset.pid), Number(td.dataset.gw)); }
  });
  tbody.addEventListener('change', (e) => {
    if (!e.target.matches('.xmin-input')) return;
    const p = findPlayer(e.target.closest('tr').dataset.pid);
    const v = parseMinutes(e.target.value);
    if (v === undefined) return;
    if (v === null) { if (state.overrides[p.id]) delete state.overrides[p.id].all; } else { state.overrides[p.id] = { ...(state.overrides[p.id] || {}), all: v }; }
    tidy(p.id);
    saveOverrides();
    refreshRow(p);
    if (state.detail && state.detail.id === p.id) openGw(p, state.detail.g);
  });
  $('detail-min').addEventListener('change', (e) => {
    if (!state.detail) return;
    const p = findPlayer(state.detail.id), g = state.detail.g, v = parseMinutes(e.target.value);
    if (v === undefined) return;
    const o = state.overrides[p.id] || (state.overrides[p.id] = {});
    o.gw = o.gw || {};
    if (v === null) delete o.gw[g]; else o.gw[g] = v;
    tidy(p.id);
    saveOverrides();
    refreshRow(p);
    openGw(p, g);
  });
  $('reset').addEventListener('click', () => { state.overrides = {}; saveOverrides(); $('detail').hidden = true; render(); });
  $('close').addEventListener('click', () => { $('detail').hidden = true; });

  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(show)
    .catch(() => {
      $('error').textContent = 'Chưa đọc được bảng điểm. Mở tab Actions trên GitHub để xem lần chạy gần nhất có lỗi không, rồi tải lại trang.';
      $('error').hidden = false;
      $('status').textContent = 'Chưa có dữ liệu';
    });
})();
