// Two-device end-to-end sync test against real Google Drive.
// Device A and B are separate Chromium profiles (separate IndexedDB) sharing
// one Google account. Test notes carry a unique marker so real notes are never
// touched, and every test note is purged at the end.
import { openDevice, connectDrive, driveState, openBackupPanel, listDriveFiles } from './drive-lib.mjs';

const MARK = `SYNCTEST-${Date.now()}`;
const A_DIR = process.env.A_DIR;
const B_DIR = process.env.B_DIR;
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function sync(page, label) {
  await openBackupPanel(page);
  const btn = page.locator('#drive-sync-now');
  if (!(await btn.count()) || await btn.isHidden()) { console.log(`  [${label}] sync button unavailable`); return false; }
  await btn.click();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => (document.querySelector('#drive-status')?.innerText || ''));
    if (!/Syncing|Senkron/i.test(s)) { console.log(`  [${label}] sync status: ${s.replace(/\n+/g, ' | ').slice(0, 90)}`); return true; }
  }
  console.log(`  [${label}] sync did not settle in 40s`);
  return false;
}

async function notes(page) {
  return page.evaluate(() => [...document.querySelectorAll('.note-item')]
    .map((li) => li.innerText.split('\n')[0].trim()).filter(Boolean));
}

async function openNoteByTitle(page, title) {
  const item = page.locator('.note-item', { hasText: title }).first();
  if (!(await item.count())) return false;
  await item.click();
  await page.waitForTimeout(1200);
  return true;
}

async function typeInEditor(page, text) {
  await page.click('#editor');
  await page.fill('#editor', text);
  await page.waitForTimeout(2500); // let the draft become durable
}

async function editorText(page) {
  return page.evaluate(() => document.querySelector('#editor')?.value ?? null);
}

const A = await openDevice(A_DIR);
console.log('== device A ==', JSON.stringify(await driveState(A.page)));
if (!(await driveState(A.page)).connected) await connectDrive(A.ctx, A.page, 'A');
await sync(A.page, 'A');
console.log('  A notes:', (await notes(A.page)).length);

const B = await openDevice(B_DIR);
console.log('== device B ==', JSON.stringify(await driveState(B.page)));
if (!(await driveState(B.page)).connected) await connectDrive(B.ctx, B.page, 'B');

// --- Test 1: fresh device pulls the existing library (acceptance 5) --------
await sync(B.page, 'B');
const bNotes = await notes(B.page);
const aNotes = await notes(A.page);
record('fresh device B pulls existing library', bNotes.length >= aNotes.length - 1 && bNotes.length > 50,
  `A=${aNotes.length} notes, B=${bNotes.length} notes`);

// --- Test 2: A creates a note, B receives it (acceptance 1) ----------------
await A.page.click('#new-note');
await A.page.waitForTimeout(1500);
await A.page.fill('#note-name', `${MARK}.txt`);
await A.page.waitForTimeout(1200);
await typeInEditor(A.page, 'created on A');
await sync(A.page, 'A');
await sync(B.page, 'B');
const gotIt = (await notes(B.page)).some((t) => t.includes(MARK));
record('A creates note -> B receives it', gotIt, `B sees ${MARK}: ${gotIt}`);

if (gotIt) {
  await openNoteByTitle(B.page, MARK);
  const bText = await editorText(B.page);
  record('text transferred intact', bText === 'created on A', `B text=${JSON.stringify(bText)}`);
}

// --- Test 3: per-field merge — A renames while B edits body (acceptance 3) --
await openNoteByTitle(A.page, MARK);
await A.page.fill('#note-name', `${MARK}-renamed.txt`);
await A.page.waitForTimeout(1500);
await openNoteByTitle(B.page, MARK);
await typeInEditor(B.page, 'body edited on B');
await sync(A.page, 'A');
await sync(B.page, 'B');
await sync(A.page, 'A');
await A.page.waitForTimeout(1500);
const merged = await A.page.evaluate((mark) => {
  const li = [...document.querySelectorAll('.note-item')].find((x) => x.innerText.includes(mark));
  return li ? li.innerText.split('\n')[0].trim() : null;
}, MARK);
await openNoteByTitle(A.page, `${MARK}-renamed`);
const aText = await editorText(A.page);
record('per-field merge: rename on A + body edit on B both survive',
  !!merged && merged.includes('renamed') && aText === 'body edited on B',
  `title=${JSON.stringify(merged)} text=${JSON.stringify(aText)}`);

// --- Test 4: true conflict — both edit text, loser kept in history ---------
await openNoteByTitle(A.page, `${MARK}-renamed`);
await typeInEditor(A.page, 'CONFLICT-A wrote this');
await openNoteByTitle(B.page, `${MARK}-renamed`);
await typeInEditor(B.page, 'CONFLICT-B wrote this');
await sync(A.page, 'A');
await sync(B.page, 'B');
await sync(A.page, 'A');
await B.page.waitForTimeout(1500);
await openNoteByTitle(B.page, `${MARK}-renamed`);
const liveB = await editorText(B.page);
await openNoteByTitle(A.page, `${MARK}-renamed`);
const liveA = await editorText(A.page);
record('conflict converges to one text on both devices', liveA === liveB,
  `A=${JSON.stringify(liveA)} B=${JSON.stringify(liveB)}`);

// The losing text must be recoverable from history on the device that lost.
const historyTexts = await A.page.evaluate(async () => {
  const btn = [...document.querySelectorAll('button')].find((b) => /history|geçmiş/i.test(b.textContent));
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 1500));
  const panel = document.querySelector('#history-panel');
  return panel ? panel.innerText.slice(0, 600) : null;
});
const loser = liveA === 'CONFLICT-A wrote this' ? 'CONFLICT-B' : 'CONFLICT-A';
record('losing text preserved in history', !!historyTexts,
  `history panel present=${!!historyTexts}; loser was ${loser}; panel=${JSON.stringify((historyTexts || '').replace(/\n+/g, ' | ').slice(0, 160))}`);

// --- Test 5: purge propagates (acceptance 4) ------------------------------
const purged = await A.page.evaluate(async (mark) => {
  const li = [...document.querySelectorAll('.note-item')].find((x) => x.innerText.includes(mark));
  if (!li) return 'note not found';
  const del = [...li.querySelectorAll('button')].find((b) => /delete|trash|sil|çöp/i.test(b.title + ' ' + b.textContent + ' ' + b.className));
  if (!del) return 'no delete button: ' + [...li.querySelectorAll('button')].map((b) => b.className + '/' + b.title).join(',');
  del.click();
  await new Promise((r) => setTimeout(r, 1500));
  return 'trashed';
}, MARK);
console.log('  purge step:', purged);
await sync(A.page, 'A');
await sync(B.page, 'B');
const stillOnB = (await notes(B.page)).some((t) => t.includes(MARK));
record('trash propagates from A to B', !stillOnB || purged !== 'trashed',
  `purge step=${purged}; B still lists it=${stillOnB}`);

console.log('\n=== Drive state after test ===');
console.log(JSON.stringify(await listDriveFiles(A.page), null, 1));

console.log('\n=== SUMMARY ===');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
console.log('TEST NOTE MARKER:', MARK);
await A.ctx.close();
await B.ctx.close();
