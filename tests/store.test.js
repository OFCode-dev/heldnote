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
