# Heldnote v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Heldnote v1 — a static, dependency-free, multi-note browser notepad backed by IndexedDB, with continuous draft persistence, snapshot version history, fenced restore, trash/undo, search, backup, multi-tab locking, and an honest saved/retention status.

**Architecture:** Two-layer persistence engine (draft layer + version layer) behind a single `store.js` data-API module that hides IndexedDB entirely. `db.js` is the only file that opens IndexedDB, runs its schema upgrade, and exposes a fault-injection seam for tests. Everything above `store.js` (editor, note list, history panel) asks for text and gets text — no transaction, cursor, store name, or `IDBRequest` crosses that boundary. UI modules are thin and built after the persistence engine is proven correct against real IndexedDB from a dependency-free `tests.html` harness.

**Tech Stack:** Vanilla JS (ES modules, no bundler), IndexedDB, Web Locks API, BroadcastChannel, no runtime dependencies, no build step.

## Naming note (read first)

The canonical spec and planning artifacts under `.claude/artifacts/` and `docs/superpowers/specs/2026-08-05-quick-keep-notepad-design.md` were written under the working name "Quick Keep Notepad" and IndexedDB database name `quick-keep`. On 2026-08-06, before any implementation code existed and before any real note was ever written, the product was renamed **Heldnote**, the domain **heldnote.app** was purchased as its dedicated origin, and a full brand brief was locked (see `.claude/artifacts/project/brand-brief.md`). This plan implements exactly the architecture, data model, and behavior in the design documents — nothing about the design changes — under the new name:

- Product name in UI, README, and docs going forward: **Heldnote**
- IndexedDB database name: **`heldnote`** (replacing the literal string `quick-keep` used in the cited documents — changed now because it is free to change before any user data exists)
- Deployment origin: **`https://heldnote.app`** (Task 20)
- Object store names, indexes, field names, and all behavior: unchanged from `store-api.md` / `data-assessment.md` / the design spec
- Visual tokens, product copy, and interaction timing: from `brand-brief.md` §4–8, applied in Task 16

Where a task quotes or references the source documents, the document's literal `quick-keep` string should be read as `heldnote`. Logo/icon graphic design (brand brief Stage A) and the marketing landing page (Stage C) are separate design deliverables, not produced by this engineering plan.

## Global Constraints

- No accepted draft revision waits more than 300 ms from the input event to transaction **completion** (`oncomplete`, not `put()` resolving).
- Writes to a note's draft are serialized and coalescing: at most one transaction in flight per note; a new keystroke replaces the queued payload with the latest full text; if a newer payload is waiting when a transaction completes, the next transaction starts immediately.
- A version snapshot commits ~2 s after typing stops, and at least every 2 minutes during unbroken typing. No version is committed when text is unchanged since the last one.
- Ordering is by `localRev`, never by clock. The draft is authoritative on open. A version whose `sourceRev` exceeds the draft's `localRev` is an invariant violation and must be surfaced as a recovery choice, never silently resolved.
- Restore (and any bulk destructive edit) is one fenced transaction: flush current revision, invalidate stale queued writes, insert a pre-restore checkpoint if the current draft differs from the newest version, write the restored text as a new draft revision, insert it as a new version, update metadata — published only after the transaction completes.
- Pruning: newest 50 versions always protected; every version from the last 24 h protected; older versions thinned to one per UTC day (ties broken by `seq`); bounded by a byte budget, not a record count; if the protected set alone exceeds budget, pruning pauses with a warning instead of deleting a protected point. `seq` is per-note monotonic and never reused.
- Trash retention is indefinite. There is no automatic purge on any timer. Purge only on explicit user confirmation.
- No type crossing the `store.js` boundary may name a storage mechanism (no `IDBTransaction`, cursor, store name, or `IDBRequest`). Only `db.js` calls the global `indexedDB` API.
- Current-text transactions and version-commit transactions request `durability: "strict"` (default until Task 21's measurement says otherwise).
- Booleans and `null` are not valid IndexedDB index keys: `pinned`→`pinKey: 0|1`, `deletedAt` is **omitted entirely** while a note is live (never stored as `null`). `store.js` normalizes these back to `pinned: boolean` / `deletedAt: number | null` at the boundary.
- Four distinct DB-open outcomes must be handled separately: `version-error` (reload for newer app files), `blocked` (another connection must close), `corrupt`/`unavailable` (in-memory session only), and an empty database (says "no local data found", without guessing why).
- Zero runtime dependencies, zero build step. All files are static and open directly.
- Every control is keyboard-reachable with visible focus and a label.
- Product copy, color tokens, corner radii, and motion timing come verbatim from `brand-brief.md` §4, §7, §8 — see Task 15/16.

---

## File Structure

```
heldnote/
  index.html          # app shell, loads app.js as a module
  tests.html           # test runner shell, loads tests/*.test.js as modules
  styles.css           # all styling (light + dark), brand tokens from brand-brief.md
  constants.js         # tunable limits shared by store.js (LIMITS)
  db.js                # IndexedDB open/schema/lifecycle + fault-injection seam
  store.js             # the data API — notes, drafts, versions, maintenance, backup
  i18n.js              # Turkish/English strings + browser-language detection
  editor.js            # textarea, line numbers, zoom, find/replace, save wiring
  notes-ui.js          # note list, search, pin, trash/undo
  history-ui.js        # version list, preview, restore
  app.js               # wiring: opens store, routes events to UI, shortcuts, lifecycle
  manifest.webmanifest # PWA manifest (Task 20)
  tests/
    test-harness.js    # tiny dependency-free test runner (test/assert/report)
    db.test.js         # db.js tests: schema, lifecycle, fault injection
    store.test.js       # store.js tests: every named failure case from the spec
    measure-latency.html # Task 21 measurement harness
```

One job per file, matching the design's module list. `store.js` stays a single file per the design's explicit statement that it is "the only module that knows how anything is stored" — it is not split further, only built up incrementally task by task.

---

## Task 1: Dependency-free test harness

**Files:**
- Create: `tests/test-harness.js`
- Create: `tests.html`

**Interfaces:**
- Produces: `test(name, fn)` — registers an async test. `assert(cond, msg)` — throws `Error(msg)` if `cond` is falsy. `assertEquals(actual, expected, msg)` — deep-ish equality via `JSON.stringify` for objects/arrays, strict `===` otherwise. `runTests()` — runs all registered tests sequentially (not in parallel, since IndexedDB tests share fault-injection state), renders a pass/fail summary into `#results` and to `console`.

- [ ] **Step 1: Write the failing test**

`tests/test-harness.js` doesn't exist yet, so there's nothing to run against. Instead, write the harness's own self-check inline at the bottom of the file under a guard, and verify it manually in Step 2 by opening the page — there is no meta-framework to test the test framework with. Create `tests.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Heldnote — tests</title>
</head>
<body>
  <h1>Heldnote test runner</h1>
  <div id="results">Running…</div>
  <script type="module">
    import { runTests } from './tests/test-harness.js';
    import './tests/db.test.js';
    import './tests/store.test.js';
    runTests();
  </script>
</body>
</html>
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html` directly in a browser (`file://` or a static server). Expected: a JS module error, because `tests/test-harness.js`, `tests/db.test.js`, and `tests/store.test.js` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
// tests/test-harness.js
const registered = [];

export function test(name, fn) {
  registered.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function assertEquals(actual, expected, msg) {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : actual;
  const b = typeof expected === 'object' ? JSON.stringify(expected) : expected;
  if (a !== b) {
    throw new Error(msg || `expected ${b}, got ${a}`);
  }
}

export function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg || `timed out after ${ms}ms`)), ms)),
  ]);
}

export async function runTests() {
  const results = document.getElementById('results');
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const { name, fn } of registered) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failed += 1;
      failures.push({ name, err });
      console.error(`FAIL: ${name}`, err);
    }
  }

  const summary = `${passed} passed, ${failed} failed, ${registered.length} total`;
  results.textContent = summary;
  if (failures.length) {
    const list = document.createElement('ul');
    for (const { name, err } of failures) {
      const li = document.createElement('li');
      li.textContent = `${name}: ${err.message}`;
      list.appendChild(li);
    }
    results.appendChild(list);
  }
  console.log(summary);
}
```

Create empty placeholder modules so the import graph resolves:

```js
// tests/db.test.js
import { test, assert } from './test-harness.js';

test('harness sanity', () => {
  assert(1 + 1 === 2, 'math is broken');
});
```

```js
// tests/store.test.js
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `#results` shows `1 passed, 0 failed, 1 total`.

- [ ] **Step 5: Commit**

```bash
git add tests.html tests/test-harness.js tests/db.test.js tests/store.test.js
git commit -m "test: add dependency-free test harness and runner page"
```

---

## Task 2: db.js — schema creation and open()

**Files:**
- Create: `db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- Consumes: nothing (first module in the dependency chain).
- Produces: `openDb({ name = 'heldnote', version = 1, onVersionChange } = {}) -> Promise<{ outcome: 'ok', db: IDBDatabase } | { outcome: 'version-error' | 'blocked' | 'corrupt' | 'unavailable', error?: DOMException }>`. Object stores: `notes` (keyPath `id`, indexes `by_list` on `[isDeleted, pinKey, updatedAt]` and `by_trash` on `[isDeleted, deletedAt]`), `drafts` (keyPath `noteId`, no index), `versions` (keyPath `[noteId, seq]`, index `by_note_at` on `[noteId, at, seq]`), `meta` (keyPath `key`).

- [ ] **Step 1: Write the failing test**

```js
// tests/db.test.js (append)
import { openDb } from '../db.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `db.js` does not exist, module import error.

- [ ] **Step 3: Write minimal implementation**

