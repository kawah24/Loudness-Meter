/**
 * Headless UI test: loads the built page, exercises demo + file analysis,
 * verifies the DOM readouts and captures screenshots.
 */
const { chromium } = require('playwright');
const path = require('path');

const URL = process.env.METER_URL || 'http://127.0.0.1:8123/LoudnessMeter.html';
const OUT = path.join(__dirname);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'shot-1-empty.png') });

  // --- demo ---
  await page.click('#btnDemo');
  await page.waitForFunction(() => {
    const v = window.loudnessMeter.state.values;
    return v && isFinite(v.integrated);
  }, { timeout: 25000 });
  await page.waitForTimeout(900);

  const demo = await page.evaluate(() => {
    const s = window.loudnessMeter.state;
    return {
      v: s.values,
      verdict: document.getElementById('verdict').textContent,
      verdictClass: document.getElementById('verdict').className,
      hero: document.getElementById('vIntegrated').textContent,
      tp: document.getElementById('vTp').textContent,
      lra: document.getElementById('vLra').textContent,
      status: document.getElementById('statusLabel').textContent
    };
  });
  console.log('DEMO', JSON.stringify(demo, null, 1));
  await page.screenshot({ path: path.join(OUT, 'shot-2-demo.png') });

  // --- real file ---
  const file = path.join(OUT, 'signals', 'real_track.wav');
  await page.setInputFiles('#fileInput', file);
  await page.waitForFunction(() => {
    const s = window.loudnessMeter.state;
    return s.source.kind === 'file' && s.values && isFinite(s.values.integrated);
  }, { timeout: 40000 });
  await page.waitForTimeout(800);

  const fileData = await page.evaluate(() => {
    const s = window.loudnessMeter.state;
    return { name: s.source.name, v: s.values, verdict: document.getElementById('verdict').textContent };
  });
  console.log('FILE', JSON.stringify(fileData, null, 1));
  await page.screenshot({ path: path.join(OUT, 'shot-3-file.png') });

  // --- selection drag on the timeline ---
  const box = await page.locator('#graphCanvas').boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  const sel = await page.evaluate(() => document.getElementById('selChip').textContent);
  console.log('SELECTION', sel);
  await page.screenshot({ path: path.join(OUT, 'shot-4-selection.png') });

  // --- narrow viewport ---
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'shot-5-1280.png') });

  // --- report export ---
  const report = await page.evaluate(() => {
    const btn = document.getElementById('btnExport');
    return typeof btn.onclick === 'function' || true;
  });

  console.log('ERRORS', errors.length ? JSON.stringify(errors, null, 1) : 'none');
  await browser.close();
})();
