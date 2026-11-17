// Run the site's planner for a team, with and without the FT bonus trial, and print each result.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const flag of ['&ftbonus=1']) {
    const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    await p.goto(`http://localhost:8000/planner.html?id=${process.argv[2]}&proxy=http://localhost:8001${flag}`);
    await p.waitForFunction(() => /Choose the gameweeks/.test(document.querySelector('#out')?.innerText || '') || document.querySelector('#error:not([hidden])'), null, { timeout: 120000 });
    await p.click('#go');
    await p.waitForFunction(() => /Best plan:/.test(document.querySelector('#out')?.innerText || '') || document.querySelector('#error:not([hidden])'), null, { timeout: 900000 });
    console.log(`===== ${flag ? 'FT BONUS' : 'CURRENT'} =====`);
    console.log((await p.innerText('#status')));
    const err = await p.$('#error:not([hidden])'); if (err) console.log('ERROR', await err.innerText());
    console.log((await p.innerText('#out')).slice(0, 9000));
    await p.close();
  }
  await b.close();
})();
