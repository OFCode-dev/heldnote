// Development-only Playwright check. No package is loaded by the product.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.svg':'image/svg+xml', '.png':'image/png' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    let file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('outside root');
    if (path.endsWith('/')) file = resolve(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const context = await browser.newContext({ acceptDownloads: true });
  const external = [];
  await context.route('**/*', route => {
    if (!route.request().url().startsWith(base + '/')) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  // Disposable browser context and explicit test DB: no user profile or real account.
  const keeper = await context.newPage();
  await keeper.goto(base + '/preview/premium/');
  const before = await keeper.evaluate(async () => {
    const s = await import('/store.js');
    await s.open({ dbName: 'heldnote-test-preview-browser-isolation' });
    const n = await s.createNote();
    const rev = s.saveDraft(n.id, 'Untouched recovery 📝\r\n\tTürkçe e\u0301\n\n');
    await s.flush(n.id, rev); await s.commitVersion(n.id);
    const data = JSON.parse(await (await s.exportAll()).text());
    await s.close();
    localStorage.setItem('heldnote-test-preview-sentinel', 'unchanged');
    return { notes: data.notes, versions: data.versions };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.storageAttempts = [];
    for (const key of ['indexedDB', 'localStorage', 'sessionStorage']) {
      Object.defineProperty(window, key, { configurable: true, get() { window.storageAttempts.push(key); throw new Error('Storage denied for preview check'); } });
    }
    window.fetch = () => { throw new Error('No preview service requests allowed'); };
  });
  await page.goto(base + '/preview/premium/');
  await page.getByRole('status').filter({ hasText: 'Sample workspace ready' }).waitFor();
  const draft = 'My sample draft — Türkçe 📝\n  keep spacing\t\n\n';
  await page.locator('#note-text').fill(draft);
  await page.getByRole('button', { name: 'Everyday work · 1', exact: true }).click();
  await page.locator('#delete-collection').click();
  assert.equal(await page.locator('.note-card').count(), 3);
  assert.equal(await page.locator('#note-text').inputValue(), draft);
  await page.locator('#template-details summary').click();
  await page.locator('#template-name').fill('Personal routine');
  await page.locator('#template-text').fill('Start here\n\nNext step\n');
  await page.getByRole('button', { name: 'Add template', exact: true }).click();
  await page.getByRole('button', { name: 'Create new note from Personal routine', exact: true }).click();
  assert.equal(await page.locator('.note-card').count(), 4);
  assert.equal(await page.locator('#note-title').inputValue(), 'Personal routine');
  await page.getByRole('button', { name: /^A little room to begin/ }).click();
  assert.equal(await page.locator('#note-text').inputValue(), draft);
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-preview').click();
  const download = await downloaded;
  const previewSource = await readFile(await download.path(), 'utf8');
  const preview = JSON.parse(previewSource);
  assert.equal(preview.format, 'heldnote-premium-preview');
  assert.equal(preview.notes.find(n => n.id === 'sample-welcome').text, draft);
  await page.locator('#import-file').setInputFiles({ name: 'real-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, notes: [], versions: [] })) });
  await page.getByRole('status').filter({ hasText: 'Only Heldnote Premium preview files' }).waitFor();
  assert.equal(await page.locator('#note-text').inputValue(), draft);
  await page.locator('#note-text').fill(draft + 'After export');
  const importFixture = () => page.locator('#import-file').setInputFiles({ name: 'preview.json', mimeType: 'application/json', buffer: Buffer.from(previewSource) });
  await importFixture();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('#note-text').inputValue(), draft + 'After export');
  await importFixture();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#note-text').inputValue(), draft + 'After export');
  await importFixture();
  await page.locator('#confirm-action').click();
  await page.getByRole('status').filter({ hasText: 'Preview imported' }).waitFor();
  assert.equal(await page.locator('#note-text').inputValue(), draft);
  await page.locator('#collection-name').fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Add collection', exact: true }).click();
  assert.equal(await page.locator('#collection-list img').count(), 0, 'names must render as text');
  await page.getByRole('button', { name: /^All notes/ }).click();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}`);
  }
  assert.deepEqual(await page.evaluate(() => window.storageAttempts), [], 'preview must never try to access storage');
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'Sample workspace ready' }).waitFor();
  assert.equal(await page.locator('.note-card').count(), 3, 'new load starts with fixtures');
  await page.locator('#collection-name').fill('Keyboard example');
  await page.locator('#collection-name').press('Enter');
  assert.equal(await page.locator('#new-note').evaluate(el => el === document.activeElement), true);
  await page.locator('#new-note').press('Enter');
  await page.locator('#note-title').fill('   ');
  await page.locator('#note-text').fill(draft);
  await page.getByRole('button', { name: /^All notes/ }).click();
  await page.getByRole('button', { name: /^A little room to begin/ }).click();
  await page.getByRole('button', { name: /^Untitled sample/ }).click();
  assert.equal(await page.locator('#note-text').inputValue(), draft, 'a blank title must not prevent sample draft updates');
  await page.reload();
  await page.getByRole('status').filter({ hasText: 'Sample workspace ready' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir(resolve(root, 'logs/premium-preview'), { recursive: true });
  await page.screenshot({ path: resolve(root, 'logs/premium-preview/desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(root, 'logs/premium-preview/mobile.png'), fullPage: true });
  assert.deepEqual(await page.evaluate(() => window.storageAttempts), []);
  const after = await keeper.evaluate(async () => {
    const s = await import('/store.js');
    await s.open({ dbName: 'heldnote-test-preview-browser-isolation' });
    const data = JSON.parse(await (await s.exportAll()).text()); await s.close();
    return { notes: data.notes, versions: data.versions, sentinel: localStorage.getItem('heldnote-test-preview-sentinel') };
  });
  assert.deepEqual({ notes: after.notes, versions: after.versions }, before);
  assert.equal(after.sentinel, 'unchanged');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJs.newPage();
  await staticPage.goto(base + '/preview/premium/');
  assert.equal(await staticPage.locator('#export-preview').isDisabled(), true);
  assert.match(await staticPage.locator('noscript').textContent(), /JavaScript is needed/);
  console.log('premium-preview-browser: OK (storage denied, collection retention, template non-overwrite, import/export, cancel/Escape, keyboard, blank title draft, text rendering, reload, note/history isolation, 5 widths, JS-off, no remote requests)');
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
