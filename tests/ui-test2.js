/** Exercises export, window modes, help modal and reset. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://127.0.0.1:8123/LoudnessMeter.html#demo');
  await page.waitForFunction(() => {
    const s = window.loudnessMeter.state;
    return s.values && isFinite(s.values.integrated);
  }, { timeout: 30000 });
  await page.waitForTimeout(600);

  // 10 s window
  await page.click('.win-btn[data-win="10"]');
  await page.waitForTimeout(400);
  const view = await page.evaluate(() => window.loudnessMeter.state.view);
  console.log('WINDOW', JSON.stringify(view));
  await page.screenshot({ path: path.join(__dirname, 'shot-6-window.png') });

  // help modal
  await page.click('#btnHelp');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(__dirname, 'shot-7-help.png') });
  await page.keyboard.press('Escape');

  // export
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#btnExport')
  ]);
  const out = path.join(__dirname, 'export-sample.txt');
  await download.saveAs(out);
  console.log('DOWNLOAD', download.suggestedFilename(), fs.statSync(out).size, 'bytes');
  console.log(fs.readFileSync(out, 'utf8').split('\n').slice(0, 16).join('\n'));

  // reset re-measures
  await page.click('.win-btn[data-win="0"]');
  await page.keyboard.press('r');
  await page.waitForTimeout(2500);
  const afterReset = await page.evaluate(() => window.loudnessMeter.state.values.integrated);
  console.log('AFTER RESET IL', afterReset.toFixed(2));

  console.log('ERRORS', errors.length ? JSON.stringify(errors) : 'none');
  await browser.close();
})();