```js
// db.js
const DEFAULT_DB_NAME = 'heldnote';
const DB_VERSION = 1;

export function openDb({ name = DEFAULT_DB_NAME, version = DB_VERSION, onVersionChange } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const req = indexedDB.open(name, version);

    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (event.oldVersion < 1) {
        const notes = db.createObjectStore('notes', { keyPath: 'id' });
        notes.createIndex('by_list', ['isDeleted', 'pinKey', 'updatedAt']);
        notes.createIndex('by_trash', ['isDeleted', 'deletedAt']);

        db.createObjectStore('drafts', { keyPath: 'noteId' });

        const versions = db.createObjectStore('versions', { keyPath: ['noteId', 'seq'] });
        versions.createIndex('by_note_at', ['noteId', 'at', 'seq']);

        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      const db = req.result;
      // Registered here rather than relying on store.js to do it, since only
      // db.js is allowed to name IndexedDB constructs.
      db.onversionchange = () => {
        db.close();
        if (onVersionChange) onVersionChange();
      };
      resolve({ outcome: 'ok', db });
    };

    req.onerror = () => {
      if (settled) return;
      settled = true;
      const err = req.error;
      if (err && err.name === 'VersionError') {
        resolve({ outcome: 'version-error', error: err });
      } else if (err && (err.name === 'NotReadableError' || err.name === 'UnknownError')) {
        resolve({ outcome: 'corrupt', error: err });
      } else {
        resolve({ outcome: 'unavailable', error: err });
      }
    };

    req.onblocked = () => {
      if (settled) return;
      settled = true;
      resolve({ outcome: 'blocked' });
    };
  });
}

export function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `2 passed, 0 failed, 2 total`.

- [ ] **Step 5: Commit**

```bash
git add db.js tests/db.test.js
git commit -m "feat: db.js schema creation and open()"
```

---

## Task 3: db.js — connection lifecycle (blocked, versionchange, VersionError)

**Files:**
- Modify: `db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- Consumes: `openDb` from Task 2.
- Produces: no new exports; hardens the four open outcomes already in the return type.

- [ ] **Step 1: Write the failing test**

```js
// tests/db.test.js (append)
import { withTimeout } from './test-harness.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: the `version-error` case may already pass from Task 2's implementation; the `blocked` case fails or hangs until `withTimeout` catches it, since nothing has proven `onblocked` fires yet.

- [ ] **Step 3: Write minimal implementation**

Task 2's `openDb` already wires `onblocked`/`onversionchange`/`onerror` structurally. If both tests pass as-is, no production code changes are needed here — this task exists to prove the two multi-connection races, not to add new code. If the `blocked` test times out, the fix is ensuring `onblocked` is assigned synchronously on the request object before any `await`, which Task 2's implementation already does.

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `4 passed, 0 failed, 4 total`.

- [ ] **Step 5: Commit**

```bash
git add db.js tests/db.test.js
git commit -m "test: verify db.js blocked/versionchange/version-error outcomes"
```

---

## Task 4: db.js — fault-injection seam

**Files:**
- Modify: `db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `setFaultInjection({ quotaOnStore, delayCompleteMs, abortAfterRequestSuccess } = {})`, `clearFaultInjection()`, `openTransaction(db, storeNames, mode, { durability } = {}) -> IDBTransaction`, `awaitTransactionComplete(tx) -> Promise<void>`, `markRequestSuccessForAbortFault(tx) -> void`. These are the only way `store.js` is allowed to touch a transaction — this is what keeps `store.js` from having to import raw `indexedDB` semantics for the fault paths.

- [ ] **Step 1: Write the failing test**

```js
// tests/db.test.js (append)
import { setFaultInjection, clearFaultInjection, openTransaction, awaitTransactionComplete, markRequestSuccessForAbortFault } from '../db.js';

test('fault injection: quotaOnStore aborts the transaction', async () => {
  const name = freshDbName();
  const { db } = await openDb({ name });
  setFaultInjection({ quotaOnStore: 'drafts' });

  const tx = openTransaction(db, ['drafts'], 'readwrite');
  tx.objectStore('drafts').put({ noteId: 'n1', text: 'x', localRev: 1, savedAt: Date.now(), byteLength: 1 });
  let rejected = false;
  await awaitTransactionComplete(tx).catch(() => { rejected = true; });
  assert(rejected, 'expected the transaction to abort under the quota fault');

  clearFaultInjection();
  db.close();
  indexedDB.deleteDatabase(name);
});

test('fault injection: delayCompleteMs delays transaction completion as observed by awaitTransactionComplete', async () => {
  const name = freshDbName();
  const { db } = await openDb({ name });
  setFaultInjection({ delayCompleteMs: 150 });

  const tx = openTransaction(db, ['meta'], 'readwrite');
  tx.objectStore('meta').put({ key: 'x', value: 1 });
  const start = Date.now();
  await awaitTransactionComplete(tx);
  const elapsed = Date.now() - start;
  assert(elapsed >= 150, `expected >=150ms delay, got ${elapsed}ms`);

  clearFaultInjection();
  db.close();
  indexedDB.deleteDatabase(name);
});

test('fault injection: abortAfterRequestSuccess aborts the transaction right after a request succeeds', async () => {
  const name = freshDbName();
  const { db } = await openDb({ name });
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

  clearFaultInjection();
  db.close();
  indexedDB.deleteDatabase(name);
});
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `setFaultInjection`, `openTransaction`, `awaitTransactionComplete`, `markRequestSuccessForAbortFault` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// db.js (append)
let fault = null;

export function setFaultInjection(config = {}) {
  fault = config;
}

export function clearFaultInjection() {
  fault = null;
}

export function openTransaction(db, storeNames, mode, { durability } = {}) {
  const opts = {};
  if (mode === 'readwrite' && durability) opts.durability = durability;
  const tx = db.transaction(storeNames, mode, opts);

  if (fault && fault.quotaOnStore && storeNames.includes(fault.quotaOnStore)) {
    queueMicrotask(() => {
      try { tx.abort(); } catch (_e) { /* already settling */ }
    });
  }

  return tx;
}

export function awaitTransactionComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => {
      if (fault && fault.delayCompleteMs) {
        setTimeout(resolve, fault.delayCompleteMs);
      } else {
        resolve();
      }
    });
    tx.addEventListener('error', () => reject(tx.error));
    tx.addEventListener('abort', () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError')));
  });
}

export function markRequestSuccessForAbortFault(tx) {
  if (fault && fault.abortAfterRequestSuccess) {
    queueMicrotask(() => {
      try { tx.abort(); } catch (_e) { /* already settling */ }
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `7 passed, 0 failed, 7 total`.

- [ ] **Step 5: Commit**

```bash
git add db.js tests/db.test.js
git commit -m "feat: db.js fault-injection seam for quota, delay, and abort-after-success"
```

---

## Task 5: store.js — skeleton, StoreStatus, open()/close(), event bus

**Files:**
- Create: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `openDb` from `db.js`.
- Produces: `open() -> Promise<StoreStatus>` where `StoreStatus = { available, retention, schemaVersion, reason? }`. `close() -> Promise<void>`. `subscribe(handler) -> unsubscribe` where `handler({ type, ... })`, `type` one of `saved | saving | save-failed | note-changed | storage-unavailable | retention-changed | quota-warning | memory-only | lock-changed`.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js
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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `store.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js
import { openDb } from './db.js';

let conn = null;
let listeners = new Set();
let memoryFallback = null;

function emit(event) {
  for (const handler of listeners) {
    handler(event);
  }
}

export function __emitForTests(event) {
  emit(event);
}

export function subscribe(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export async function open({ dbName } = {}) {
  const result = await openDb({ name: dbName, onVersionChange: () => emit({ type: 'storage-unavailable', reason: 'version-change' }) });

  if (result.outcome === 'version-error') {
    throw Object.assign(new Error('This browser holds newer data than this page. Reload to update.'), { code: 'version-mismatch' });
  }

  if (result.outcome !== 'ok') {
    memoryFallback = { notes: new Map(), drafts: new Map(), versions: new Map() };
    const reason = result.outcome === 'blocked' ? 'blocked' : result.outcome === 'corrupt' ? 'corrupt' : 'unavailable';
    emit({ type: 'storage-unavailable', reason });
    return { available: false, retention: 'unknown', schemaVersion: 1, reason };
  }

  conn = result.db;
  return { available: true, retention: 'unknown', schemaVersion: 1 };
}

export async function close() {
  if (conn) {
    conn.close();
    conn = null;
  }
  memoryFallback = null;
  listeners = new Set();
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `9 passed, 0 failed, 9 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js skeleton with open()/close() and the event bus"
```

---

## Task 6: store.js — notes CRUD and the indexable-value boundary

**Files:**
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `conn` (module-level `IDBDatabase`) from Task 5; `openTransaction`/`awaitTransactionComplete`/`requestToPromise` from `db.js`.
- Produces: `listNotes({ query, includeTrashed, limit, before } = {}) -> Promise<NoteSummary[]>`, `getNote(id) -> Promise<Note>`, `createNote() -> Promise<Note>`, `setPinned(id, on) -> Promise<void>`, `trashNote(id) -> Promise<void>`, `restoreNote(id) -> Promise<void>`, `purgeNote(id) -> Promise<void>`. `NoteSummary = { id, title, updatedAt, pinned, deletedAt }` (`deletedAt: number | null`). `Note` adds `text, createdAt, localRev`.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `createNote`, `listNotes`, `setPinned`, `trashNote`, `restoreNote`, `purgeNote` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append imports)
import { openDb, openTransaction, awaitTransactionComplete, requestToPromise } from './db.js';

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function deriveTitle(text) {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0);
  return firstLine ? firstLine.trim().slice(0, 200) : 'Untitled';
}

function toNoteSummary(record) {
  return {
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt,
    pinned: record.pinKey === 1,
    deletedAt: record.isDeleted === 1 ? record.deletedAt : null,
  };
}

