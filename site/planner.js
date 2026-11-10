(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const KEY = 'planner-entry';

  function playerLine(p, captain) {
    return el('li', {},
      el('span', { className: 'pos', textContent: p.position }),
      el('b', { textContent: p.name + (p.id === captain ? ' (C)' : '') }),
      el('span', { className: 'meta', textContent: `${p.team} ${p.opp && p.opp.length ? 'v ' + p.opp.join(', ') : ''}` }),
      el('span', { className: 'pts', textContent: f1(p.id === captain ? p.xpts * 2 : p.xpts) }));
  }

  function week(w) {
    const moves = w.in.length
      ? el('ul', { className: 'moves' }, ...w.out.map((o, i) => {
        const n = w.in[i];
        return el('li', {}, el('span', { className: 'outp', textContent: `${o.name} £${o.sell.toFixed(1)}` }), ' → ',
          el('span', { className: 'inp', textContent: `${n.name} £${n.price.toFixed(1)}` }), el('span', { className: 'meta', textContent: ` ${n.team} ${n.position}` }));
      }))
      : el('p', { className: 'meta', textContent: 'No transfer: save it' });
    const cost = w.hits ? `${w.hits} hit${w.hits > 1 ? 's' : ''} (−${w.hits * 4})` : 'no hit';
    return el('section', { className: 'week' },
      el('h2', {}, `GW${w.gw}`, el('span', { className: 'meta', textContent: ` ${w.freeTransfers} free transfer${w.freeTransfers === 1 ? '' : 's'}, ${w.in.length} made, ${cost}, bank £${w.bank.toFixed(1)}` }),
        el('span', { className: 'total', textContent: `${f1(w.xpts)} xPts` })),
      moves,
      el('ul', { className: 'xi' }, ...w.xi.map((p) => playerLine(p, w.captain))),
      el('p', { className: 'meta bench', textContent: 'Bench: ' + w.bench.map((p) => `${p.name} ${f1(p.xpts)}`).join(', ') }));
  }

  function show(plan) {
    const when = plan.updatedAt ? new Date(plan.updatedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '';
    $('status').textContent = `${plan.name}${plan.manager ? ' · ' + plan.manager : ''} · after GW${plan.lastGw}${when ? ', worked out ' + when : ''}`;
    const gain = plan.planXpts - plan.holdXpts;
    const summary = el('section', { className: 'summary' },
      el('p', {}, el('b', { textContent: `${f1(plan.planXpts)} xPts` }), ` over GW${plan.gws[0]}-${plan.gws[plan.gws.length - 1]} with these transfers, `,
        el('b', { textContent: `${gain >= 0 ? '+' : ''}${f1(gain)}` }), ` on keeping your squad (${f1(plan.holdXpts)}). Bank £${plan.bank.toFixed(1)}, ${plan.ft} free transfer${plan.ft === 1 ? '' : 's'} now.`),
      plan.madeAlready && plan.madeAlready.length ? el('p', { className: 'meta', textContent: `Already made for GW${plan.lastGw + 1}: ${plan.madeAlready.join(', ')} (counted in your squad and free transfers).` }) : '',
      plan.gap > 0.005 ? el('p', { className: 'meta', textContent: `The search stopped at its time limit; the best possible plan is at most ${(plan.gap * 100).toFixed(1)}% better.` }) : '',
      el('details', {}, el('summary', { textContent: 'Your squad now' }),
        el('ul', { className: 'xi' }, ...plan.current.map((p) => el('li', {}, el('span', { className: 'pos', textContent: p.position }), el('b', { textContent: p.name }),
          el('span', { className: 'meta', textContent: `${p.team} · sells £${(p.sell ?? p.price).toFixed(1)}` }))))));
    $('out').replaceChildren(summary, ...plan.weeks.map(week));
  }

  function load(entry) {
    $('error').hidden = true;
    $('out').replaceChildren();
    $('status').textContent = `Loading team ${entry}`;
    fetch(`plans/${entry}.json`, { cache: 'no-store' })
      .then((r) => { if (r.status === 404) throw new Error('missing'); if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((plan) => { try { localStorage.setItem(KEY, entry); } catch (e) { /* fine */ } show(plan); })
      .catch((e) => {
        $('error').textContent = e.message === 'missing'
          ? `No plan for team ${entry} yet. Add ${entry} to planner_ids.txt in the GitHub repo; the plan appears after the next update.`
          : 'Could not load the plan. Reload the page to try again.';
        $('error').hidden = false;
        $('status').textContent = 'Enter an FPL team ID';
      });
  }

  $('pick').addEventListener('submit', (e) => {
    e.preventDefault();
    const entry = $('entry').value.trim();
    if (/^\d+$/.test(entry)) load(entry);
  });
  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch (e) { saved = ''; }
  const fromUrl = new URLSearchParams(location.search).get('id');
  const start = fromUrl || saved || '11081';
  $('entry').value = start;
  load(start);
})();
