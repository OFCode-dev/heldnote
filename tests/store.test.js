import { test, assert, assertEquals, withTimeout } from './test-harness.js';
import * as store from '../store.js';
import { setFaultInjection, clearFaultInjection } from '../db.js';
import { LIMITS } from '../constants.js';

test('open() resolves available:true against a fresh database', async () => {
  const status = await store.open({ dbName: `heldnote-test-${Date.now()}` });
  assert(status.available === true, 'expected available:true');
  assert(status.schemaVersion === 1, 'expected schemaVersion 1');
  await store.close();
});

test('subscribe/unsubscribe: a handler stops receiving events after unsubscribe', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const events = [];
  const unsubscribe = store.subscribe((e) => events.push(e));
  unsubscribe();
  store.__emitForTests({ type: 'saved', noteId: 'x' });
  assertEquals(events.length, 0, 'handler should not have been called after unsubscribe');
  await store.close();
});

test('createNote, listNotes, setPinned, trashNote, restoreNote, purgeNote round-trip', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });

  const note = await store.createNote();
  assert(typeof note.id === 'string' && note.id.length > 0, 'expected a generated id');
  assertEquals(note.title, 'Untitled');
  assertEquals(note.pinned, false);
  assertEquals(note.deletedAt, null);

  let list = await store.listNotes({});
  assertEquals(list.length, 1);
  assertEquals(list[0].id, note.id);

  await store.setPinned(note.id, true);
  list = await store.listNotes({});
  assertEquals(list[0].pinned, true);

  await store.trashNote(note.id);
  list = await store.listNotes({});
  assertEquals(list.length, 0, 'trashed note must not appear in the default list');
  list = await store.listNotes({ includeTrashed: true });
  assertEquals(list.length, 1);
  assert(typeof list[0].deletedAt === 'number', 'expected deletedAt to be set as a number');

  await store.restoreNote(note.id);
  list = await store.listNotes({});
  assertEquals(list.length, 1);
  assertEquals(list[0].deletedAt, null);

  await store.trashNote(note.id);
  await store.purgeNote(note.id);
  list = await store.listNotes({ includeTrashed: true });
  assertEquals(list.length, 0, 'purged note must be gone even from the trashed view');

  await store.close();
});

test('listNotes query matches title OR body text, case-insensitively, and still excludes trashed notes by default', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });

  // Title carries the query; body does not.
  const titleMatch = await store.createNote();
  let rev = store.saveDraft(titleMatch.id, 'Zephyr notes\nsome body text');
  await store.flush(titleMatch.id, rev);

  // Body carries the query; title (first line) does not.
  const bodyMatch = await store.createNote();
  rev = store.saveDraft(bodyMatch.id, 'Grocery list\nremember to buy a ZEPHYR fan');
  await store.flush(bodyMatch.id, rev);

  // Neither title nor body carries the query.
  const noMatch = await store.createNote();
  rev = store.saveDraft(noMatch.id, 'Unrelated\nnothing interesting here');
  await store.flush(noMatch.id, rev);

  const results = await store.listNotes({ query: 'zephyr' });
  const ids = results.map((n) => n.id).sort();
  assertEquals(ids.length, 2, 'expected both the title-match and body-match notes, but not the non-match');
  assertEquals(JSON.stringify(ids), JSON.stringify([titleMatch.id, bodyMatch.id].sort()));

  // A trashed note whose body matches must still be excluded by default —
  // the search-scope widening must not interact with the trashed filter.
  await store.trashNote(bodyMatch.id);
  const afterTrash = await store.listNotes({ query: 'zephyr' });
  assertEquals(afterTrash.length, 1);
  assertEquals(afterTrash[0].id, titleMatch.id);

  const includeTrashedResults = await store.listNotes({ query: 'zephyr', includeTrashed: true });
  assertEquals(includeTrashedResults.length, 2, 'includeTrashed should still surface the trashed body-match note');

  await store.close();
});

test('a note whose text is entirely empty is titled Untitled and still appears in the list', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();
  const list = await store.listNotes({});
  assertEquals(list.length, 1);
  assertEquals(list[0].title, 'Untitled');
  await store.close();
});

test('saveDraft returns synchronously and increments localRev per note', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const rev1 = store.saveDraft(note.id, 'hello');
  const rev2 = store.saveDraft(note.id, 'hello world');
  assert(rev2 > rev1, 'expected localRev to increase on each saveDraft call');

  const receipt = await store.flush(note.id, rev2);
  assertEquals(receipt.durableRev, rev2);
  assert(!receipt.error, 'expected no error on a normal flush');

  const reloaded = await store.getNote(note.id);
  assertEquals(reloaded.text, 'hello world');
  assertEquals(reloaded.localRev, rev2);

  await store.close();
});

test('coalescing: rapid saveDraft calls collapse into one transaction carrying the latest text', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  let lastRev;
  for (let i = 0; i < 20; i += 1) {
    lastRev = store.saveDraft(note.id, `text-${i}`);
  }
  const receipt = await store.flush(note.id, lastRev);
  assertEquals(receipt.durableRev, lastRev);

  const reloaded = await store.getNote(note.id);
  assertEquals(reloaded.text, 'text-19');

  await store.close();
});

test('revision 10 completing while revision 11 is on screen: flush(id, 10) still resolves correctly after 11 is queued', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const rev10 = store.saveDraft(note.id, 'state-10');
  const flush10 = store.flush(note.id, rev10);
  const rev11 = store.saveDraft(note.id, 'state-11');

  const receipt10 = await flush10;
  assert(receipt10.durableRev >= rev10, 'flush for rev10 must resolve once rev10 (or newer) is durable');

  const receipt11 = await store.flush(note.id, rev11);
  assertEquals(receipt11.durableRev, rev11);

  await store.close();
});