export async function createNote() {
  const id = newId();
  const now = Date.now();
  const noteRecord = {
    id, title: 'Untitled', createdAt: now, updatedAt: now, localRev: 0,
    pinned: false, pinKey: 0, isDeleted: 0,
  };
  const draftRecord = { noteId: id, text: '', localRev: 0, savedAt: now, byteLength: 0 };

  const tx = openTransaction(conn, ['notes', 'drafts'], 'readwrite', { durability: 'strict' });
  tx.objectStore('notes').put(noteRecord);
  tx.objectStore('drafts').put(draftRecord);
  await awaitTransactionComplete(tx);

  return { id, title: 'Untitled', text: '', createdAt: now, updatedAt: now, pinned: false, deletedAt: null, localRev: 0 };
}

export async function listNotes({ query, includeTrashed = false, limit, before } = {}) {
  const tx = openTransaction(conn, ['notes'], 'readonly');
  const store = tx.objectStore('notes');
  const results = [];

  await new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      const record = cursor.value;
      const isTrashed = record.isDeleted === 1;
      const included = includeTrashed ? true : !isTrashed;
      if (included && (!query || record.title.toLowerCase().includes(query.toLowerCase()))) {
        results.push(toNoteSummary(record));
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  results.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  const sliced = before ? results.filter((r) => r.updatedAt < before) : results;
  return typeof limit === 'number' ? sliced.slice(0, limit) : sliced;
}

export async function getNote(id) {
  const tx = openTransaction(conn, ['notes', 'drafts'], 'readonly');
  const noteRecord = await requestToPromise(tx.objectStore('notes').get(id));
  const draftRecord = await requestToPromise(tx.objectStore('drafts').get(id));
  if (!noteRecord || !draftRecord) {
    throw Object.assign(new Error(`note ${id} not found`), { code: 'not-found' });
  }
  revCounters.set(id, Math.max(revCounters.get(id) || 0, draftRecord.localRev));
  durableRevs.set(id, Math.max(durableRevs.get(id) || 0, draftRecord.localRev));
  return {
    id: noteRecord.id,
    title: noteRecord.title,
    text: draftRecord.text,
    createdAt: noteRecord.createdAt,
    updatedAt: noteRecord.updatedAt,
    pinned: noteRecord.pinKey === 1,
    deletedAt: noteRecord.isDeleted === 1 ? noteRecord.deletedAt : null,
    localRev: draftRecord.localRev,
  };
}

async function updateNoteFields(id, fields) {
  const tx = openTransaction(conn, ['notes'], 'readwrite', { durability: 'strict' });
  const store = tx.objectStore('notes');
  const record = await requestToPromise(store.get(id));
  if (!record) throw Object.assign(new Error(`note ${id} not found`), { code: 'not-found' });
  Object.assign(record, fields);
  store.put(record);
  await awaitTransactionComplete(tx);
  emit({ type: 'note-changed', noteId: id });
}

export async function setPinned(id, on) {
  await updateNoteFields(id, { pinned: on, pinKey: on ? 1 : 0 });
}

export async function trashNote(id) {
  await updateNoteFields(id, { isDeleted: 1, deletedAt: Date.now() });
}

export async function restoreNote(id) {
  const tx = openTransaction(conn, ['notes'], 'readwrite', { durability: 'strict' });
  const noteStore = tx.objectStore('notes');
  const record = await requestToPromise(noteStore.get(id));
  if (!record) throw Object.assign(new Error(`note ${id} not found`), { code: 'not-found' });
  record.isDeleted = 0;
  delete record.deletedAt;
  noteStore.put(record);
  await awaitTransactionComplete(tx);
  emit({ type: 'note-changed', noteId: id });
}

export async function purgeNote(id) {
  const tx = openTransaction(conn, ['notes', 'drafts', 'versions'], 'readwrite', { durability: 'strict' });
  tx.objectStore('notes').delete(id);
  tx.objectStore('drafts').delete(id);
  const versionsStore = tx.objectStore('versions');
  await new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
    const req = versionsStore.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await awaitTransactionComplete(tx);
  emit({ type: 'note-changed', noteId: id });
}
```

`getNote` references `revCounters`/`durableRevs`, which are introduced in Task 7 — declare them now (empty) so this task's tests pass standalone:

```js
// store.js (append, before getNote)
const revCounters = new Map();
const durableRevs = new Map();
```

(Task 7 reuses these same two `Map`s; do not redeclare them there.)

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `11 passed, 0 failed, 11 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js notes CRUD with the indexable-value normalization boundary"
```

---

## Task 7: store.js — the draft layer (serialized, coalescing writer)

This is the single most correctness-critical piece in the product. `saveDraft` must return synchronously and never throw; writes must be serialized per note; a newer keystroke must always replace a still-queued payload; and `flush` must resolve exactly when the requested revision's transaction has completed, even if a newer revision is already mid-flight.

**Files:**
- Create: `constants.js`
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: notes CRUD from Task 6, fault-injection seam from Task 4, `revCounters`/`durableRevs` declared in Task 6.
- Produces: `saveDraft(id, text) -> number` (synchronous, returns the assigned `localRev`, never throws). `flush(noteId, throughRev) -> Promise<SaveReceipt>` where `SaveReceipt = { noteId, requestedRev, durableRev, completedAt, error? }`. Emits `saving`, `saved`, `save-failed` events, each carrying a `SaveReceipt`.

- [ ] **Step 1: Write the failing test**

```js
// constants.js
export const LIMITS = {
  DRAFT_FLUSH_MAX_MS: 300,
  MAX_NOTE_SIZE_BYTES: 2 * 1024 * 1024, // 2 MB — provisional, see Task 21
};
```

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `saveDraft` and `flush` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append imports)
import { LIMITS } from './constants.js';

const draftQueues = new Map(); // noteId -> { pendingText, pendingRev, inFlight, waiters }

function queueFor(noteId) {
  let q = draftQueues.get(noteId);
  if (!q) {
    q = { pendingText: null, pendingRev: null, inFlight: false, waiters: [] };
    draftQueues.set(noteId, q);
  }
  return q;
}

export function saveDraft(id, text) {
  const nextRev = (revCounters.get(id) || 0) + 1;
  revCounters.set(id, nextRev);

  const q = queueFor(id);
  q.pendingText = text;
  q.pendingRev = nextRev;

  emit({ type: 'saving', noteId: id, requestedRev: nextRev });

  if (!q.inFlight) {
    runDraftWrite(id);
  }

  return nextRev;
}

function resolveWaiters(noteId, receipt) {
  const q = queueFor(noteId);
  const remaining = [];
  for (const waiter of q.waiters) {
    if (receipt.durableRev >= waiter.rev) {
      if (receipt.error) waiter.reject(receipt.error);
      else waiter.resolve(receipt);
    } else {
      remaining.push(waiter);
    }
  }
  q.waiters = remaining;
}

export function flush(noteId, throughRev) {
  const q = queueFor(noteId);
  return new Promise((resolve, reject) => {
    q.waiters.push({ rev: throughRev, resolve, reject });
  });
}

async function runDraftWrite(noteId) {
  const q = queueFor(noteId);
  q.inFlight = true;

  while (q.pendingText !== null) {
    const text = q.pendingText;
    const rev = q.pendingRev;
    q.pendingText = null;
    q.pendingRev = null;

    const now = Date.now();
    const byteLength = new TextEncoder().encode(text).length;
    const title = deriveTitle(text);

    let receipt;
    try {
      const tx = openTransaction(conn, ['notes', 'drafts'], 'readwrite', { durability: 'strict' });
      tx.objectStore('drafts').put({ noteId, text, localRev: rev, savedAt: now, byteLength });
      const noteStore = tx.objectStore('notes');
      const noteRecord = await requestToPromise(noteStore.get(noteId));
      noteRecord.title = title;
      noteRecord.updatedAt = now;
      noteRecord.localRev = rev;
      noteStore.put(noteRecord);
      await awaitTransactionComplete(tx);

      durableRevs.set(noteId, rev);
      receipt = { noteId, requestedRev: rev, durableRev: rev, completedAt: Date.now() };
      emit({ type: 'saved', ...receipt });
    } catch (error) {
      receipt = { noteId, requestedRev: rev, durableRev: durableRevs.get(noteId) || 0, completedAt: Date.now(), error };
      emit({ type: 'save-failed', ...receipt });
    }

    resolveWaiters(noteId, receipt);
  }

  q.inFlight = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `15 passed, 0 failed, 15 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js constants.js tests/store.test.js
git commit -m "feat: store.js serialized coalescing draft writer with localRev ordering"
```

---

## Task 8: store.js — the version layer (commitVersion, listVersions, getVersion)

**Files:**
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: draft layer from Task 7 (reads current draft text/localRev to snapshot).
- Produces: `commitVersion(id) -> Promise<VersionInfo | null>` (`VersionInfo = { seq, at, sourceRev, size }`, `null` if unchanged since the last version). `listVersions(id, { before, limit } = {}) -> Promise<VersionInfo[]>` (paged backwards by `[at, seq]`, newest first, no text). `getVersion(id, seq) -> Promise<Version>` (`Version = { seq, at, sourceRev, text }`).

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `commitVersion`, `listVersions`, `getVersion` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append)
const lastVersionText = new Map(); // noteId -> text of the newest committed version, for dedup

export async function commitVersion(id) {
  const currentRev = revCounters.get(id) || 0;
  if (currentRev > 0) {
    await flush(id, currentRev).catch(() => {});
  }
  const draftTx = openTransaction(conn, ['drafts'], 'readonly');
  const draft = await requestToPromise(draftTx.objectStore('drafts').get(id));

  const previousText = lastVersionText.get(id);
  if (previousText === draft.text) {
    return null;
  }

  const seq = await nextSeq(id);
  const at = Date.now();
  const byteLength = new TextEncoder().encode(draft.text).length;

  const writeTx = openTransaction(conn, ['versions'], 'readwrite', { durability: 'strict' });
  writeTx.objectStore('versions').put({ noteId: id, seq, at, sourceRev: draft.localRev, text: draft.text, byteLength });
  await awaitTransactionComplete(writeTx);

  lastVersionText.set(id, draft.text);
  return { seq, at, sourceRev: draft.localRev, size: byteLength };
}

async function nextSeq(noteId) {
  const tx = openTransaction(conn, ['versions'], 'readonly');
  const index = tx.objectStore('versions').index('by_note_at');
  const range = IDBKeyRange.bound([noteId, -Infinity, -Infinity], [noteId, Infinity, Infinity]);
  let maxSeq = 0;
  await new Promise((resolve, reject) => {
    const req = index.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { maxSeq = cursor.value.seq; }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  return maxSeq + 1;
}

export async function listVersions(id, { before, limit } = {}) {
  const tx = openTransaction(conn, ['versions'], 'readonly');
  const index = tx.objectStore('versions').index('by_note_at');
  const upper = before ? [id, before.at, before.seq] : [id, Infinity, Infinity];
  const range = IDBKeyRange.bound([id, -Infinity, -Infinity], upper, false, Boolean(before));
  const results = [];

  await new Promise((resolve, reject) => {
    const req = index.openCursor(range, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || (limit && results.length >= limit)) { resolve(); return; }
      const { seq, at, sourceRev, byteLength } = cursor.value;
      results.push({ seq, at, sourceRev, size: byteLength });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  return results;
}

export async function getVersion(id, seq) {
  const tx = openTransaction(conn, ['versions'], 'readonly');
  const record = await requestToPromise(tx.objectStore('versions').get([id, seq]));
  if (!record) throw Object.assign(new Error(`version ${id}/${seq} not found`), { code: 'not-found' });
  return { seq: record.seq, at: record.at, sourceRev: record.sourceRev, text: record.text };
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `17 passed, 0 failed, 17 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js version layer with [at, seq] cursor pagination"
```

---

## Task 9: store.js — restoreVersion, the fenced restore

This is the second correctness-critical piece: restoring must never destroy a draft that was saved but never versioned, and a stale draft-write callback that completes after a restore must not clobber the restored text.

**Files:**
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: draft layer (Task 7), version layer (Task 8).
- Produces: `restoreVersion(id, seq) -> Promise<VersionInfo>`. Introduces a per-note "generation" token so a draft-write in flight at the moment of restore cannot land after the restore and overwrite it.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `restoreVersion` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append)
const noteGeneration = new Map(); // noteId -> generation counter, bumped by each restore

function currentGeneration(noteId) {
  return noteGeneration.get(noteId) || 0;
}

export async function restoreVersion(id, seq) {
  const target = await getVersion(id, seq);

  const currentRev = revCounters.get(id) || 0;
  if (currentRev > 0) {
    await flush(id, currentRev).catch(() => {});
  }

  noteGeneration.set(id, currentGeneration(id) + 1);
  const q = queueFor(id);
  q.pendingText = null;
  q.pendingRev = null;

  const draftTx = openTransaction(conn, ['drafts'], 'readonly');
  const currentDraft = await requestToPromise(draftTx.objectStore('drafts').get(id));

  const newestVersions = await listVersions(id, { limit: 1 });
  const newestVersionText = newestVersions.length ? (await getVersion(id, newestVersions[0].seq)).text : undefined;
  const needsCheckpoint = currentDraft.text !== newestVersionText;

  const nextRev = currentRev + 1;
  revCounters.set(id, nextRev);
  durableRevs.set(id, nextRev);

  const baseSeq = await nextSeq(id);
  const checkpointSeq = needsCheckpoint ? baseSeq : null;
  const restoredSeq = needsCheckpoint ? baseSeq + 1 : baseSeq;

  const tx = openTransaction(conn, ['notes', 'drafts', 'versions'], 'readwrite', { durability: 'strict' });
  const versionsStore = tx.objectStore('versions');

  const at = Date.now();
  if (needsCheckpoint) {
    const checkpointByteLength = new TextEncoder().encode(currentDraft.text).length;
    versionsStore.put({ noteId: id, seq: checkpointSeq, at, sourceRev: currentDraft.localRev, text: currentDraft.text, byteLength: checkpointByteLength });
  }

  const byteLength = new TextEncoder().encode(target.text).length;
  versionsStore.put({ noteId: id, seq: restoredSeq, at, sourceRev: nextRev, text: target.text, byteLength });

  const draftStore = tx.objectStore('drafts');
  draftStore.put({ noteId: id, text: target.text, localRev: nextRev, savedAt: at, byteLength });

  const noteStore = tx.objectStore('notes');
  const noteRecord = await requestToPromise(noteStore.get(id));
  noteRecord.title = deriveTitle(target.text);
  noteRecord.updatedAt = at;
  noteRecord.localRev = nextRev;
  noteStore.put(noteRecord);

  await awaitTransactionComplete(tx);

  lastVersionText.set(id, target.text);
  emit({ type: 'note-changed', noteId: id });

  return { seq: restoredSeq, at, sourceRev: nextRev, size: byteLength };
}
```

For the "stale draft callback" test to pass, `runDraftWrite` (Task 7) must check the generation before publishing a completed write:

```js
// store.js — replace runDraftWrite's loop body (Task 7) with this generation-aware version:
async function runDraftWrite(noteId) {
  const q = queueFor(noteId);
  q.inFlight = true;

  while (q.pendingText !== null) {
    const text = q.pendingText;
    const rev = q.pendingRev;
    const generationAtQueue = currentGeneration(noteId);
    q.pendingText = null;
    q.pendingRev = null;

    const now = Date.now();
    const byteLength = new TextEncoder().encode(text).length;
    const title = deriveTitle(text);

    let receipt;
    try {
      if (currentGeneration(noteId) !== generationAtQueue) {
        throw Object.assign(new Error('stale write superseded by a restore'), { code: 'stale-generation' });
      }
      const tx = openTransaction(conn, ['notes', 'drafts'], 'readwrite', { durability: 'strict' });
      tx.objectStore('drafts').put({ noteId, text, localRev: rev, savedAt: now, byteLength });
      const noteStore = tx.objectStore('notes');
      const noteRecord = await requestToPromise(noteStore.get(noteId));
      noteRecord.title = title;
      noteRecord.updatedAt = now;
      noteRecord.localRev = rev;
      noteStore.put(noteRecord);
      await awaitTransactionComplete(tx);

      durableRevs.set(noteId, rev);
      receipt = { noteId, requestedRev: rev, durableRev: rev, completedAt: Date.now() };
      emit({ type: 'saved', ...receipt });
    } catch (error) {
      receipt = { noteId, requestedRev: rev, durableRev: durableRevs.get(noteId) || 0, completedAt: Date.now(), error };
      emit({ type: 'save-failed', ...receipt });
    }

    resolveWaiters(noteId, receipt);
  }

  q.inFlight = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `20 passed, 0 failed, 20 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js fenced restoreVersion with pre-restore checkpoint and generation fencing"
```

---

## Task 10: store.js — pruning ladder (runMaintenance)

**Files:**
- Modify: `store.js`
- Modify: `constants.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: version layer from Task 8.
- Produces: `runMaintenance() -> Promise<{ pruned, purged }>`. `purged` is always `0` in v1 — there is no automatic trash purge (design.md is explicit and overrides `store-api.md`'s looser wording; see the comment in the code below).

- [ ] **Step 1: Write the failing test**

```js
// constants.js — replace with:
export const LIMITS = {
  DRAFT_FLUSH_MAX_MS: 300,
  MAX_NOTE_SIZE_BYTES: 2 * 1024 * 1024, // 2 MB — provisional, see Task 21
  PROTECTED_RECENT_COUNT: 50,
  PROTECTED_RECENT_MS: 24 * 60 * 60 * 1000,
  PER_NOTE_HISTORY_BYTE_BUDGET: 10 * 1024 * 1024, // 10 MB — provisional, see Task 21
  GLOBAL_HISTORY_BYTE_BUDGET: 200 * 1024 * 1024, // 200 MB — provisional, see Task 21
};
```

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `runMaintenance` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append)
async function listNoteIds() {
  const tx = openTransaction(conn, ['notes'], 'readonly');
  const ids = [];
  await new Promise((resolve, reject) => {
    const req = tx.objectStore('notes').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      ids.push(cursor.value.id);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return ids;
}

function utcDayKey(at) {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

async function pruneNote(noteId) {
  const all = await listVersions(noteId, {});
  if (all.length === 0) return 0;

  const now = Date.now();
  const protectedByCount = new Set(all.slice(0, LIMITS.PROTECTED_RECENT_COUNT).map((v) => v.seq));
  const protectedByAge = new Set(all.filter((v) => now - v.at <= LIMITS.PROTECTED_RECENT_MS).map((v) => v.seq));
  const protectedSeqs = new Set([...protectedByCount, ...protectedByAge, all[0].seq]);

  const protectedBytes = all.filter((v) => protectedSeqs.has(v.seq)).reduce((sum, v) => sum + v.size, 0);
  if (protectedBytes > LIMITS.PER_NOTE_HISTORY_BYTE_BUDGET) {
    emit({ type: 'quota-warning', noteId, reason: 'protected-history-over-budget' });
    return 0;
  }

  const older = all.filter((v) => !protectedSeqs.has(v.seq));
  const keepOnePerDay = new Map();
  for (const v of older) {
    const key = utcDayKey(v.at);
    const existing = keepOnePerDay.get(key);
    if (!existing || v.seq > existing.seq) keepOnePerDay.set(key, v);
  }
  const keepSeqs = new Set([...protectedSeqs, ...Array.from(keepOnePerDay.values()).map((v) => v.seq)]);
  const toDelete = all.filter((v) => !keepSeqs.has(v.seq));

  if (toDelete.length === 0) return 0;

  const tx = openTransaction(conn, ['versions'], 'readwrite', { durability: 'strict' });
  const versionsStore = tx.objectStore('versions');
  for (const v of toDelete) {
    versionsStore.delete([noteId, v.seq]);
  }
  await awaitTransactionComplete(tx);
  return toDelete.length;
}

export async function runMaintenance() {
  return withGlobalLock(async () => {
    const noteIds = await listNoteIds();
    let pruned = 0;
    for (const id of noteIds) {
      pruned += await pruneNote(id);
    }
    // v1 has no automatic trash purge — design.md is explicit that trash is
    // emptied only on explicit user confirmation, overriding the looser
    // "and the trash purge" wording in store-api.md. purgeNote() (Task 6)
    // already covers the explicit path; nothing automatic happens here.
    return { pruned, purged: 0 };
  });
}

async function withGlobalLock(work) {
  return navigator.locks.request('heldnote-global', work);
}
```

(Task 12 also defines `withGlobalLock` for import — declare it once here and reuse it there; do not redeclare.)

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `22 passed, 0 failed, 22 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js constants.js tests/store.test.js
git commit -m "feat: store.js pruning ladder (newest-50, 24h, one-per-UTC-day, byte budget)"
```

---

## Task 11: store.js — quota exhaustion handling

**Files:**
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: fault-injection seam (Task 4), `runMaintenance` (Task 10).
- Produces: no new public functions — wires quota-exceeded retry/prune into `runDraftWrite` (draft path) and `commitVersion` (version path), adds a memory-only state. Emits `quota-warning`, `memory-only`. New: `getMemoryOnlyText(noteId) -> string | undefined`.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append)
import { setFaultInjection, clearFaultInjection } from '../db.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — no quota-specific retry/prune/memory-only behavior exists yet, and `getMemoryOnlyText` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append)
const memoryOnlyText = new Map();
let versionCommitsStopped = false;

export function getMemoryOnlyText(noteId) {
  return memoryOnlyText.get(noteId);
}

function isQuotaError(error) {
  return error && (error.name === 'QuotaExceededError' || error.name === 'AbortError');
}
```

Replace `runDraftWrite`'s `catch` block (from Task 9) with a retry-aware version:

```js
// store.js — runDraftWrite, replace the catch block with:
    } catch (error) {
      memoryOnlyText.set(noteId, text);
      if (isQuotaError(error)) {
        await runMaintenance().catch(() => {});
        try {
          const retryTx = openTransaction(conn, ['notes', 'drafts'], 'readwrite', { durability: 'strict' });
          retryTx.objectStore('drafts').put({ noteId, text, localRev: rev, savedAt: now, byteLength });
          const retryNoteStore = retryTx.objectStore('notes');
          const retryNoteRecord = await requestToPromise(retryNoteStore.get(noteId));
          retryNoteRecord.title = title;
          retryNoteRecord.updatedAt = now;
          retryNoteRecord.localRev = rev;
          retryNoteStore.put(retryNoteRecord);
          await awaitTransactionComplete(retryTx);

          durableRevs.set(noteId, rev);
          memoryOnlyText.delete(noteId);
          receipt = { noteId, requestedRev: rev, durableRev: rev, completedAt: Date.now() };
          emit({ type: 'saved', ...receipt });
          resolveWaiters(noteId, receipt);
          continue;
        } catch (retryError) {
          receipt = { noteId, requestedRev: rev, durableRev: durableRevs.get(noteId) || 0, completedAt: Date.now(), error: retryError };
          emit({ type: 'memory-only', noteId, text });
          resolveWaiters(noteId, receipt);
          continue;
        }
      }
      receipt = { noteId, requestedRev: rev, durableRev: durableRevs.get(noteId) || 0, completedAt: Date.now(), error };
      emit({ type: 'save-failed', ...receipt });
    }

    resolveWaiters(noteId, receipt);
  }

  q.inFlight = false;
}
```

Guard `commitVersion` (Task 8) with the same prune-retry-stop sequence:

```js
// store.js — commitVersion, replace the single write with a guarded version:
  if (versionCommitsStopped) {
    return null;
  }

  try {
    const writeTx = openTransaction(conn, ['versions'], 'readwrite', { durability: 'strict' });
    writeTx.objectStore('versions').put({ noteId: id, seq, at, sourceRev: draft.localRev, text: draft.text, byteLength });
    await awaitTransactionComplete(writeTx);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await runMaintenance().catch(() => {});
    try {
      const retryTx = openTransaction(conn, ['versions'], 'readwrite', { durability: 'strict' });
      retryTx.objectStore('versions').put({ noteId: id, seq, at, sourceRev: draft.localRev, text: draft.text, byteLength });
      await awaitTransactionComplete(retryTx);
    } catch (retryError) {
      versionCommitsStopped = true;
      emit({ type: 'quota-warning', noteId: id, reason: 'version-commits-stopped' });
      return null;
    }
  }

  lastVersionText.set(id, draft.text);
  return { seq, at, sourceRev: draft.localRev, size: byteLength };
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `24 passed, 0 failed, 24 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js quota exhaustion handling with prune-retry and memory-only fallback"
```

---

## Task 12: store.js — multi-tab locking (Web Locks + BroadcastChannel)

**Files:**
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `withGlobalLock` from Task 10.
- Produces: `acquireNoteLock(id) -> Promise<{ granted: boolean, heldBy?: string }>`, `releaseNoteLock(id) -> Promise<void>`. Emits `lock-changed`.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `acquireNoteLock`/`releaseNoteLock` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append)
const heldLocks = new Map();

export async function acquireNoteLock(id) {
  const lockName = `heldnote-note-${id}`;

  if (heldLocks.has(id)) {
    return { granted: true };
  }

  let released;
  const releasePromise = new Promise((resolve) => { released = resolve; });

  const outcome = await new Promise((resolve) => {
    let grantedFlag = false;
    navigator.locks.request(lockName, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve({ granted: false, heldBy: 'another tab' });
        return Promise.resolve();
      }
      grantedFlag = true;
      heldLocks.set(id, released);
      resolve({ granted: true });
      return releasePromise;
    }).catch(() => {
      if (!grantedFlag) resolve({ granted: false, heldBy: 'another tab' });
    });
  });

  if (outcome.granted) {
    emit({ type: 'lock-changed', noteId: id, granted: true });
  }
  return outcome;
}

export async function releaseNoteLock(id) {
  const release = heldLocks.get(id);
  if (release) {
    release();
    heldLocks.delete(id);
    emit({ type: 'lock-changed', noteId: id, granted: false });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `26 passed, 0 failed, 26 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js per-note Web Locks and reuse of the global lock for maintenance"
```

---

## Task 13: store.js — backup (export/import)

**Files:**
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: notes/drafts/versions data, `withGlobalLock` from Task 10.
- Produces: `exportAll() -> Promise<Blob>`, `importAll(file, { mode }) -> Promise<ImportResult>` where `mode: 'replace' | 'copy'`, `ImportResult = { notesAdded, notesCopied, versionsAdded, skipped }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `exportAll`/`importAll` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append)
const SCHEMA_VERSION = 1;

export async function exportAll() {
  const noteSummaries = await listNotes({ includeTrashed: true, limit: 100000 });
  for (const summary of noteSummaries) {
    const rev = revCounters.get(summary.id);
    if (rev) await flush(summary.id, rev).catch(() => {});
  }

  const notes = [];
  for (const summary of noteSummaries) {
    notes.push(await getNote(summary.id));
  }

  const versions = [];
  for (const summary of noteSummaries) {
    const infos = await listVersions(summary.id, {});
    for (const info of infos) {
      versions.push({ noteId: summary.id, ...(await getVersion(summary.id, info.seq)) });
    }
  }

  const payload = { schemaVersion: SCHEMA_VERSION, exportedAt: Date.now(), notes, versions };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

async function parseImportFile(file) {
  let text;
  try {
    text = await file.text();
  } catch (_e) {
    throw Object.assign(new Error('could not read file'), { code: 'invalid-import' });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_e) {
    throw Object.assign(new Error('file is not valid JSON'), { code: 'invalid-import' });
  }
  if (typeof parsed.schemaVersion !== 'number' || !Array.isArray(parsed.notes) || !Array.isArray(parsed.versions)) {
    throw Object.assign(new Error('file does not have the expected shape'), { code: 'invalid-import' });
  }
  if (parsed.schemaVersion > SCHEMA_VERSION) {
    throw Object.assign(new Error(`file schemaVersion ${parsed.schemaVersion} is newer than this app understands`), { code: 'invalid-import' });
  }
  return parsed;
}

function noteRecordFrom(note, idOverride) {
  return {
    id: idOverride || note.id, title: note.title, createdAt: note.createdAt, updatedAt: note.updatedAt,
    localRev: note.localRev, pinned: note.pinned, pinKey: note.pinned ? 1 : 0,
    isDeleted: note.deletedAt ? 1 : 0, ...(note.deletedAt ? { deletedAt: note.deletedAt } : {}),
  };
}

export async function importAll(file, { mode }) {
  const parsed = await parseImportFile(file);

  return withGlobalLock(async () => {
    if (mode === 'replace') {
      const tx = openTransaction(conn, ['notes', 'drafts', 'versions'], 'readwrite', { durability: 'strict' });
      tx.objectStore('notes').clear();
      tx.objectStore('drafts').clear();
      tx.objectStore('versions').clear();
      for (const note of parsed.notes) {
        tx.objectStore('notes').put(noteRecordFrom(note));
        tx.objectStore('drafts').put({ noteId: note.id, text: note.text, localRev: note.localRev, savedAt: note.updatedAt, byteLength: new TextEncoder().encode(note.text).length });
      }
      for (const v of parsed.versions) {
        tx.objectStore('versions').put({ noteId: v.noteId, seq: v.seq, at: v.at, sourceRev: v.sourceRev, text: v.text, byteLength: new TextEncoder().encode(v.text).length });
      }
      await awaitTransactionComplete(tx);
      return { notesAdded: parsed.notes.length, notesCopied: 0, versionsAdded: parsed.versions.length, skipped: 0 };
    }

    const idMap = new Map();
    const tx = openTransaction(conn, ['notes', 'drafts', 'versions'], 'readwrite', { durability: 'strict' });
    for (const note of parsed.notes) {
      const freshId = newId();
      idMap.set(note.id, freshId);
      tx.objectStore('notes').put(noteRecordFrom(note, freshId));
      tx.objectStore('drafts').put({ noteId: freshId, text: note.text, localRev: note.localRev, savedAt: note.updatedAt, byteLength: new TextEncoder().encode(note.text).length });
    }
    for (const v of parsed.versions) {
      const freshId = idMap.get(v.noteId);
      tx.objectStore('versions').put({ noteId: freshId, seq: v.seq, at: v.at, sourceRev: v.sourceRev, text: v.text, byteLength: new TextEncoder().encode(v.text).length });
    }
    await awaitTransactionComplete(tx);
    return { notesAdded: 0, notesCopied: parsed.notes.length, versionsAdded: parsed.versions.length, skipped: 0 };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `30 passed, 0 failed, 30 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js export/import with schemaVersion validation, replace and copy modes"
```

---

## Task 14: store.js — retention reporting and persist() timing

**Files:**
- Modify: `store.js`
- Test: `tests/store.test.js`

**Interfaces:**
- Consumes: `commitVersion` (Task 8) as the trigger point for requesting persistence.
- Produces: `retention-changed` events; requests `navigator.storage.persist()` once, after the first version is ever committed.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append)

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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — nothing currently calls `navigator.storage.persist()`.

- [ ] **Step 3: Write minimal implementation**

```js
// store.js (append)
let persistRequested = false;

async function requestPersistenceOnce() {
  if (persistRequested) return;
  persistRequested = true;
  if (!navigator.storage || !navigator.storage.persist) return;
  const granted = await navigator.storage.persist().catch(() => false);
  emit({ type: 'retention-changed', retention: granted ? 'persistent' : 'best-effort' });
}
```

```js
// store.js — commitVersion, add just before each `return { seq, at, sourceRev: ..., size: byteLength };`:
  requestPersistenceOnce();
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `31 passed, 0 failed, 31 total`.

- [ ] **Step 5: Commit**

```bash
git add store.js tests/store.test.js
git commit -m "feat: store.js requests persistent storage once, after the first version commit"
```

---

## Task 15: i18n.js — Turkish/English strings (brand copy)

**Files:**
- Create: `i18n.js`

**Interfaces:**
- Produces: `t(key) -> string`, `setLanguage(lang)`, `getLanguage() -> 'tr' | 'en'`, `detectLanguage() -> 'tr' | 'en'`. String keys and English text are exactly the locked product-language wording from `brand-brief.md` §8.

- [ ] **Step 1: Write the failing test**

```js
// tests/store.test.js (append) — i18n.js has no IndexedDB dependency, so it
// is verified with the existing harness rather than a new suite.
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
```

- [ ] **Step 2: Run test to verify it fails**

Open `tests.html`. Expected: FAIL — `i18n.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
// i18n.js
const STRINGS = {
  en: {
    'status.saving': 'Saving…',
    'status.saved': 'Saved locally',
    'status.notSaved': 'Not saved — memory only',
    'status.recovered': 'Unsaved draft recovered',
    'retention.label': 'Browser retention',
    'retention.persistent': 'Persistent',
    'retention.bestEffort': 'Best effort',
    'retention.sessionOnly': 'Session only',
    'retention.unknown': 'Unknown',
    'note.untitled': 'Untitled',
    'trash.move': 'Move to trash',
    'trash.restore': 'Restore note',
    'trash.deletePermanently': 'Delete permanently',
    'trash.deleteConfirm': 'Delete this note and all of its version history from this browser? This action cannot be undone.',
    'history.title': 'Version history',
    'history.preview': 'Preview version',
    'history.restoreConfirm': 'Restore this version? The current text will remain available as an earlier version.',
    'history.restored': 'Earlier version restored',
  },
  tr: {
    'status.saving': 'Kaydediliyor…',
    'status.saved': 'Yerel olarak kaydedildi',
    'status.notSaved': 'Kaydedilmedi — yalnızca bellekte',
    'status.recovered': 'Kaydedilmemiş taslak kurtarıldı',
    'retention.label': 'Tarayıcı saklama',
    'retention.persistent': 'Kalıcı',
    'retention.bestEffort': 'En iyi çaba',
    'retention.sessionOnly': 'Yalnızca oturum',
    'retention.unknown': 'Bilinmiyor',
    'note.untitled': 'Başlıksız',
    'trash.move': 'Çöp kutusuna taşı',
    'trash.restore': 'Notu geri yükle',
    'trash.deletePermanently': 'Kalıcı olarak sil',
    'trash.deleteConfirm': 'Bu not ve tüm sürüm geçmişi bu tarayıcıdan silinsin mi? Bu işlem geri alınamaz.',
    'history.title': 'Sürüm geçmişi',
    'history.preview': 'Sürümü önizle',
    'history.restoreConfirm': 'Bu sürüm geri yüklensin mi? Geçerli metin önceki bir sürüm olarak saklanmaya devam edecek.',
    'history.restored': 'Önceki sürüm geri yüklendi',
  },
};

let currentLanguage = 'en';

export function setLanguage(lang) {
  currentLanguage = STRINGS[lang] ? lang : 'en';
}

export function getLanguage() {
  return currentLanguage;
}

export function detectLanguage() {
  const lang = (navigator.language || '').toLowerCase();
  return lang.startsWith('tr') ? 'tr' : 'en';
}

export function t(key) {
  return STRINGS[currentLanguage][key] || STRINGS.en[key] || key;
}
```

- [ ] **Step 4: Run test to verify it passes**

Open `tests.html`. Expected: `33 passed, 0 failed, 33 total`.

- [ ] **Step 5: Commit**

```bash
git add i18n.js tests/store.test.js
git commit -m "feat: i18n.js with exact brand-locked product copy, TR/EN"
```

---

## Task 16: app.js + index.html + styles.css — shell, brand tokens, status bar

**Files:**
- Create: `app.js`
- Create: `index.html`
- Create: `styles.css`

**Interfaces:**
- Consumes: `store.js` (`open`, `subscribe`, `getNote`, `listNotes`, `flush`), `i18n.js` (`t`, `detectLanguage`, `setLanguage`).
- Produces: page shell with left/center/right panels and a status bar showing the durable revision and retention state as two separate lines, styled with the brand-brief color tokens, corner radii, and motion timing.

- [ ] **Step 1: Write the failing test**

Manual verification in a real browser (DOM wiring, not a data-correctness unit): open `index.html` and confirm it fails to render before the shell exists.

- [ ] **Step 2: Run test to verify it fails**

Open `index.html`. Expected: blank page / 404, since none of these three files exist yet.

- [ ] **Step 3: Write minimal implementation**

```html
<!-- index.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Heldnote</title>
  <link rel="stylesheet" href="styles.css">
  <link rel="manifest" href="manifest.webmanifest">
</head>
<body>
  <div id="app">
    <aside id="notes-panel"></aside>
    <main id="editor-panel"></main>
    <aside id="history-panel" hidden></aside>
    <footer id="status-bar">
      <span id="status-revision">—</span>
      <span id="status-retention">—</span>
    </footer>
  </div>
  <script type="module" src="app.js"></script>
</body>
</html>
```

```css
/* styles.css — tokens from brand-brief.md §4, §5, §7 */
:root {
  color-scheme: light dark;
  --ink-950: #0E1116;
  --ink-900: #171B22;
  --ink-800: #202630;
  --paper-100: #F2F0E8;
  --mist-400: #9CA6B4;
  --stone-300: #D7D4CC;
  --paper-50: #F6F4EE;
  --graphite-900: #20242A;
  --sage-500: #78A98D;
  --blue-500: #7295BA;
  --cyan-500: #73B8C8;
  --amber-500: #D4A65A;
  --coral-500: #D87970;

  --bg: var(--ink-950);
  --panel-bg: var(--ink-900);
  --elevated-bg: var(--ink-800);
  --text: var(--paper-100);
  --text-secondary: var(--mist-400);
  --border: var(--ink-800);

  --radius-control: 6px;
  --radius-panel: 8px;
  --radius-dialog: 10px;
  --motion-control: 150ms;
  --motion-panel: 210ms;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: var(--paper-50);
    --panel-bg: var(--paper-50);
    --elevated-bg: #ffffff;
    --text: var(--graphite-900);
    --text-secondary: #66707D;
    --border: var(--stone-300);
  }
}

@media (prefers-reduced-motion: reduce) {
  :root { --motion-control: 0ms; --motion-panel: 0ms; }
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }

#app {
  display: grid;
  grid-template-columns: 240px 1fr 280px;
  grid-template-rows: 1fr auto;
  height: 100vh;
}
#notes-panel { grid-column: 1; grid-row: 1; overflow-y: auto; background: var(--panel-bg); border-right: 1px solid var(--border); border-radius: 0 var(--radius-panel) var(--radius-panel) 0; }
#editor-panel { grid-column: 2; grid-row: 1; display: flex; flex-direction: column; }
#history-panel { grid-column: 3; grid-row: 1; overflow-y: auto; background: var(--panel-bg); border-left: 1px solid var(--border); border-radius: var(--radius-panel) 0 0 var(--radius-panel); transition: opacity var(--motion-panel) ease; }
#history-panel[hidden] { display: none; }
#status-bar { grid-column: 1 / -1; grid-row: 2; display: flex; gap: 1rem; padding: 0.25rem 0.75rem; font-size: 13px; font-weight: 500; border-top: 1px solid var(--border); }
#status-revision.state-saved { color: var(--sage-500); }
#status-revision.state-failed { color: var(--coral-500); }
#status-retention.state-warning { color: var(--amber-500); }
#status-retention.state-info { color: var(--blue-500); }

button {
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  background: var(--elevated-bg);
  color: var(--text);
  transition: background var(--motion-control) ease;
}
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--cyan-500); outline-offset: 2px; }

textarea#editor {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  font-size: 17px;
  background: var(--bg);
  color: var(--text);
  border: none;
  resize: none;
  padding: 1rem;
}
```

```js
// app.js
import * as store from './store.js';
import { t, setLanguage, detectLanguage } from './i18n.js';

let currentNoteId = null;

function renderStatus(event) {
  const revisionEl = document.getElementById('status-revision');
  const retentionEl = document.getElementById('status-retention');

  if (event.type === 'saved') {
    revisionEl.className = 'state-saved';
    revisionEl.textContent = `${t('status.saved')} · ${new Date(event.completedAt).toLocaleTimeString()}`;
  } else if (event.type === 'saving') {
    revisionEl.className = '';
    revisionEl.textContent = t('status.saving');
  } else if (event.type === 'memory-only') {
    revisionEl.className = 'state-failed';
    revisionEl.textContent = t('status.notSaved');
  } else if (event.type === 'retention-changed') {
    const key = { persistent: 'retention.persistent', 'best-effort': 'retention.bestEffort', 'session-only': 'retention.sessionOnly', unknown: 'retention.unknown' }[event.retention] || 'retention.unknown';
    retentionEl.className = event.retention === 'best-effort' || event.retention === 'session-only' ? 'state-warning' : 'state-info';
    retentionEl.textContent = `${t('retention.label')}: ${t(key)}`;
  }
}

async function boot() {
  setLanguage(detectLanguage());

  const status = await store.open({});
  store.subscribe(renderStatus);

  if (!status.available) {
    document.getElementById('editor-panel').insertAdjacentHTML('afterbegin', `<div role="alert">${status.reason}</div>`);
  }

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentNoteId) {
      store.flush(currentNoteId, 0).catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => {
    if (currentNoteId) store.flush(currentNoteId, 0).catch(() => {});
  });
}

