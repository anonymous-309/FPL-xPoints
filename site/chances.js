(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const state = { data: null, pos: '', sort: 'pScore', dir: -1 };
  const METRICS = [['pScore', 'Ghi bàn', 0.6], ['pAssist', 'Kiến tạo', 0.35], ['pCs', 'Sạch lưới', 0.6]];

  function heat(cell, t) {
    const v = Math.max(0, Math.min(1, t));
    cell.style.background = `color-mix(in srgb, #0e5a41 ${Math.round(v * 100)}%, #edf3ec)`;
    cell.style.color = v > 0.68 ? '#fff' : '#17261f';
  }

  function header() {
    const cols = [['name', 'Cầu thủ'], ['price', 'Giá'], ['opp', 'Đối thủ'], ...METRICS.map(([k, l]) => [k, l])];
    $('table').tHead.replaceChildren(el('tr', {}, ...cols.map(([key, label]) => {
      const th = el('th', { scope: 'col' }, el('button', { type: 'button', textContent: label, onclick: () => {
        if (state.sort === key) state.dir *= -1; else { state.sort = key; state.dir = key === 'name' || key === 'opp' ? 1 : -1; }
        render();
      } }));
      if (state.sort === key) th.setAttribute('aria-sort', state.dir < 0 ? 'descending' : 'ascending');
      return th;
    })));
  }

  function row(p, d) {
    const name = el('td', { className: 'player', title: p.news || p.fullName }, el('b', { textContent: p.name }), el('span', { textContent: `${p.team} ${p.position}` }));
    const cells = METRICS.map(([key, , full]) => {
      const c = el('td', { className: 'gw prob' }, el('strong', { textContent: `${Math.round(d[key] * 100)}%` }), el('small', { textContent: (1 / Math.max(d[key], 0.001)).toFixed(2) }));
      heat(c, d[key] / full);
      return c;
    });
    return el('tr', {}, name, el('td', { textContent: `£${p.price.toFixed(1)}` }), el('td', { className: 'opp', textContent: d.opp.join(', ') }), ...cells);
  }

  function render() {
    if (!state.data) return;
    header();
    const gw = $('gw').value, q = $('search').value.trim().toLowerCase(), team = $('team').value, max = parseFloat($('price').value);
    const value = (p, d) => (state.sort === 'name' ? p.name.toLowerCase() : state.sort === 'price' ? p.price : state.sort === 'opp' ? d.opp.join() : d[state.sort]);
    const list = state.data.players
      .filter((p) => p.byGw[gw] && (!state.pos || p.position === state.pos) && (!team || p.team === team) && (!(max > 0) || p.price <= max)
        && (!q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)))
      .sort((a, b) => { const x = value(a, a.byGw[gw]), y = value(b, b.byGw[gw]); return (x < y ? -1 : x > y ? 1 : 0) * state.dir; });
    $('table').tBodies[0].replaceChildren(...(list.length ? list.map((p) => row(p, p.byGw[gw]))
      : [el('tr', {}, el('td', { colSpan: 6, className: 'none', textContent: 'Không có cầu thủ nào khớp bộ lọc. Hãy nới bộ lọc giá, đội hoặc vị trí.' }))]));
  }

  $('filters').addEventListener('input', render);
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.pos = b.dataset.pos;
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }));

  fetch('data.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      state.data = data;
      $('gw').replaceChildren(...data.gws.map((g) => el('option', { value: String(g), textContent: `GW${g}` })));
      $('team').append(...[...new Set(data.players.map((p) => p.team))].sort().map((t) => el('option', { value: t, textContent: t })));
      const when = new Date(data.updatedAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
      $('status').textContent = `Cập nhật lúc ${when}`;
      $('wrap').hidden = false;
      render();
    })
    .catch(() => {
      $('error').textContent = 'Chưa đọc được dữ liệu. Mở tab Actions trên GitHub để xem lần chạy gần nhất có lỗi không, rồi tải lại trang.';
      $('error').hidden = false;
      $('status').textContent = 'Chưa có dữ liệu';
    });
})();