test('no accepted revision waits more than 300ms from input to transaction completion', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const start = Date.now();
  const rev = store.saveDraft(note.id, 'timed');
  const receipt = await store.flush(note.id, rev);
  const elapsed = receipt.completedAt - start;
  assert(elapsed <= 300, `expected completion within 300ms, took ${elapsed}ms`);

  await store.close();
});

test('commitVersion snapshots current text and returns null when unchanged', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'v1 text');
  await store.flush(note.id, rev);

  const info = await store.commitVersion(note.id);
  assert(info !== null, 'expected a VersionInfo for changed text');
  assertEquals(info.seq, 1);
  assertEquals(info.sourceRev, rev);

  const again = await store.commitVersion(note.id);
  assertEquals(again, null, 'expected null when text has not changed since the last version');

  await store.close();
});

test('listVersions pages backwards newest-first without returning text', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  for (let i = 0; i < 3; i += 1) {
    const rev = store.saveDraft(note.id, `text-${i}`);
    await store.flush(note.id, rev);
    await store.commitVersion(note.id);
  }

  const list = await store.listVersions(note.id, {});
  assertEquals(list.length, 3);
  assert(list[0].seq > list[1].seq && list[1].seq > list[2].seq, 'expected newest-first ordering');
  assert(list.every((v) => v.text === undefined), 'VersionInfo must not carry text');

  const full = await store.getVersion(note.id, list[2].seq);
  assertEquals(full.text, 'text-0');

  await store.close();
});

test('restore while an uncommitted draft exists preserves that draft as a pre-restore checkpoint', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const rev1 = store.saveDraft(note.id, 'version one');
  await store.flush(note.id, rev1);
  const v1 = await store.commitVersion(note.id);

  const rev2 = store.saveDraft(note.id, 'unversioned edit');
  await store.flush(note.id, rev2);

  await store.restoreVersion(note.id, v1.seq);

  const reloaded = await store.getNote(note.id);
  assertEquals(reloaded.text, 'version one', 'restore must apply the selected version text');

  const versions = await store.listVersions(note.id, {});
  const texts = await Promise.all(versions.map((v) => store.getVersion(note.id, v.seq)));
  assert(texts.some((v) => v.text === 'unversioned edit'), 'the unversioned edit must survive as a checkpoint version');

  await store.close();
});

test('a stale draft callback completing after a restore does not overwrite the restored text', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const rev1 = store.saveDraft(note.id, 'base');
  await store.flush(note.id, rev1);
  const v1 = await store.commitVersion(note.id);

  const rev2 = store.saveDraft(note.id, 'changed before restore');
  // Deliberately do not flush rev2 before restoring — it is "in flight".
  await store.restoreVersion(note.id, v1.seq);

  await store.flush(note.id, rev2).catch(() => {});

  const reloaded = await store.getNote(note.id);
  assertEquals(reloaded.text, 'base', 'the restore must win over a stale in-flight draft write');

  await store.close();
});

test('restoring is itself committed as a new version and never deletes an existing version', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const rev1 = store.saveDraft(note.id, 'first');
  await store.flush(note.id, rev1);
  const v1 = await store.commitVersion(note.id);

  const rev2 = store.saveDraft(note.id, 'second');
  await store.flush(note.id, rev2);
  const v2 = await store.commitVersion(note.id);

  const before = await store.listVersions(note.id, {});
  await store.restoreVersion(note.id, v1.seq);
  const after = await store.listVersions(note.id, {});

  assert(after.length > before.length, 'restore must add at least one new version, never remove one');
  assert(after.some((v) => v.seq === v1.seq) && after.some((v) => v.seq === v2.seq), 'no existing version may be deleted by a restore');

  await store.close();
});

test('runMaintenance never removes the newest version, anything from the last 24h, or anything in the newest-50 window', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  for (let i = 0; i < 60; i += 1) {
    const rev = store.saveDraft(note.id, `text-${i}`);
    await store.flush(note.id, rev);
    await store.commitVersion(note.id);
  }

  const before = await store.listVersions(note.id, {});
  const result = await store.runMaintenance();
  const after = await store.listVersions(note.id, {});

  assertEquals(after.length, before.length, 'nothing should be pruned when everything is within 24h');
  assertEquals(result.purged, 0, 'v1 has no automatic trash purge');

  await store.close();
});

test('runMaintenance is idempotent: a second call changes nothing already pruned', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  await store.createNote();

  await store.runMaintenance();
  const second = await store.runMaintenance();
  assertEquals(second.pruned, 0, 'a second run with nothing new to prune must prune nothing');

  await store.close();
});

// --- Task 10 Part B: commitVersion needs restoreVersion's mutual exclusion -
//
// commitVersion and restoreVersion share the same vulnerable shape: allocate
// a seq via nextSeq() (a separate, earlier readonly transaction), then write
// the version record in a separate, later transaction. Two such operations
// racing on the same note can compute the same seq and one write silently
// clobbers the other's version record. Both now guard their seq-allocation-
// and-write with the same q.restoring flag restoreVersion already used.

test('commitVersion is safe against a concurrent commitVersion racing on the same note', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const rev1 = store.saveDraft(note.id, 'v1 text');
  await store.flush(note.id, rev1);
  await store.commitVersion(note.id);

  const rev2 = store.saveDraft(note.id, 'v2 text');
  await store.flush(note.id, rev2);

  const [a, b] = await Promise.all([store.commitVersion(note.id), store.commitVersion(note.id)]);
  const winners = [a, b].filter((r) => r !== null);
  assertEquals(winners.length, 1, 'exactly one concurrent commitVersion should write a version; the other must skip (null)');

  const versions = await store.listVersions(note.id, {});
  const seqs = versions.map((v) => v.seq);
  assertEquals(new Set(seqs).size, seqs.length, 'no two versions may share a seq');
  assertEquals(versions.length, 2, 'expected exactly 2 versions: the initial commit and the winning race commit');

  await store.close();
});