boot();

export { currentNoteId };
```

(`notes-ui.js`, `editor.js`, and `history-ui.js` in Tasks 17–19 replace the empty `#notes-panel`/`#editor-panel`/`#history-panel` contents and set `currentNoteId` for real; this task only proves the shell boots against a real store with the brand tokens applied.)

- [ ] **Step 4: Run test to verify it passes**

Open `index.html` with dev tools open. Expected: no console errors, dark theme uses Ink 950/900/800 with Paper 100 text (light theme swaps to Paper 50/Graphite 900 under `prefers-color-scheme: light`), status bar renders, `store.open()` succeeds.

- [ ] **Step 5: Commit**

```bash
git add app.js index.html styles.css
git commit -m "feat: app shell with brand color tokens, corner radii, and motion timing"
```

---

## Task 17: notes-ui.js — list, search, pin, trash/undo

**Files:**
- Create: `notes-ui.js`
- Modify: `app.js`

**Interfaces:**
- Consumes: `store.listNotes`, `store.createNote`, `store.setPinned`, `store.trashNote`, `store.restoreNote`; `i18n.js` for trash copy.
- Produces: `renderNotesPanel(container, { onSelect }) -> { refresh: () => Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Manual: open `index.html`, expect no note list renders yet (empty `#notes-panel`).

