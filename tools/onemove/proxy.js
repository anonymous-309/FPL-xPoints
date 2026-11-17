// A local stand-in for the planner's FPL proxy: /api/* is fetched from the FPL site, with CORS allowed.
require('http').createServer(async (req, res) => {
  try {
    const r = await fetch('https://fantasy.premierleague.com' + req.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    res.writeHead(r.status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end('{}'); }
}).listen(8001);