test('commitVersion returns null (does not race) while a restoreVersion write is in flight on the same note', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const rev1 = store.saveDraft(note.id, 'base');
  await store.flush(note.id, rev1);
  const v1 = await store.commitVersion(note.id);

  const rev2 = store.saveDraft(note.id, 'changed');
  await store.flush(note.id, rev2);

  let duringRestore;
  setFaultInjection({ delayCompleteMs: 60 });
  try {
    const restorePromise = store.restoreVersion(note.id, v1.seq);
    // restoreVersion sets q.restoring synchronously (well before its delayed
    // write transaction completes), so this is comfortably inside the
    // window where the write is durably "in flight but not yet committed".
    await new Promise((resolve) => setTimeout(resolve, 20));
    duringRestore = await store.commitVersion(note.id);
    await restorePromise;
  } finally {
    clearFaultInjection();
  }

  assertEquals(duringRestore, null, 'commitVersion must skip while a restore holds the lock, not race its seq allocation and write');

  const versions = await store.listVersions(note.id, {});
  const seqs = versions.map((v) => v.seq);
  assertEquals(new Set(seqs).size, seqs.length, 'no two versions may share a seq');

  await store.close();
});

// --- Task 11: quota exhaustion handling -------------------------------------
//
// setFaultInjection({ quotaOnStore }) aborts every transaction touching that
// store (db.js), which surfaces as an AbortError — isQuotaError() treats that
// the same as QuotaExceededError. The fault stays active until
// clearFaultInjection() is called, so the prune-and-retry's single retry also
// fails, which is what drives both paths to their final, non-retrying state.

test('a version commit that fails on quota prunes, retries once, then stops committing history', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'v1');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  const events = [];
  store.subscribe((e) => events.push(e));

  setFaultInjection({ quotaOnStore: 'versions' });
  store.saveDraft(note.id, 'v2');
  const result = await store.commitVersion(note.id);
  clearFaultInjection();

  assertEquals(result, null, 'a version commit that cannot be persisted after retry must not report a fake success');
  assert(events.some((e) => e.type === 'quota-warning'), 'expected a quota-warning event once history commits stop');

  await store.close();
});

test('a draft write that fails on quota after pruning and retry enters memory-only, keeping the visible buffer', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const events = [];
  store.subscribe((e) => events.push(e));

  setFaultInjection({ quotaOnStore: 'drafts' });
  const rev = store.saveDraft(note.id, 'will not persist');
  await store.flush(note.id, rev).catch(() => {});
  clearFaultInjection();

  assert(events.some((e) => e.type === 'memory-only'), 'expected a memory-only event');
  assertEquals(store.getMemoryOnlyText(note.id), 'will not persist', 'the visible buffer must be retained for emergency export');

  await store.close();
});

// --- Task 12: multi-tab locking (Web Locks) ---------------------------------

test('acquireNoteLock: a second acquire on the same note is not granted while the first is held', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const first = await store.acquireNoteLock(note.id);
  assert(first.granted, 'expected the first acquire to succeed');

  const second = await store.acquireNoteLock(note.id);
  assertEquals(second.granted, false);
  assert(typeof second.heldBy === 'string', 'expected to learn which holder has the lock');

  await store.releaseNoteLock(note.id);
  const third = await store.acquireNoteLock(note.id);
  assert(third.granted, 'expected the lock to be acquirable again after release');

  await store.close();
});

test("two different notes do not contend for each other's lock", async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const noteA = await store.createNote();
  const noteB = await store.createNote();

  const a = await store.acquireNoteLock(noteA.id);
  const b = await store.acquireNoteLock(noteB.id);
  assert(a.granted && b.granted, 'expected independent notes to lock independently');

  await store.releaseNoteLock(noteA.id);
  await store.releaseNoteLock(noteB.id);
  await store.close();
});

// --- Task 13: backup (export/import) ----------------------------------------

test('export immediately after typing flushes first, so the export reflects the latest text', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();
  store.saveDraft(note.id, 'just typed');

  const blob = await store.exportAll();
  const parsed = JSON.parse(await blob.text());
  const exportedNote = parsed.notes.find((n) => n.id === note.id);
  assertEquals(exportedNote.text, 'just typed');

  await store.close();
});

test('an export followed by a wipe and an import (replace) returns the app to its previous state', async () => {
  const dbName = `heldnote-test-${Date.now()}`;
  await store.open({ dbName });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'keep me');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  const blob = await store.exportAll();
  await store.close();
  indexedDB.deleteDatabase(dbName);

  await store.open({ dbName });
  const file = new File([blob], 'backup.json', { type: 'application/json' });
  const result = await store.importAll(file, { mode: 'replace' });
  assertEquals(result.notesAdded, 1);

  const list = await store.listNotes({});
  assertEquals(list.length, 1);
  const restored = await store.getNote(list[0].id);
  assertEquals(restored.text, 'keep me');

  await store.close();
});

test('import as copies assigns fresh note IDs and keeps the original notes', async () => {
  const dbName = `heldnote-test-${Date.now()}`;
  await store.open({ dbName });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'original');
  await store.flush(note.id, rev);

  const blob = await store.exportAll();
  const file = new File([blob], 'backup.json', { type: 'application/json' });
  const result = await store.importAll(file, { mode: 'copy' });
  assertEquals(result.notesCopied, 1);

  const list = await store.listNotes({});
  assertEquals(list.length, 2, 'expected the original plus one copy');
  assert(list.some((n) => n.id === note.id), 'the original note must remain');

  await store.close();
});

