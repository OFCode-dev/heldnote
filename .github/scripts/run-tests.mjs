import { chromium } from 'playwright';

const url = process.env.TESTS_URL || 'http://127.0.0.1:8080/tests.html';

const browser = await chromium.launch();
const page = await browser.newPage();

page.on('console', (msg) => console.log(`[browser] ${msg.text()}`));
page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));

await page.goto(url);

await page.waitForFunction(() => {
  const el = document.getElementById('results');
  return !!el && /passed/.test(el.textContent) && !/Running/.test(el.textContent);
}, { timeout: 30000 });

const summary = (await page.textContent('#results')).trim();
const firstLine = summary.split('\n')[0];
console.log(firstLine);

const failMatch = firstLine.match(/(\d+)\s+failed/);
const failed = failMatch ? parseInt(failMatch[1], 10) : 1;

await browser.close();

if (failed > 0) {
  console.error(`Test suite reported ${failed} failing test(s). See log above for details.`);
  process.exit(1);
}

console.log('All tests passed.');
