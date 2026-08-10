import { test, assert, assertEquals, withTimeout } from './test-harness.js';
import { openDb, setFaultInjection, clearFaultInjection, openTransaction, awaitTransactionComplete, markRequestSuccessForAbortFault } from '../db.js';

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

test('openDb releases the connection on versionchange, so a newer open is not left blocked', async () => {
  // db.js's onversionchange handler calls db.close() synchronously, which is
  // an intentional design choice: it lets a newer connection's upgrade
  // proceed immediately instead of sitting in the 'blocked' state. That
  // means, on a real browser, the second open below resolves 'ok' (not
  // 'blocked') as soon as the first connection releases its lock. What this
  // test actually needs to verify is that the release really happens: the
  // first connection receives versionchange, the second connection's open
  // is not left hanging, and the first connection is unusable afterwards.
  const name = freshDbName();
  let versionChangeFired = false;
  const first = await openDb({ name, version: 1, onVersionChange: () => { versionChangeFired = true; } });
  assert(first.outcome === 'ok');

  const second = await withTimeout(openDb({ name, version: 2 }), 2000, 'openDb({version:2}) never resolved');
  assert(second.outcome === 'ok', `expected ok, got ${second.outcome}`);
  assert(versionChangeFired, 'expected the first connection to receive versionchange');

  let closedAfterVersionChange = false;
  try {
    first.db.transaction(['meta'], 'readonly');
  } catch (_e) {
    closedAfterVersionChange = true;
  }
  assert(closedAfterVersionChange, 'expected the original connection to be closed after versionchange');

  second.db.close();
  indexedDB.deleteDatabase(name);
});

test('fault injection: quotaOnStore aborts the transaction', async () => {
  const name = freshDbName();
  const { db } = await openDb({ name });
  try {
    setFaultInjection({ quotaOnStore: 'drafts' });

    const tx = openTransaction(db, ['drafts'], 'readwrite');
    tx.objectStore('drafts').put({ noteId: 'n1', text: 'x', localRev: 1, savedAt: Date.now(), byteLength: 1 });
    let rejected = false;
    await awaitTransactionComplete(tx).catch(() => { rejected = true; });
    assert(rejected, 'expected the transaction to abort under the quota fault');
  } finally {
    try { clearFaultInjection(); } catch (_e) { /* best-effort cleanup */ }
    try { db.close(); } catch (_e) { /* best-effort cleanup */ }
    try { indexedDB.deleteDatabase(name); } catch (_e) { /* best-effort cleanup */ }
  }
});

test('fault injection: delayCompleteMs delays transaction completion as observed by awaitTransactionComplete', async () => {
  const name = freshDbName();
  const { db } = await openDb({ name });
  try {
    setFaultInjection({ delayCompleteMs: 150 });

    const tx = openTransaction(db, ['meta'], 'readwrite');
    tx.objectStore('meta').put({ key: 'x', value: 1 });
    const start = Date.now();
    await awaitTransactionComplete(tx);
    const elapsed = Date.now() - start;
    assert(elapsed >= 150, `expected >=150ms delay, got ${elapsed}ms`);
  } finally {
    try { clearFaultInjection(); } catch (_e) { /* best-effort cleanup */ }
    try { db.close(); } catch (_e) { /* best-effort cleanup */ }
    try { indexedDB.deleteDatabase(name); } catch (_e) { /* best-effort cleanup */ }
  }
});

test('fault injection: abortAfterRequestSuccess aborts the transaction right after a request succeeds', async () => {
  const name = freshDbName();
  const { db } = await openDb({ name });
  try {
    setFaultInjection({ abortAfterRequestSuccess: true });

    const tx = openTransaction(db, ['meta'], 'readwrite');
    const req = tx.objectStore('meta').put({ key: 'y', value: 1 });
    let requestSucceeded = false;
    req.onsuccess = () => {
      requestSucceeded = true;
      markRequestSuccessForAbortFault(tx);
    };

    let rejected = false;
    await awaitTransactionComplete(tx).catch(() => { rejected = true; });
    assert(requestSucceeded, 'expected the individual put() request to succeed first');
    assert(rejected, 'expected the transaction to still abort after the request succeeded');
  } finally {
    try { clearFaultInjection(); } catch (_e) { /* best-effort cleanup */ }
    try { db.close(); } catch (_e) { /* best-effort cleanup */ }
    try { indexedDB.deleteDatabase(name); } catch (_e) { /* best-effort cleanup */ }
  }
});