test('merge import of an own backup is a no-op: ids reconcile, nothing duplicates', async () => {
  const dbName = `heldnote-test-${Date.now()}`;
  await store.open({ dbName });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'merge me');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  const blob = await store.exportAll();
  const file = new File([blob], 'backup.json', { type: 'application/json' });

  // Restoring your own backup twice must never multiply notes — this is the
  // exact scenario that duplicated a real user's library under 'copy'.
  for (let i = 0; i < 2; i++) {
    const result = await store.importAll(file, { mode: 'merge' });
    assertEquals(result.notesAdded, 0, 'an already-present note id must not be re-added');
    assertEquals(result.versionsAdded, 0, 'an already-present [noteId, seq] must not be re-added');
  }

  const list = await store.listNotes({});
  assertEquals(list.length, 1, 'merge must never duplicate an existing note');

  await store.close();
});

test('merge import adds missing notes and missing version snapshots, and never touches local edits', async () => {
  const dbName = `heldnote-test-${Date.now()}`;
  await store.open({ dbName });
  const keeper = await store.createNote();
  const keeperRev = store.saveDraft(keeper.id, 'shared note');
  await store.flush(keeper.id, keeperRev);
  await store.commitVersion(keeper.id);
  const missing = await store.createNote();
  const missingRev = store.saveDraft(missing.id, 'only in the backup');
  await store.flush(missing.id, missingRev);
  await store.commitVersion(missing.id);

  const blob = await store.exportAll();
  const file = new File([blob], 'backup.json', { type: 'application/json' });

  // Simulate divergence after the backup: one note is purged locally (exists
  // only in the backup), the shared note gains a newer local edit.
  await store.trashNote(missing.id);
  await store.purgeNote(missing.id);
  const newerRev = store.saveDraft(keeper.id, 'shared note, edited after the backup');
  await store.flush(keeper.id, newerRev);

  const result = await store.importAll(file, { mode: 'merge' });
  assertEquals(result.notesAdded, 1, 'the note missing locally must come back under its own id');
  assertEquals(result.notesCopied, 0);

  const list = await store.listNotes({});
  assertEquals(list.length, 2);
  assert(list.some((n) => n.id === missing.id), 'the restored note keeps its original id');
  const kept = await store.getNote(keeper.id);
  assertEquals(kept.text, 'shared note, edited after the backup', 'merge must never overwrite a local edit');
  const restored = await store.getNote(missing.id);
  assertEquals(restored.text, 'only in the backup');

  await store.close();
});

test('memory mode: merge import reconciles by id without duplicating', async () => {
  await openInMemoryMode();
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'memory merge');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  const blob = await store.exportAll();
  const payload = JSON.parse(await blob.text());
  const result = await store.importAll(new File([JSON.stringify(payload)], 'backup.json'), { mode: 'merge' });
  assertEquals(result.notesAdded, 0);
  assertEquals(result.versionsAdded, 0);
  const list = await store.listNotes({});
  assertEquals(list.length, 1, 'memory merge must not duplicate either');

  await store.close();
});

test('importing a file that is not valid JSON fails with invalid-import and changes nothing', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const before = await store.listNotes({});

  const file = new File(['not json'], 'bad.json', { type: 'application/json' });
  let code;
  await store.importAll(file, { mode: 'replace' }).catch((e) => { code = e.code; });
  assertEquals(code, 'invalid-import');

  const after = await store.listNotes({});
  assertEquals(after.length, before.length);

  await store.close();
});

// --- nextSeq must order by seq, not by `at` ---------------------------------
//
// The versions store is keyed [noteId, seq], so a reused seq is not a duplicate
// — it is a put() that OVERWRITES an existing version record. nextSeq()
// therefore has to derive the next seq from the seq order itself. Deriving it
// from the by_note_at index instead only works while Date.now() is monotonic
// for the note; both tests below break that assumption in a way a real user
// can reach, and each one reuses a seq (and destroys a version) if nextSeq()
// walks the index.

test('a clock rollback between version commits still yields fresh seqs, never a reused one', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  let rev = store.saveDraft(note.id, 'a');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  // An NTP correction (or a manual clock change) moves the wall clock an hour
  // backwards, so the next two commits carry an `at` older than version 1's.
  const realNow = Date.now;
  try {
    Date.now = () => realNow.call(Date) - 60 * 60 * 1000;
    rev = store.saveDraft(note.id, 'b');
    await store.flush(note.id, rev);
    await store.commitVersion(note.id);
    rev = store.saveDraft(note.id, 'c');
    await store.flush(note.id, rev);
    await store.commitVersion(note.id);
  } finally {
    Date.now = realNow;
  }

  const versions = await store.listVersions(note.id, {});
  const seqs = versions.map((v) => v.seq);
  assertEquals(new Set(seqs).size, seqs.length, 'no two versions may share a seq across a clock rollback');
  assertEquals(versions.length, 3, 'all three commits must survive; a reused seq would have overwritten one');

  const texts = (await Promise.all(versions.map((v) => store.getVersion(note.id, v.seq)))).map((v) => v.text).sort();
  assertEquals(JSON.stringify(texts), JSON.stringify(['a', 'b', 'c']), 'no version record may be overwritten by a rolled-back clock');

  await store.close();
});

