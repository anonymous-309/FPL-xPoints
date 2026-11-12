// FPL proxy for the Planner page, run as a Cloudflare Worker (free plan).
// The FPL API does not let other websites read it from the browser; this Worker reads the few public endpoints the
// planner needs and passes them on with a header that lets the site read them. Read-only, nothing is stored apart
// from a short cache.
//
// Set up: Cloudflare dashboard > Workers & Pages > Create > Worker > Deploy > Edit code > paste this file > Deploy.

const FPL = 'https://fantasy.premierleague.com/api/';
const SITE = 'https://anonymous-309.github.io';
const ALLOWED = [
  /^bootstrap-static\/$/,
  /^entry\/\d{1,10}\/$/,
  /^entry\/\d{1,10}\/history\/$/,
  /^entry\/\d{1,10}\/transfers\/$/,
  /^entry\/\d{1,10}\/event\/\d{1,2}\/picks\/$/,
];

// Only what the planner uses from the big player list, so the page loads fast.
function trim(boot) {
  return {
    elements: boot.elements.map((e) => ({ id: e.id, code: e.code, web_name: e.web_name, team: e.team, element_type: e.element_type, now_cost: e.now_cost, cost_change_start: e.cost_change_start })),
    teams: boot.teams.map((t) => ({ id: t.id, short_name: t.short_name })),
    chips: (boot.chips || []).map((c) => ({ name: c.name, start_event: c.start_event, stop_event: c.stop_event })),
    events: boot.events.map((e) => ({ id: e.id, deadline_time: e.deadline_time, finished: e.finished, is_current: e.is_current, is_next: e.is_next })),
  };
}

export default {
  async fetch(request, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': SITE, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Only GET', { status: 405, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, '').replace(/^api\//, '');
    if (!ALLOWED.some((r) => r.test(path))) return new Response('Not found', { status: 404, headers: cors });

    const key = new Request(`${url.origin}/api/${path}`);
    let res = await caches.default.match(key);
    if (!res) {
      const up = await fetch(FPL + path, { headers: { 'User-Agent': 'Mozilla/5.0 (FPL xPoints planner)', Accept: 'application/json' } });
      if (!up.ok) {
        return new Response(JSON.stringify({ error: up.status }), { status: up.status === 404 ? 404 : 502, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      let body = await up.json();
      if (path === 'bootstrap-static/') body = trim(body);
      const age = path === 'bootstrap-static/' ? 600 : 60;
      res = new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${age}` } });
      ctx.waitUntil(caches.default.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  },
};
