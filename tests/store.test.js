import { test, assert, assertEquals } from './test-harness.js';
import * as store from '../store.js';

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