test('after importing a backup whose newest version is dated in the future, local commits still get fresh seqs', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });

  // Built as JSON rather than by exporting, so the future `at` does not depend
  // on the real wall clock.
  const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const payload = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    notes: [{ id: 'future-note', title: 'imported', text: 'imported text', createdAt: 1, updatedAt: 1, pinned: false, deletedAt: null, localRev: 2 }],
    versions: [
      { noteId: 'future-note', seq: 1, at: 1000, sourceRev: 1, text: 'older' },
      { noteId: 'future-note', seq: 2, at: future, sourceRev: 2, text: 'imported text' },
    ],
  };
  const file = new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });
  await store.importAll(file, { mode: 'replace' });

  // Two local commits: the first is safe even under an `at`-ordered nextSeq
  // (the future-dated record still happens to hold the highest seq), but the
  // record it writes carries a local `at` far below that future one — so a
  // second commit ordered by `at` hands out the same seq again and overwrites
  // the first.
  let rev = store.saveDraft('future-note', 'typed locally');
  await store.flush('future-note', rev);
  const first = await store.commitVersion('future-note');
  assertEquals(first.seq, 3);

  rev = store.saveDraft('future-note', 'typed some more');
  await store.flush('future-note', rev);
  const second = await store.commitVersion('future-note');
  assertEquals(second.seq, 4, 'a local commit must get a seq above every existing one, not a colliding one');

  const versions = await store.listVersions('future-note', {});
  assertEquals(versions.length, 4, 'the imported pair plus both local commits must all survive');
  assertEquals((await store.getVersion('future-note', 2)).text, 'imported text', 'the future-dated imported version must not be overwritten');
  assertEquals((await store.getVersion('future-note', 3)).text, 'typed locally', 'the first local version must not be overwritten');

  await store.close();
});

// --- typed errors instead of bare TypeErrors on a missing note --------------

test('commitVersion for a note that does not exist rejects with not-found', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  let code;
  await store.commitVersion('no-such-note').catch((e) => { code = e.code; });
  assertEquals(code, 'not-found', 'expected a typed not-found, not a TypeError on draft.text');
  await store.close();
});

test('a draft write for a note that does not exist fails cleanly and writes no draft record', async () => {
  const dbName = `heldnote-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await store.open({ dbName });

  const events = [];
  store.subscribe((e) => events.push(e));

  // runDraftWrite reads the note record before issuing the draft put, so a
  // missing note aborts the write with nothing written — rather than
  // committing a draft record for a note that isn't there.
  const rev = store.saveDraft('no-such-note', 'text for a ghost');
  let code;
  await store.flush('no-such-note', rev).catch((e) => { code = e.code; });
  assertEquals(code, 'not-found');
  assert(events.some((e) => e.type === 'save-failed'), 'expected a save-failed event');

  await store.close();

  // getNote alone cannot prove this: it needs BOTH records and would report
  // not-found even with a draft stranded on disk. Only a raw read can tell the
  // difference between "nothing was written" and "the note half-exists".
  const strandedDraft = await withRawDb(dbName, ['drafts'], 'readonly', (tx) => {
    const req = tx.objectStore('drafts').get('no-such-note');
    const box = {};
    req.onsuccess = () => { box.value = req.result === undefined ? null : req.result; };
    return box;
  });
  assertEquals(strandedDraft, null, 'a draft record must not survive for a note that never existed');

  indexedDB.deleteDatabase(dbName);
});

// --- import validates every record, not just the envelope -------------------

test('importing a file whose note is missing a required field fails with invalid-import and writes nothing', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const before = await store.listNotes({ includeTrashed: true });

  // Envelope is perfectly well-formed; the note inside is missing `title`.
  // Written as-is, that record makes listNotes()'s search cursor throw inside
  // an async handler and hang the note list forever.
  const payload = {
    schemaVersion: 1,
    notes: [{ id: 'broken', text: 'body', createdAt: 1, updatedAt: 1, pinned: false, localRev: 0 }],
    versions: [],
  };
  let code;
  await store.importAll(new File([JSON.stringify(payload)], 'bad.json'), { mode: 'replace' }).catch((e) => { code = e.code; });
  assertEquals(code, 'invalid-import');

  const after = await store.listNotes({ includeTrashed: true });
  assertEquals(after.length, before.length, 'a rejected import must not partially write');

  await store.close();
});

test('importing a file whose version has a non-numeric seq fails with invalid-import', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const payload = {
    schemaVersion: 1,
    notes: [{ id: 'n', title: 't', text: 't', createdAt: 1, updatedAt: 1, pinned: false, deletedAt: null, localRev: 0 }],
    versions: [{ noteId: 'n', seq: 'one', at: 1, sourceRev: 0, text: 't' }],
  };
  let code;
  await store.importAll(new File([JSON.stringify(payload)], 'bad.json'), { mode: 'copy' }).catch((e) => { code = e.code; });
  assertEquals(code, 'invalid-import');
  await store.close();
});

// Opens the database behind store.js's back. Both tests below assert on the
// raw records — a stranded draft, and a note whose title is not a string —
// and neither state is reachable or observable through the public API, which
// is exactly why the claims went unverified before.
function withRawDb(dbName, storeNames, mode, work) {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => reject(openReq.error);
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(storeNames, mode);
      let result;
      try {
        result = work(tx);
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      tx.oncomplete = () => { db.close(); resolve(result && result.value !== undefined ? result.value : result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

test('a note whose title is not a string does not hang search (defensive guard)', async () => {
  const dbName = `heldnote-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await store.open({ dbName });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'searchable body');
  await store.flush(note.id, rev);
  await store.close();

  // Write a title parseImportFile would never let through. Reaching past the
  // store is the point: the guard exists for records that got onto disk some
  // other way (an older build, a partially-applied write, a third-party tool),
  // and a test that only uses well-formed notes cannot tell whether it works.
  await withRawDb(dbName, ['notes'], 'readwrite', (tx) => {
    const notes = tx.objectStore('notes');
    const getReq = notes.get(note.id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      delete record.title;
      notes.put(record);
    };
  });

  await store.open({ dbName });
  // Unguarded, record.title.toLowerCase() throws inside the async cursor
  // handler: cursor.continue() is never reached, the outer promise never
  // settles, and the note list dies until reload. The timeout is the assertion.
  const results = await withTimeout(store.listNotes({ query: 'searchable' }), 2000, 'listNotes hung on a note with no title');
  assertEquals(results.length, 1, 'the note should still be found by its body text');
  assertEquals(results[0].id, note.id);

  await store.close();
  indexedDB.deleteDatabase(dbName);
});

