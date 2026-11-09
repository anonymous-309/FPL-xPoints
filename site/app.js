(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { data: null, pos: '', sort: 'total', dir: -1 };
  const PARTS = { app: 'Ra sân', goal: 'Bàn thắng', assist: 'Kiến tạo', bonus: 'Bonus', cs: 'Sạch lưới', conceded: 'Bàn thua', saves: 'Cản phá', defcon: 'DEFCON', cards: 'Thẻ' };
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const f1 = (x) => x.toFixed(1);

  function openDetail(text) {
    $('detail-text').textContent = text;
    $('detail').hidden = false;
  }

  function heat(cell, x) {
    const t = Math.max(0, Math.min(1, (x - 1) / 6));
    cell.style.background = `color-mix(in srgb, #0e5a41 ${Math.round(t * 100)}%, #edf3ec)`;
    cell.style.color = t > 0.68 ? '#fff' : '#17261f';
  }

  function visibleGws() { return state.data.gws.slice(0, Number($('horizon').value)); }
  const total = (p, gws) => gws.reduce((s, g) => s + (p.byGw[g] ? p.byGw[g].xpts : 0), 0);
  const nextXmin = (p, gws) => { const g = p.byGw[gws[0]]; return g ? g.xmin : 0; };

  function filtered(gws) {
    const q = $('search').value.trim().toLowerCase();
    const team = $('team').value;
    const max = parseFloat($('price').value);
    const value = {
      name: (p) => p.name.toLowerCase(), price: (p) => p.price, xmin: (p) => nextXmin(p, gws), total: (p) => total(p, gws),
    }[state.sort] || ((p) => (p.byGw[state.sort] ? p.byGw[state.sort].xpts : -99));
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
    if (p.news) name.dataset.detail = `${p.name}: ${p.news}`;
    if (p.status && p.status !== 'a') meta.append(' ', el('span', { className: 'flag', textContent: 'Có tin vắng' }));
    const cells = gws.map((g) => {
      const d = p.byGw[g];
      if (!d) return el('td', { className: 'none', textContent: 'Không đá' });
      const breakdown = Object.entries(PARTS).map(([k, label]) => `${label}: ${d.parts[k] >= 0 ? '+' : ''}${d.parts[k].toFixed(2)}`).join('\n') + `\nxG ${d.xg.toFixed(2)}, xA ${d.xa.toFixed(2)}`;
      const c = el('td', { className: 'gw', title: breakdown, tabIndex: 0 }, el('strong', { textContent: f1(d.xpts) }), el('small', { textContent: d.opp.join(', ') }));
      c.dataset.detail = `${p.name}, GW${g} gặp ${d.opp.join(', ')}\nDự kiến ${f1(d.xpts)} điểm, ${Math.round(d.xmin)} phút\n${breakdown}`;
      heat(c, d.xpts / Math.max(1, d.opp.length) * (d.opp.length > 1 ? 1.25 : 1));
      return c;
    });
    return el('tr', {}, name, el('td', { textContent: `£${p.price.toFixed(1)}` }), el('td', { textContent: Math.round(nextXmin(p, gws)) }), ...cells, el('td', { className: 'total', textContent: f1(total(p, gws)) }));
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
    render();
  }

  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));
  $('table').tBodies[0].addEventListener('click', (e) => {
    const td = e.target.closest('td.gw, td.player');
    if (td && td.dataset.detail) openDetail(td.dataset.detail);
  });
  $('table').tBodies[0].addEventListener('keydown', (e) => {
    const td = e.target.closest('td.gw');
    if (td && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(td.dataset.detail); }
  });
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
