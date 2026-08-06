import { test, assert, assertEquals } from './test-harness.js';
import * as store from '../store.js';
import { setFaultInjection, clearFaultInjection } from '../db.js';

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
