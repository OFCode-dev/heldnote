const { chromium } = await import('playwright-core');
const dir = process.argv[2];
const ctx = await chromium.launchPersistentContext(dir, {
  executablePath: '/usr/bin/chromium-browser',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--password-store=basic', '--profile-directory=Default'],
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || await ctx.newPage();

// Does the context even see the stored cookies?
const cookies = await ctx.cookies('https://accounts.google.com');
const names = cookies.map(c => c.name);
console.log('cookies visible to context:', cookies.length);
console.log('has SID/SAPISID/LSID:', names.includes('SID'), names.includes('SAPISID'), names.includes('LSID'));

await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(4000);
console.log('accounts url:', page.url());
console.log('accounts text:', (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\n+/g, ' | '));

// Authoritative check: the Drive API answers only for a live session.
const who = await page.evaluate(async () => {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', { credentials: 'include' });
    return r.status;
  } catch (e) { return 'err ' + e.message; }
});
console.log('userinfo status (401 expected without token):', who);
await ctx.close();