- [ ] **Step 2: Run test to verify it fails**

Confirmed empty by Task 16's output — proceed to implementation.

- [ ] **Step 3: Write minimal implementation**

```js
// notes-ui.js
import * as store from './store.js';
import { t } from './i18n.js';

export function renderNotesPanel(container, { onSelect }) {
  container.innerHTML = `
    <button id="new-note">New note</button>
    <input id="search" type="search" aria-label="Search notes">
    <ul id="note-list"></ul>
    <div id="undo-banner" hidden></div>
  `;

  const list = container.querySelector('#note-list');
  const searchInput = container.querySelector('#search');
  let lastTrashedId = null;

  async function refresh() {
    const query = searchInput.value.trim() || undefined;
    const notes = await store.listNotes({ query });
    list.innerHTML = '';
    for (const note of notes) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = `${note.pinned ? '📌 ' : ''}${note.title || t('note.untitled')}`;
      button.addEventListener('click', () => onSelect(note.id));

      const pinButton = document.createElement('button');
      pinButton.textContent = note.pinned ? 'Unpin' : 'Pin';
      pinButton.addEventListener('click', async () => {
        await store.setPinned(note.id, !note.pinned);
        refresh();
      });

      const trashButton = document.createElement('button');
      trashButton.textContent = t('trash.move');
      trashButton.addEventListener('click', async () => {
        await store.trashNote(note.id);
        lastTrashedId = note.id;
        showUndo();
        refresh();
      });

      li.append(button, pinButton, trashButton);
      list.appendChild(li);
    }
  }

  function showUndo() {
    const banner = container.querySelector('#undo-banner');
    banner.hidden = false;
    banner.innerHTML = '';
    const undoButton = document.createElement('button');
    undoButton.textContent = t('trash.restore');
    undoButton.addEventListener('click', async () => {
      if (lastTrashedId) await store.restoreNote(lastTrashedId);
      banner.hidden = true;
      refresh();
    });
    banner.appendChild(undoButton);
  }

  container.querySelector('#new-note').addEventListener('click', async () => {
    const note = await store.createNote();
    await refresh();
    onSelect(note.id);
  });

  searchInput.addEventListener('input', () => refresh());

  refresh();
  return { refresh };
}
```