// --- backup carries the meta (settings) store -------------------------------

test('exportAll includes a meta array, and importAll round-trips meta entries back', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });

  const empty = JSON.parse(await (await store.exportAll()).text());
  assert(Array.isArray(empty.meta), 'export payload must always carry a meta array');

  const payload = {
    schemaVersion: 1,
    notes: [{ id: 'n', title: 'n', text: 'n', createdAt: 1, updatedAt: 1, pinned: false, deletedAt: null, localRev: 0 }],
    versions: [],
    meta: [{ key: 'theme', value: 'dark' }, { key: 'language', value: 'tr' }],
  };
  await store.importAll(new File([JSON.stringify(payload)], 'backup.json'), { mode: 'replace' });

  const reExported = JSON.parse(await (await store.exportAll()).text());
  const byKey = Object.fromEntries(reExported.meta.map((m) => [m.key, m.value]));
  assertEquals(byKey.theme, 'dark', 'imported settings must survive into the next export');
  assertEquals(byKey.language, 'tr');

  await store.close();
});

test('a backup file with no meta key at all still imports (older backups stay readable)', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const payload = {
    schemaVersion: 1,
    notes: [{ id: 'n', title: 'n', text: 'n', createdAt: 1, updatedAt: 1, pinned: false, deletedAt: null, localRev: 0 }],
    versions: [],
  };
  const result = await store.importAll(new File([JSON.stringify(payload)], 'old.json'), { mode: 'replace' });
  assertEquals(result.notesAdded, 1);
  await store.close();
});

// --- Task 14: persistence request timing ------------------------------------

test('persist() is requested only after the first version commit, not before', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  let persistCalls = 0;
  const originalPersist = navigator.storage.persist;
  navigator.storage.persist = async () => { persistCalls += 1; return true; };

  const rev = store.saveDraft(note.id, 'text');
  await store.flush(note.id, rev);
  assertEquals(persistCalls, 0, 'persist() must not be requested from the draft path');

  await store.commitVersion(note.id);
  assertEquals(persistCalls, 1, 'persist() must be requested once the first version commits');

  await store.commitVersion(note.id);
  const rev2 = store.saveDraft(note.id, 'text 2');
  await store.flush(note.id, rev2);
  await store.commitVersion(note.id);
  assertEquals(persistCalls, 1, 'persist() must only ever be requested once per session');

  navigator.storage.persist = originalPersist;
  await store.close();
});

// --- storage unavailable: the in-memory fallback ----------------------------
//
// setFaultInjection({ openOutcome }) makes openDb report an outcome other than
// 'ok' without touching the real IndexedDB implementation, which is the only
// way to reach the path a blocked/corrupt/disabled store takes. Every test here
// clears the fault immediately after open() so nothing else in the suite runs
// against a poisoned opener.

async function openInMemoryMode(outcome = 'unavailable') {
  setFaultInjection({ openOutcome: outcome });
  try {
    return await store.open({ dbName: `heldnote-test-${Date.now()}` });
  } finally {
    clearFaultInjection();
  }
}

test('open() resolves available:false with a reason (never rejects) when storage cannot be opened', async () => {
  const events = [];
  const unsubscribe = store.subscribe((e) => events.push(e));

  const status = await openInMemoryMode('corrupt');
  assertEquals(status.available, false);
  assertEquals(status.reason, 'corrupt');
  assertEquals(status.schemaVersion, 1);
  assert(events.some((e) => e.type === 'storage-unavailable' && e.reason === 'corrupt'), 'expected a storage-unavailable event carrying the reason');

  unsubscribe();
  await store.close();
});

