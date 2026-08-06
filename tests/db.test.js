import { test, assert, assertEquals, withTimeout } from './test-harness.js';
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

test('openDb resolves version-error when the requested version is older than the stored one', async () => {
  const name = freshDbName();
  const first = await openDb({ name, version: 2 });
  assert(first.outcome === 'ok');
  first.db.close();

  const second = await openDb({ name, version: 1 });
  assert(second.outcome === 'version-error', `expected version-error, got ${second.outcome}`);

  indexedDB.deleteDatabase(name);
});

test('openDb resolves blocked when an older connection is still open at a higher requested version, and that connection gets versionchange', async () => {
  const name = freshDbName();
  let versionChangeFired = false;
  const first = await openDb({ name, version: 1, onVersionChange: () => { versionChangeFired = true; } });
  assert(first.outcome === 'ok');

  const second = await withTimeout(openDb({ name, version: 2 }), 2000, 'openDb({version:2}) never resolved blocked');
  assert(second.outcome === 'blocked', `expected blocked, got ${second.outcome}`);
  assert(versionChangeFired, 'expected the first connection to receive versionchange');

  first.db.close();
  indexedDB.deleteDatabase(name);
});