```js
// app.js — inside boot(), after store.open():
import { renderNotesPanel } from './notes-ui.js';
// ...
const notesPanel = renderNotesPanel(document.getElementById('notes-panel'), {
  onSelect: (id) => { currentNoteId = id; /* Task 18 wires the editor to this */ },
});
```

- [ ] **Step 4: Run test to verify it passes**

Open `index.html`. Expected: clicking "New note" creates a note and it appears in the list; search filters it; pin/trash/undo work end to end using the brand-locked "Move to trash"/"Restore note" copy.

- [ ] **Step 5: Commit**

```bash
git add notes-ui.js app.js
git commit -m "feat: notes-ui.js list, search, pin, and trash with undo"
```

---

## Task 18: editor.js — textarea, saveDraft wiring, version-commit scheduling

**Files:**
- Create: `editor.js`
- Modify: `app.js`

**Interfaces:**
- Consumes: `store.saveDraft`, `store.commitVersion`, `store.getNote`.
- Produces: `renderEditor(container, noteId) -> { destroy: () => void }`. Owns the 2 s idle / 2 min max version-commit scheduler (this cadence lives in the UI layer — `store.js` only exposes the primitive `commitVersion(id)`).

- [ ] **Step 1: Write the failing test**

Manual: open `index.html`, select a note, expect no textarea renders yet.