test('a memory session survives a later successful open(): notes are migrated to disk, not stranded', async () => {
  const dbName = `heldnote-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // First open fails, so everything typed here lives only in the memory session.
  setFaultInjection({ openOutcome: 'unavailable' });
  let status;
  try {
    status = await store.open({ dbName });
  } finally {
    clearFaultInjection();
  }
  assertEquals(status.available, false);

  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'typed while storage was down');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  // Storage comes back. The second open must migrate that text rather than
  // leaving memory mode latched on (which would ignore the live connection) or
  // clearing it (which would drop the note entirely).
  const reopened = await store.open({ dbName });
  assertEquals(reopened.available, true, 'expected the second open to report working storage');

  const migrated = await store.getNote(note.id);
  assertEquals(migrated.text, 'typed while storage was down', 'the memory session note must survive the migration');

  const list = await store.listNotes({});
  assertEquals(list.length, 1);
  assertEquals(list[0].id, note.id);

  // Its history came across too, and the note is genuinely on disk now: a
  // further write goes through the persisted path and reads back.
  const versions = await store.listVersions(note.id, {});
  assert(versions.length >= 1, 'expected the memory session version history to be migrated');

  const rev2 = store.saveDraft(note.id, 'typed after storage came back');
  await store.flush(note.id, rev2);
  assertEquals((await store.getNote(note.id)).text, 'typed after storage came back');

  await store.close();
  indexedDB.deleteDatabase(dbName);
});

test('memory mode: create a note, type into it, and read it back — the whole core flow works with no storage', async () => {
  await openInMemoryMode('blocked');

  const note = await store.createNote();
  assert(typeof note.id === 'string' && note.id.length > 0, 'expected a generated id');
  assertEquals(note.title, 'Untitled');
  assertEquals(note.pinned, false);
  assertEquals(note.deletedAt, null);

  // saveDraft is still synchronous and still returns the assigned revision.
  const rev = store.saveDraft(note.id, 'typed with no storage\nsecond line');
  assert(rev > 0, 'expected an assigned revision');

  // flush must resolve, not hang: in memory-only mode the write is already as
  // durable as it can be.
  const receipt = await withTimeout(store.flush(note.id, rev), 2000, 'flush hung in memory mode');
  assertEquals(receipt.durableRev, rev);
  assert(!receipt.error, 'expected no error from a memory-mode flush');

  const reloaded = await store.getNote(note.id);
  assertEquals(reloaded.text, 'typed with no storage\nsecond line');
  assertEquals(reloaded.title, 'typed with no storage', 'the title must still be derived from the first line');
  assertEquals(reloaded.localRev, rev);

  const list = await store.listNotes({});
  assertEquals(list.length, 1);
  assertEquals(list[0].id, note.id);
  assertEquals(list[0].title, 'typed with no storage');

  await store.close();
});

test('memory mode: search covers title and body, and the trashed filter still applies', async () => {
  await openInMemoryMode();

  const titleMatch = await store.createNote();
  store.saveDraft(titleMatch.id, 'Zephyr notes\nsome body text');
  const bodyMatch = await store.createNote();
  store.saveDraft(bodyMatch.id, 'Grocery list\nremember to buy a ZEPHYR fan');
  const noMatch = await store.createNote();
  store.saveDraft(noMatch.id, 'Unrelated\nnothing interesting here');

  const results = await store.listNotes({ query: 'zephyr' });
  assertEquals(results.length, 2, 'expected the title-match and the body-match, but not the non-match');

  await store.trashNote(bodyMatch.id);
  assertEquals((await store.listNotes({ query: 'zephyr' })).length, 1, 'a trashed note must be excluded by default');
  assertEquals((await store.listNotes({ query: 'zephyr', includeTrashed: true })).length, 2);

  await store.restoreNote(bodyMatch.id);
  const restored = await store.listNotes({ includeTrashed: true });
  assertEquals(restored.find((n) => n.id === bodyMatch.id).deletedAt, null, 'restore must clear deletedAt at the boundary');

  await store.setPinned(noMatch.id, true);
  assertEquals((await store.listNotes({}))[0].id, noMatch.id, 'a pinned note must sort first');

  await store.purgeNote(noMatch.id);
  assertEquals((await store.listNotes({ includeTrashed: true })).length, 2, 'a purged note must be gone from every view');

  await store.close();
});

test('memory mode: exportAll carries this session‘s notes — the only way anything typed here leaves the tab', async () => {
  await openInMemoryMode();

  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'rescue me');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  const parsed = JSON.parse(await (await store.exportAll()).text());
  assertEquals(parsed.schemaVersion, 1);
  assertEquals(parsed.notes.length, 1);
  assertEquals(parsed.notes[0].text, 'rescue me');
  assertEquals(parsed.notes[0].id, note.id);
  assertEquals(parsed.versions.length, 1);
  assertEquals(parsed.versions[0].text, 'rescue me');
  assert(Array.isArray(parsed.meta), 'export payload must always carry a meta array, memory mode included');

  await store.close();
});

test('memory mode: version history commits, lists, reads back and restores', async () => {
  await openInMemoryMode();
  const note = await store.createNote();

  let rev = store.saveDraft(note.id, 'first');
  await store.flush(note.id, rev);
  const v1 = await store.commitVersion(note.id);
  assertEquals(v1.seq, 1);
  assertEquals(await store.commitVersion(note.id), null, 'unchanged text must not commit a duplicate version');

  rev = store.saveDraft(note.id, 'second');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  const versions = await store.listVersions(note.id, {});
  assertEquals(versions.length, 2);
  assert(versions[0].seq > versions[1].seq, 'expected newest-first ordering');
  assert(versions.every((v) => v.text === undefined), 'VersionInfo must not carry text');
  assertEquals((await store.getVersion(note.id, v1.seq)).text, 'first');

  // An unversioned edit must survive a restore as a checkpoint, exactly as it
  // does on the persisted path.
  rev = store.saveDraft(note.id, 'unversioned edit');
  await store.flush(note.id, rev);
  await store.restoreVersion(note.id, v1.seq);

  assertEquals((await store.getNote(note.id)).text, 'first', 'restore must apply the selected version text');
  const after = await store.listVersions(note.id, {});
  const texts = (await Promise.all(after.map((v) => store.getVersion(note.id, v.seq)))).map((v) => v.text);
  assert(texts.includes('unversioned edit'), 'the unversioned edit must survive as a checkpoint version');
  assert(after.length > versions.length, 'a restore must add versions, never remove them');

  await store.close();
});

test('memory mode: saveDraft for a note that does not exist still never throws, and reports save-failed', async () => {
  await openInMemoryMode();

  const events = [];
  store.subscribe((e) => events.push(e));

  const rev = store.saveDraft('no-such-note', 'text for a ghost');
  assert(typeof rev === 'number', 'saveDraft must return a revision even when it cannot store the text');

  let code;
  await store.flush('no-such-note', rev).catch((e) => { code = e.code; });
  assertEquals(code, 'not-found', 'flush must reject rather than hang when the write could not happen');
  assert(events.some((e) => e.type === 'save-failed'), 'expected a save-failed event');

  await store.close();
});

test('memory mode: importAll round-trips an exported backup, and runMaintenance is a no-op', async () => {
  await openInMemoryMode();

  const payload = {
    schemaVersion: 1,
    notes: [{ id: 'n', title: 'imported', text: 'imported text', createdAt: 1, updatedAt: 1, pinned: false, deletedAt: null, localRev: 3 }],
    versions: [{ noteId: 'n', seq: 1, at: 1000, sourceRev: 3, text: 'imported text' }],
    meta: [{ key: 'theme', value: 'dark' }],
  };
  const result = await store.importAll(new File([JSON.stringify(payload)], 'backup.json'), { mode: 'replace' });
  assertEquals(result.notesAdded, 1);
  assertEquals((await store.getNote('n')).text, 'imported text');

  // Seeding matters here for the same reason it does on the persisted path: an
  // unseeded durableRev makes flush() for the imported revision hang forever.
  const receipt = await withTimeout(store.flush('n', 3), 2000, 'flush hung for an imported revision');
  assertEquals(receipt.durableRev, 3);

  const reExported = JSON.parse(await (await store.exportAll()).text());
  assertEquals(reExported.meta[0].value, 'dark', 'imported settings must survive into the next export');

  assertEquals(await store.runMaintenance(), { pruned: 0, purged: 0 }, 'there is nothing to prune in memory');

  await store.close();
});

test('a store call made after the connection is force-closed fails with a typed error, not a TypeError', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  // What db.js does when another tab upgrades the database: the connection is
  // closed underneath us and onversionchange fires.
  store.__simulateVersionChangeForTests();

  let error;
  await store.listNotes({}).catch((e) => { error = e; });
  assertEquals(error && error.code, 'storage-unavailable', 'expected the documented StoreError code');

  // The draft path must not throw at its caller either — it reports through
  // the event stream, as always.
  const events = [];
  store.subscribe((e) => events.push(e));
  const rev = store.saveDraft(note.id, 'typed after the connection died');
  let flushCode;
  await store.flush(note.id, rev).catch((e) => { flushCode = e.code; });
  assertEquals(flushCode, 'storage-unavailable');
  assert(events.some((e) => e.type === 'save-failed'), 'expected a save-failed event rather than a raw throw');

  await store.close();
});

// --- the note size cap is enforced, not merely declared ---------------------

test('a draft over MAX_NOTE_SIZE_BYTES is refused, kept in the visible buffer, and warned about', async () => {
  await store.open({ dbName: `heldnote-test-${Date.now()}` });
  const note = await store.createNote();

  const events = [];
  store.subscribe((e) => events.push(e));

  const oversized = 'x'.repeat(LIMITS.MAX_NOTE_SIZE_BYTES + 1);
  const rev = store.saveDraft(note.id, oversized);
  let code;
  await store.flush(note.id, rev).catch((e) => { code = e.code; });
  assertEquals(code, 'note-too-large', 'an oversized note must not be reported as saved');

  assert(events.some((e) => e.type === 'quota-warning' && e.reason === 'note-too-large'), 'expected a quota-warning naming the size cap');
  assert(events.some((e) => e.type === 'memory-only'), 'expected the memory-only state, so the interface stops claiming to save');
  assertEquals(store.getMemoryOnlyText(note.id), oversized, 'the text the user typed must never be lost or truncated');

  // Nothing partial was written: the note still holds its pre-oversize text.
  assertEquals((await store.getNote(note.id)).text, '', 'a refused write must leave the stored draft untouched');

  // And the note keeps saving normally once the text is back under the cap.
  const smallRev = store.saveDraft(note.id, 'back under the limit');
  const receipt = await store.flush(note.id, smallRev);
  assertEquals(receipt.durableRev, smallRev);
  assertEquals((await store.getNote(note.id)).text, 'back under the limit');

  await store.close();
});

// --- maintenance runs at startup, not only after a write has already failed -

test('open() runs the pruning ladder at startup without any explicit runMaintenance() call', async () => {
  const dbName = `heldnote-test-${Date.now()}`;
  await store.open({ dbName });
  const note = await store.createNote();

  // 60 versions, all dated three days ago: the newest 50 are protected by
  // count, none by age, and the remaining 10 share one UTC day — so a pruning
  // pass thins them to one and exactly 9 records go.
  const realNow = Date.now;
  try {
    const threeDaysAgo = realNow.call(Date) - 3 * 24 * 60 * 60 * 1000;
    Date.now = () => threeDaysAgo;
    for (let i = 0; i < 60; i += 1) {
      const rev = store.saveDraft(note.id, `old-${i}`);
      await store.flush(note.id, rev);
      await store.commitVersion(note.id);
    }
  } finally {
    Date.now = realNow;
  }
  assertEquals((await store.listVersions(note.id, {})).length, 60);
  await store.close();

  // Reopening is the only trigger: nothing below calls runMaintenance().
  await store.open({ dbName });
  let remaining = 60;
  for (let i = 0; i < 80 && remaining === 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = (await store.listVersions(note.id, {})).length;
  }
  assertEquals(remaining, 51, 'startup maintenance must prune the day-thinnable versions on its own');

  await store.close();
  indexedDB.deleteDatabase(dbName);
});

// --- Task 15: i18n.js -------------------------------------------------------

import { t, setLanguage, getLanguage, detectLanguage } from '../i18n.js';

test('i18n: exact brand copy for saving/retention states, and language switching', () => {
  setLanguage('en');
  assertEquals(t('status.saving'), 'Saving…');
  assertEquals(t('status.notSaved'), 'Not saved — memory only');
  assertEquals(t('status.recovered'), 'Unsaved draft recovered');
  assertEquals(t('retention.label'), 'Browser retention');
  assertEquals(t('retention.persistent'), 'Persistent');
  assertEquals(t('retention.bestEffort'), 'Best effort');
  assertEquals(t('retention.sessionOnly'), 'Session only');
  assertEquals(t('trash.move'), 'Move to trash');
  assertEquals(t('trash.deletePermanently'), 'Delete permanently');
  assertEquals(t('history.title'), 'Version history');
  assertEquals(t('history.restoreConfirm'), 'Restore this version? The current text will remain available as an earlier version.');

  setLanguage('tr');
  assert(getLanguage() === 'tr');
  assert(t('status.saving') !== 'Saving…', 'expected a Turkish translation, not the English fallback');
});

test('i18n: detectLanguage defaults to English for anything that is not Turkish', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'language');
  Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true });
  assertEquals(detectLanguage(), 'en');
  Object.defineProperty(navigator, 'language', { value: 'tr-TR', configurable: true });
  assertEquals(detectLanguage(), 'tr');
  if (original) Object.defineProperty(navigator, 'language', original);
});
