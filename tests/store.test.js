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
