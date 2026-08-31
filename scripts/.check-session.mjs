// Verifies the copied profile still carries a live Google session.
const { chromium } = await import('playwright-core');
const dir = process.argv[2];
const ctx = await chromium.launchPersistentContext(dir, {
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--password-store=basic'],
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://myaccount.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);
const url = page.url();
const body = await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\n+/g, ' | '));
console.log('final url:', url);
console.log('signed in:', !url.includes('accounts.google.com/ServiceLogin') && !url.includes('/signin'));
console.log('body:', body);
await ctx.close();
