import { test, assert, assertEquals } from './test-harness.js';
import { openDb } from '../db.js';

test('harness sanity', () => {
  assert(1 + 1 === 2, 'math is broken');
});

function freshDbName() {
  return `heldnote-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('openDb creates all four stores with the right indexes', async () => {
  const name = freshDbName();
  const result = await openDb({ name });
  assert(result.outcome === 'ok', `expected ok, got ${result.outcome}`);
  const { db } = result;

  const storeNames = Array.from(db.objectStoreNames).sort();
  assertEquals(storeNames, ['drafts', 'meta', 'notes', 'versions']);

  const tx = db.transaction(['notes', 'versions'], 'readonly');
  const notes = tx.objectStore('notes');
  assertEquals(Array.from(notes.indexNames).sort(), ['by_list', 'by_trash']);
  const versions = tx.objectStore('versions');
  assertEquals(Array.from(versions.indexNames).sort(), ['by_note_at']);

  db.close();
  indexedDB.deleteDatabase(name);
});