- [ ] **Step 2: Run test to verify it fails**

Confirmed by Task 17's output — proceed to implementation.

- [ ] **Step 3: Write minimal implementation**

```js
// editor.js
import * as store from './store.js';

export function renderEditor(container, noteId) {
  container.innerHTML = `<textarea id="editor" aria-label="Note text"></textarea>`;
  const textarea = container.querySelector('#editor');

  let idleTimer = null;
  let maxWaitTimer = null;

  store.getNote(noteId).then((note) => { textarea.value = note.text; });

  function scheduleVersionCommit() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      store.commitVersion(noteId);
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }, 2000);

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        store.commitVersion(noteId);
        maxWaitTimer = null;
      }, 120000);
    }
  }

  function onInput() {
    store.saveDraft(noteId, textarea.value);
    scheduleVersionCommit();
  }

  textarea.addEventListener('input', onInput);

  return {
    destroy() {
      textarea.removeEventListener('input', onInput);
      clearTimeout(idleTimer);
      clearTimeout(maxWaitTimer);
    },
  };
}
```

```js
// app.js — replace the onSelect stub from Task 17 with:
import { renderEditor } from './editor.js';
// ...
let activeEditor = null;
const notesPanel = renderNotesPanel(document.getElementById('notes-panel'), {
  onSelect: (id) => {
    currentNoteId = id;
    if (activeEditor) activeEditor.destroy();
    activeEditor = renderEditor(document.getElementById('editor-panel'), id);
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Open `index.html`, create a note, type text, wait 2 s, reload the page, select the note: expect the typed text to be present (draft) and the history panel (Task 19) to show one version.

- [ ] **Step 5: Commit**

```bash
git add editor.js app.js
git commit -m "feat: editor.js wires saveDraft on input and schedules commitVersion at 2s idle / 2min max"
```

---

## Task 19: history-ui.js — version list, preview, restore

**Files:**
- Create: `history-ui.js`
- Modify: `app.js`

**Interfaces:**
- Consumes: `store.listVersions`, `store.getVersion`, `store.restoreVersion`; `i18n.js` for history-panel copy.
- Produces: `renderHistoryPanel(container, noteId) -> { refresh: () => Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Manual: open `index.html`, select a note with at least one version, expect the history panel to stay empty/hidden.

- [ ] **Step 2: Run test to verify it fails**

Confirmed by Task 18's output — proceed to implementation.

- [ ] **Step 3: Write minimal implementation**

```js
// history-ui.js
import * as store from './store.js';
import { t } from './i18n.js';

export function renderHistoryPanel(container, noteId) {
  container.hidden = false;
  container.innerHTML = `<h2>${t('history.title')}</h2><ul id="version-list"></ul><div id="version-preview"></div>`;
  const list = container.querySelector('#version-list');
  const preview = container.querySelector('#version-preview');

  async function refresh() {
    const versions = await store.listVersions(noteId, {});
    list.innerHTML = '';
    for (const info of versions) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = new Date(info.at).toLocaleString();
      button.setAttribute('aria-label', t('history.preview'));
      button.addEventListener('click', async () => {
        const full = await store.getVersion(noteId, info.seq);
        preview.innerHTML = '';
        const pre = document.createElement('pre');
        pre.textContent = full.text;
        const restoreButton = document.createElement('button');
        restoreButton.textContent = t('history.restoreConfirm');
        restoreButton.addEventListener('click', async () => {
          await store.restoreVersion(noteId, info.seq);
          preview.innerHTML = `<p>${t('history.restored')}</p>`;
          await refresh();
        });
        preview.append(pre, restoreButton);
      });
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  refresh();
  return { refresh };
}
```

```js
// app.js — inside the onSelect callback, after creating activeEditor:
import { renderHistoryPanel } from './history-ui.js';
// ...
renderHistoryPanel(document.getElementById('history-panel'), id);
```

- [ ] **Step 4: Run test to verify it passes**

Open `index.html`, select a note with committed versions, click one, confirm the preview shows its text with the "Restore this version? The current text will remain available as an earlier version." confirm copy, click restore, confirm "Earlier version restored" shows and both the editor and version list update.

- [ ] **Step 5: Commit**

```bash
git add history-ui.js app.js
git commit -m "feat: history-ui.js version list, preview on selection, and restore"
```

---

## Task 20: Deployment — dedicated origin (heldnote.app) and pre-launch checklist

**Files:**
- Create: `CNAME`
- Create: `manifest.webmanifest`
- Modify: `README.md`

**Interfaces:** none — deployment/DNS/asset-wiring task, not a data-correctness task.

- [ ] **Step 1: Write the failing check**

Check: `curl -sI https://heldnote.app`. Expected: DNS resolution failure or nothing configured yet.

- [ ] **Step 2: Confirm the failing state**

Run the `curl` command above and confirm it does not return the Heldnote app.

- [ ] **Step 3: Configure the origin and pre-launch checklist**

1. Add a `CNAME` file at the repo root containing exactly `heldnote.app`.
2. At the registrar for `heldnote.app`, create the DNS records GitHub Pages currently documents for an apex custom domain (`ALIAS`/`ANAME`/`A` records, since apex domains cannot use `CNAME` under the DNS spec), plus a `www.heldnote.app` → `heldnote.app` redirect per brand-brief.md §10.
3. In the repository's GitHub Pages settings, set the custom domain to `heldnote.app` and enable "Enforce HTTPS" once the certificate provisions.
4. Confirm no other repository or script is served from `heldnote.app` — single-purpose origin per the design's deployment invariants.
5. Add `manifest.webmanifest`:
   ```json
   {
     "name": "Heldnote",
     "short_name": "Heldnote",
     "description": "Local-first notes with version history",
     "start_url": "/",
     "display": "standalone",
     "background_color": "#0E1116",
     "theme_color": "#0E1116",
     "icons": []
   }
   ```
   Leave `icons: []` until Stage A (brand-brief.md §3/§11) produces the actual favicon/PWA/Apple-touch-icon assets — this manifest is wired now so nothing blocks on it later, but the icon files themselves are a separate design deliverable, not produced by this engineering task.
6. Update `README.md`'s deployment section: canonical production origin is `https://heldnote.app`; `www.heldnote.app` redirects to it; any future origin change is an explicit export/import migration, never a silent move; a release smoke test opens the existing production database before every deploy, per the design's invariant.

- [ ] **Step 4: Verify**

Run `curl -sI https://heldnote.app` again once DNS propagates. Expected: `200 OK` serving `index.html` with a valid TLS certificate, and `curl -sI https://www.heldnote.app` redirecting to the apex.

- [ ] **Step 5: Commit**

```bash
git add CNAME manifest.webmanifest README.md
git commit -m "chore: configure heldnote.app as the dedicated deployment origin"
```

---

## Task 21: Measurement — durability mode and byte budgets

**Files:**
- Create: `tests/measure-latency.html`
- Modify: `constants.js`

- [ ] **Step 1: Write the measurement harness**

```html
<!-- tests/measure-latency.html -->
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Heldnote — draft latency measurement</title></head>
<body>
  <pre id="out">Running…</pre>
  <script type="module">
    import * as store from '../store.js';

    async function measure(sampleSize) {
      await store.open({ dbName: `heldnote-measure-${Date.now()}` });
      const note = await store.createNote();
      const samples = [];
      for (let i = 0; i < sampleSize; i += 1) {
        const start = performance.now();
        const rev = store.saveDraft(note.id, `sample-${i}-${'x'.repeat(500)}`);
        const receipt = await store.flush(note.id, rev);
        samples.push(receipt.completedAt ? performance.now() - start : null);
      }
      await store.close();
      samples.sort((a, b) => a - b);
      return {
        p50: samples[Math.floor(samples.length * 0.5)],
        p95: samples[Math.floor(samples.length * 0.95)],
        p99: samples[Math.floor(samples.length * 0.99)],
        max: samples[samples.length - 1],
      };
    }

    const result = await measure(200);
    document.getElementById('out').textContent = JSON.stringify(result, null, 2);
  </script>
</body>
</html>
```

- [ ] **Step 2: Run the measurement**

Open `tests/measure-latency.html` in each target browser (current Chrome, Firefox, Edge) on representative hardware (the mid-range laptop referenced in the PRD's startup-time NFR). Record p50/p95/p99/max for `durability: "strict"`.

- [ ] **Step 3: Decide and record**

If p99 stays comfortably under 300 ms on all three browsers, keep `durability: "strict"` as the shipped default and record the measured numbers as a comment in `constants.js`. If p99 or max approaches/exceeds 300 ms, add a second pass with `durability: "relaxed"` on the draft path only (version commits stay `"strict"`), and update the `openTransaction` calls in `runDraftWrite` accordingly if adopted.

- [ ] **Step 4: Byte budgets**

Using the same harness pattern, create notes of representative real sizes, commit ~200 versions each, and measure on-disk impact via `navigator.storage.estimate()` before/after. Replace the provisional `MAX_NOTE_SIZE_BYTES`/`PER_NOTE_HISTORY_BYTE_BUDGET`/`GLOBAL_HISTORY_BYTE_BUDGET` in `constants.js` with measured figures, or confirm the provisional 2 MB / 10 MB / 200 MB defaults are reasonable.

- [ ] **Step 5: Commit**

```bash
git add tests/measure-latency.html constants.js
git commit -m "chore: measure draft-write latency and set byte budgets from real numbers"
```

---

## Task 22: Manual QA — kill-tab recovery and the three Safari modes

**Files:** none (manual testing task, results recorded in `README.md`'s QA notes).

- [ ] **Step 1: Kill-tab mid-sentence, Chrome/Firefox/Edge**

Open the app, type continuously without pausing, force-kill the tab/process mid-word. Reopen. Expected: at most ~300 ms of typing lost, recovered text read back verbatim.

- [ ] **Step 2: Kill-tab after one full minute of continuous typing**

Repeat Step 1 typing continuously for a full minute first, to exercise the 2-minute max version-commit interval under sustained load. Expected: same recovery guarantee, at least one version committed during the minute.

- [ ] **Step 3: Ordinary Safari tab**

On a real macOS or iOS device, open the app in an ordinary Safari tab. Type, close, reopen after a delay. Record whether text survives and confirm the retention indicator shows non-durable/best-effort.

- [ ] **Step 4: Installed Safari Home Screen / Dock web app**

Install to Home Screen (iOS) or Dock (macOS). Repeat the typing/kill/reopen test from the installed app icon. Record whether retention differs from the ordinary-tab case.

- [ ] **Step 5: Safari Private Browsing**

Repeat in Private Browsing. Expected: a write probe succeeds but storage is ephemeral per-tab. Confirm the retention indicator reports `session-only`, not `best-effort`. Record all five results in `README.md` under a dated "Manual QA — Safari & recovery" section.

---

## Self-Review

**Spec coverage:** Every "Must" functional requirement in the PRD has a task — multiple notes/titles (Task 6), continuous draft saving (Task 7), recovery after abrupt ending (Tasks 7, 16, 18), version history (Task 8), restore (Task 9), version pruning (Task 10), trash/undo (Tasks 6, 17), search (Tasks 6, 17), visible save state (Tasks 14, 16), export/import (Task 13), storage availability/persistence (Tasks 5, 14), quota exhaustion (Task 11), multi-tab guard (Task 12), Turkish/English (Task 15), dedicated origin (Task 20). Non-functional requirements — durability window, no dependencies/build, Safari's declared limits, accessibility, data-safety-on-failure — are in the Global Constraints plus Tasks 7, 21, 22. Brand brief requirements (color tokens, motion, corners, exact product copy, favicon/manifest checklist) are in Tasks 15, 16, 20. Editor features carried over (find/replace, line numbers, zoom) are a "Should" and are scoped as follow-on work once Tasks 16–19 land, addable without touching `store.js`. Logo/icon graphic design and the marketing landing page (brand-brief Stages A and C) are explicitly out of scope for this engineering plan.

**Placeholder scan:** No `TBD`/"add error handling"/"similar to Task N" placeholders remain — every step shows real code; the two provisional-number areas (byte budgets, durability mode) are concrete measurable tasks (Task 21), not blockers.

**Type consistency:** `SaveReceipt { noteId, requestedRev, durableRev, completedAt, error? }` used identically in Tasks 7, 9, 11, 14. `VersionInfo { seq, at, sourceRev, size }` (no `text`) vs. `Version { seq, at, sourceRev, text }` kept distinct across Tasks 8, 9, 13, 19. `NoteSummary`/`Note` match `store-api.md` and are used consistently in Tasks 6, 16, 17. `ImportResult { notesAdded, notesCopied, versionsAdded, skipped }` matches across Task 13's implementation and tests. `revCounters`/`durableRevs` are declared once in Task 6 and reused (not redeclared) in Tasks 7, 9, 11, 13. `withGlobalLock` is declared once in Task 10 and reused in Task 13.
