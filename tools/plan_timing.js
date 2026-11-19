// Times the planner page on a real team: node tools/plan_timing.js <url> <label>
const { chromium } = require('playwright');
(async () => {
  const [url, label] = process.argv.slice(2);
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.addInitScript(() => localStorage.clear());
  await pg.goto(url); await pg.waitForSelector('#go:not([disabled])', { timeout: 120000 }); await pg.waitForTimeout(2000);
  const t0 = Date.now();
  await pg.click('#go');
  await pg.waitForSelector('.week-view, #error:not([hidden])', { timeout: 1500000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const rows = await pg.$$eval('table tbody tr', (l) => l.slice(0, 12).map((r) => r.innerText.replace(/\s+/g, ' ').slice(0, 110)));
  const verdict = await pg.textContent('.summary').catch(() => '');
  console.log(`RESULT ${label}: ${secs}s, cores ${await pg.evaluate(() => navigator.hardwareConcurrency)}`);
  rows.forEach((r) => console.log(`ROW ${label}: ${r}`));
  console.log(`SUM ${label}: ${verdict.replace(/\s+/g, ' ').slice(0, 200)}`);
  if (errs.length) console.log(`ERR ${label}: ${errs.join(' | ')}`);
  await b.close();
})();
