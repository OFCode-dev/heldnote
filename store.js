import { openDb, openTransaction, awaitTransactionComplete, requestToPromise } from './db.js';
import { LIMITS } from './constants.js';

let conn = null;
let listeners = new Set();
let memoryFallback = null;
let persistRequested = false;

function emit(event) {
  for (const handler of listeners) {
    // A faulty subscriber must not be able to break a save: emit() is on
    // saveDraft's synchronous path, which is required never to throw.
    try {
      handler(event);
    } catch (error) {
      console.error('heldnote: event subscriber threw', error);
    }
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
  const result = await openDb({
    name: dbName,
    onVersionChange: () => emit({ type: 'storage-unavailable', reason: 'version-change' }),
  });

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
  // Revision bookkeeping describes the connection that is going away. Keeping
  // it would let flush() answer "already durable" from a previous database
  // after a delete/reopen or an import that reuses note ids.
  draftQueues.clear();
  revCounters.clear();
  durableRevs.clear();
  lastVersionText.clear();
  memoryOnlyText.clear();
  versionCommitsStopped = false;
  persistRequested = false;
}

async function requestPersistenceOnce() {
  if (persistRequested) return;
  persistRequested = true;
  if (!navigator.storage || !navigator.storage.persist) return;
  const granted = await navigator.storage.persist().catch(() => false);
  emit({ type: 'retention-changed', retention: granted ? 'persistent' : 'best-effort' });
}

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
  const tx = openTransaction(conn, ['notes', 'drafts'], 'readonly');
  const notesStore = tx.objectStore('notes');
  const draftsStore = tx.objectStore('drafts');
  const results = [];
  const lowerQuery = query ? query.toLowerCase() : null;

  await new Promise((resolve, reject) => {
    const req = notesStore.openCursor();
    req.onsuccess = async () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      const record = cursor.value;
      const isTrashed = record.isDeleted === 1;
      if (!includeTrashed && isTrashed) {
        cursor.continue();
        return;
      }

      // Matching covers title AND body text (PRD requirement). The title
      // check is free (already in hand from the cursor); only fall through to
      // a second store read of the draft's body when the title alone doesn't
      // satisfy the query, so a title match never pays for a drafts lookup.
      // `record.title || ''` is belt-and-braces against a record whose title is
      // not a string. parseImportFile now rejects such a file outright, but a
      // record written before that validation existed (or by any path not yet
      // imagined) would otherwise throw here — inside an async cursor handler,
      // where the throw becomes an unhandled rejection rather than reaching the
      // surrounding reject(), leaving listNotes() pending forever. A hung note
      // list is a far worse outcome than an untitled note failing to match.
      let matchesQuery = !lowerQuery || String(record.title || '').toLowerCase().includes(lowerQuery);
      if (!matchesQuery) {
        // Explicit try/catch: this handler is async, so a rejection from the
        // awaited request would otherwise become an unhandled rejection
        // instead of reaching the surrounding Promise's reject() — leaving
        // listNotes()'s own await pending forever instead of failing loudly.
        try {
          const draftRecord = await requestToPromise(draftsStore.get(record.id));
          matchesQuery = !!draftRecord && String(draftRecord.text || '').toLowerCase().includes(lowerQuery);
        } catch (error) {
          reject(error);
          return;
        }
      }

      if (matchesQuery) {
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

const revCounters = new Map();
const durableRevs = new Map();

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

// --- draft layer: serialized, coalescing writer -----------------------------
//
// At most one draft transaction per note is in flight at any time. While one is
// running, further keystrokes only replace the queued payload, so the writer
// always persists the newest text and never a stale intermediate one. Because
// an accepted revision is written on the very next turn (no debounce), the
// wall-clock budget of LIMITS.DRAFT_FLUSH_MAX_MS covers the whole path from
// saveDraft() to the transaction's `complete` event.

const draftQueues = new Map(); // noteId -> { pendingText, pendingRev, inFlight, waiters, lastFailure }

// --- quota exhaustion: prune-retry-once, then degrade -----------------------
//
// A quota-class error (QuotaExceededError, or the AbortError the fault-
// injection seam produces) gets exactly one prune-and-retry before this code
// gives up on the attempt in front of it. The two call sites degrade
// differently because the two failures mean different things:
//
//   - the DRAFT path is the one that must never silently stop working, so a
//     draft write that still fails after prune-and-retry goes memory-only for
//     that note: the in-memory buffer (memoryOnlyText) keeps the text
//     available for copy/export, ordinary 'saved' events stop, and a
//     'memory-only' event fires instead.
//   - the VERSION-COMMIT path is expendable: drafts must keep saving even
//     after history stops. A version write that still fails after retry sets
//     versionCommitsStopped so no further commitVersion() call even attempts
//     a write (it returns null immediately), and a 'quota-warning' fires once
//     at the moment history commits stop.
//
// memoryOnlyText is connection-scoped like durableRevs etc. and is cleared in
// close(); versionCommitsStopped is a whole-connection latch (once history
// commits are known to be unsalvageable for the current storage pressure,
// there is no per-note distinction worth making) and is reset in close() too.

const memoryOnlyText = new Map(); // noteId -> last text that could not be made durable
let versionCommitsStopped = false;

export function getMemoryOnlyText(noteId) {
  return memoryOnlyText.get(noteId);
}

function isQuotaError(error) {
  return Boolean(error) && (error.name === 'QuotaExceededError' || error.name === 'AbortError');
}

function queueFor(noteId) {
  let q = draftQueues.get(noteId);
  if (!q) {
    q = { pendingText: null, pendingRev: null, inFlight: false, restoring: false, waiters: [], lastFailure: null };
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
  // A newer payload is on its way, so an earlier failure no longer decides
  // anything: the write about to run can still make this text durable.
  q.lastFailure = null;

  emit({ type: 'saving', noteId: id, requestedRev: nextRev });

  // While a restore holds the lock, the payload is only queued: restoreVersion
  // starts the write itself once its own transaction has committed, so this
  // text lands on top of the restored text instead of racing it.
  if (!q.inFlight && !q.restoring) {
    runDraftWrite(id);
  }

  return nextRev;
}

function resolveWaiters(noteId, receipt) {
  const q = queueFor(noteId);
  q.lastFailure = receipt.error ? { rev: receipt.requestedRev, error: receipt.error } : null;
  const remaining = [];
  for (const waiter of q.waiters) {
    if (receipt.durableRev >= waiter.rev) {
      // The revision this caller asked about is durable, so the promise is
      // kept even if some later revision in the same batch failed.
      waiter.resolve(receipt);
    } else if (receipt.error && receipt.requestedRev >= waiter.rev) {
      // The write that failed already carried this waiter's text (coalescing
      // means a newer payload supersedes the older one), so nothing still
      // queued can make it durable. Reject rather than wait forever.
      waiter.reject(receipt.error);
    } else {
      remaining.push(waiter);
    }
  }
  q.waiters = remaining;
}

export function flush(noteId, throughRev) {
  const q = queueFor(noteId);
  const durableRev = durableRevs.get(noteId) || 0;
  if (durableRev >= throughRev) {
    // Already durable: no future transaction is left to wait on, and waiters
    // are only ever settled by one completing.
    return Promise.resolve({ noteId, requestedRev: throughRev, durableRev, completedAt: Date.now() });
  }
  if (q.lastFailure && q.lastFailure.rev >= throughRev) {
    // The write carrying this revision already failed and no newer payload has
    // been queued since, so waiting would never end.
    return Promise.reject(q.lastFailure.error);
  }
  return new Promise((resolve, reject) => {
    q.waiters.push({ rev: throughRev, resolve, reject });
  });
}

async function runDraftWrite(noteId) {
  const q = queueFor(noteId);
  q.inFlight = true;

  // Re-checked once per iteration: an iteration that started before a restore
  // took the lock is safe (its transaction was created first, so it commits
  // ahead of the restore and its text is what the restore's draft read sees),
  // but a *new* iteration started under the lock would create its transaction
  // after that draft read and before the restore's write, which is exactly the
  // interleaving that loses text. Exiting here leaves the payload in
  // pendingText with inFlight false, which is what restoreVersion's finally
  // expects to find.
  while (q.pendingText !== null && !q.restoring) {
    const text = q.pendingText;
    const rev = q.pendingRev;
    // Read at dequeue, before any await, so it names the generation this write
    // belongs to. restoreVersion() bumps the generation before opening its own
    // transaction; the comparison below is what stops a write dequeued under
    // the old generation from publishing itself over a restore.
    const generationAtQueue = currentGeneration(noteId);
    q.pendingText = null;
    q.pendingRev = null;

    const now = Date.now();

    let receipt;
    try {
      // Kept inside the try: a throw here (a non-string payload reaching
      // deriveTitle, say) would otherwise escape the loop, skipping both
      // resolveWaiters and the inFlight reset, and wedge this note's queue.
      const byteLength = new TextEncoder().encode(text).length;
      const title = deriveTitle(text);

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

      // Monotonic: a restore may already have published a higher revision, and
      // durableRevs is what flush() trusts to answer "already on disk".
      const durableRev = Math.max(durableRevs.get(noteId) || 0, rev);
      durableRevs.set(noteId, durableRev);
      memoryOnlyText.delete(noteId);
      receipt = { noteId, requestedRev: rev, durableRev, completedAt: Date.now() };
      emit({ type: 'saved', ...receipt });
    } catch (error) {
      if (isQuotaError(error)) {
        // One prune-and-retry, then the note this text belongs to goes
        // memory-only rather than looping forever against storage that is
        // still full.
        await runMaintenance().catch(() => {});
        if (currentGeneration(noteId) !== generationAtQueue) {
          // A restore won the note while maintenance ran. That is a
          // supersession, not a quota failure: the restore's text is what is
          // now current, so this stale payload must not overwrite it, and it
          // must not be reported memory-only either (memory-only exists to
          // preserve text that is otherwise about to be lost, and this text
          // is not — the restore's checkpoint already preserved it). Falls
          // through to the same save-failed reporting the generation fence
          // uses on the first attempt.
          receipt = { noteId, requestedRev: rev, durableRev: durableRevs.get(noteId) || 0, completedAt: Date.now(), error };
          emit({ type: 'save-failed', ...receipt });
        } else {
          try {
            // Recomputed rather than reused: byteLength/title above are
            // scoped to the outer try block and are not visible here.
            const retryByteLength = new TextEncoder().encode(text).length;
            const retryTitle = deriveTitle(text);
            const retryTx = openTransaction(conn, ['notes', 'drafts'], 'readwrite', { durability: 'strict' });
            retryTx.objectStore('drafts').put({ noteId, text, localRev: rev, savedAt: now, byteLength: retryByteLength });
            const retryNoteStore = retryTx.objectStore('notes');
            const retryNoteRecord = await requestToPromise(retryNoteStore.get(noteId));
            retryNoteRecord.title = retryTitle;
            retryNoteRecord.updatedAt = now;
            retryNoteRecord.localRev = rev;
            retryNoteStore.put(retryNoteRecord);
            await awaitTransactionComplete(retryTx);

            const durableRev = Math.max(durableRevs.get(noteId) || 0, rev);
            durableRevs.set(noteId, durableRev);
            memoryOnlyText.delete(noteId);
            receipt = { noteId, requestedRev: rev, durableRev, completedAt: Date.now() };
            emit({ type: 'saved', ...receipt });
          } catch (retryError) {
            memoryOnlyText.set(noteId, text);
            receipt = { noteId, requestedRev: rev, durableRev: durableRevs.get(noteId) || 0, completedAt: Date.now(), error: retryError };
            emit({ type: 'memory-only', noteId, text });
          }
        }
      } else {
        receipt = { noteId, requestedRev: rev, durableRev: durableRevs.get(noteId) || 0, completedAt: Date.now(), error };
        emit({ type: 'save-failed', ...receipt });
      }
    }

    resolveWaiters(noteId, receipt);
  }

  q.inFlight = false;
}

// --- version layer: snapshot the current draft into an immutable history ---
//
// commitVersion() flushes the draft to durability first (so sourceRev always
// names a durable revision), then snapshots the draft's current text into the
// versions store, deduping against the last-committed text so unchanged notes
// don't accumulate no-op versions. lastVersionText is connection-scoped (like
// revCounters/durableRevs) and is cleared in close().

const lastVersionText = new Map(); // noteId -> text of the newest committed version, for dedup

export async function commitVersion(id) {
  const q = queueFor(id);
  // A restore already in progress will itself commit the next version (its
  // own write, or whatever runs after it in the finally block), so there is
  // nothing useful for a routine commit to do — skip rather than contend.
  // This mirrors restoreVersion's own "restore-in-progress" check but returns
  // null instead of throwing: commitVersion is polled routinely by an idle
  // timer (Task 18) and null already means "nothing to commit right now".
  if (q.restoring) return null;
  // Once a version write has failed a prune-and-retry, history commits are
  // considered permanently unsalvageable for this connection: draft writes
  // must keep working, but there is no point contending for the lock or
  // hitting storage again on every subsequent commitVersion() call.
  if (versionCommitsStopped) return null;

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

  // Second check-and-set, synchronous (no await between them), exactly like
  // restoreVersion's own lock acquisition: a restore (or another commit) may
  // have started during the flush/draft-read above, and this is the point
  // that must not race it. nextSeq() + the write below are the vulnerable
  // "allocate a seq, then write a version record in a later transaction"
  // shape restoreVersion's lock exists to fence — commitVersion has the same
  // shape and reuses the same q.restoring flag rather than a second one.
  if (q.restoring) return null;
  q.restoring = true;
  try {
    // nextSeq() also opens a transaction scoped to 'versions', so it is
    // exposed to exactly the same fault (real quota pressure or the
    // fault-injection seam) as the write below — a quota-class failure can
    // surface there just as easily as on the put() itself. Both are folded
    // into one prune-and-retry-once attempt: on failure, anything already
    // computed (seq/at/byteLength) is stale relative to the post-prune state,
    // so the retry recomputes them rather than reusing values from a
    // transaction that never committed.
    let seq;
    let at;
    let byteLength;
    try {
      seq = await nextSeq(id);
      at = Date.now();
      byteLength = new TextEncoder().encode(draft.text).length;
      const writeTx = openTransaction(conn, ['versions'], 'readwrite', { durability: 'strict' });
      writeTx.objectStore('versions').put({ noteId: id, seq, at, sourceRev: draft.localRev, text: draft.text, byteLength });
      await awaitTransactionComplete(writeTx);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      await runMaintenance().catch(() => {});
      try {
        seq = await nextSeq(id);
        at = Date.now();
        byteLength = new TextEncoder().encode(draft.text).length;
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
    await requestPersistenceOnce();
    return { seq, at, sourceRev: draft.localRev, size: byteLength };
  } finally {
    // Released whether the write succeeded or threw, same discipline as
    // restoreVersion's finally: leaving it set would wedge the note's draft
    // queue (saveDraft's launch guard checks q.restoring too) permanently.
    q.restoring = false;
    // Same shape as restoreVersion's finally, and for the same reason: text
    // typed while the lock was held was accepted (coalesced into
    // pendingText) but never started, because saveDraft's launch guard
    // checks q.restoring. Left alone, it would sit stuck until some later,
    // unrelated saveDraft() call happened to arrive and re-trigger that
    // guard. This task's prune-and-retry can hold the lock across an extra
    // runMaintenance() pass plus a retried write — meaningfully longer than
    // a single write — which widens that window, so it is started here
    // rather than left to chance.
    if (q.pendingText !== null && !q.inFlight) {
      runDraftWrite(id);
    }
  }
}

// Ordered by the versions store's OWN primary key ([noteId, seq]), never by the
// by_note_at index. The index is ordered by `at`, so its newest record is the
// highest `seq` only while Date.now() happens to be monotonic for this note.
// Two ordinary events break that coincidence, and both silently destroy data,
// because a reused seq means put() overwrites an existing version record:
//   - a clock rollback (NTP correction, manual change) makes the next version's
//     `at` smaller than the previous one's, so the previous record stays
//     "newest" by index order and its seq is handed out again;
//   - importing a backup whose newest version carries an `at` ahead of the
//     local clock leaves that record permanently "newest" by index order, so
//     every subsequent local commit computes the same seq.
// The primary key range below is the seq order itself, so neither matters.
async function nextSeq(noteId) {
  const tx = openTransaction(conn, ['versions'], 'readonly');
  const range = IDBKeyRange.bound([noteId, -Infinity], [noteId, Infinity]);
  let maxSeq = 0;
  await new Promise((resolve, reject) => {
    const req = tx.objectStore('versions').openCursor(range, 'prev');
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

// --- restore: fenced, and never destructive --------------------------------
//
// Restoring is an edit, not a rewind: it adds versions and never removes one.
// Three hazards are handled here.
//
// A restore runs *two* transactions, and they are different ordering points.
// Keeping them straight is the whole safety argument:
//
//   - the DRAFT-READ transaction (readonly, in runRestore) decides what the
//     checkpoint captures: it sees every draft write committed before it;
//   - the WRITE transaction (readwrite, later in runRestore) decides what ends
//     up on disk: IndexedDB commits same-scope transactions in creation order,
//     so every draft write whose transaction was created earlier commits first
//     and is then overwritten by this one.
//
// A draft write is only safe when it is on the correct side of BOTH. Created
// before the draft read: its text is checkpointed into history, and the restore
// still wins the draft record. Created after the write transaction: it is an
// ordinary post-restore edit. Created *between* them, however, it is neither
// checkpointed nor kept — it commits, is reported as saved, and is then
// silently overwritten. That is the window this code has to keep empty.
//
// Three hazards follow from that:
//
// 1. Text drafted but never versioned would be overwritten, so the draft read
//    snapshots it as a pre-restore checkpoint version first.
// 2. A draft write already in flight when the lock is taken is safe by
//    construction: its transaction predates both of the restore's.
// 3. Any write that starts *after* the lock is taken could land in the unsafe
//    window between them. The `restoring` lock keeps that window empty from
//    both directions: saveDraft will not launch a new write while it is held,
//    and runDraftWrite's loop re-checks it each iteration so an already-running
//    loop stops draining instead of starting further transactions. Text is
//    still accepted and coalesced throughout; the finally block below runs
//    whatever accumulated once the restore is durable, so the edit becomes the
//    next revision on top of the restored text instead of racing it.
//
// The generation counter is kept as a second line of defence for a write that
// somehow reaches runDraftWrite across a restore boundary; note that with the
// current dequeue-then-check ordering it is not expected to fire (see report).

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

  const q = queueFor(id);
  // Taking the lock is the serialization point for concurrent restores. The
  // check and the set are adjacent and synchronous, so whichever restore's
  // flush() resolves first wins it outright; a second restore rejects rather
  // than racing. Two concurrent restores would otherwise both read currentRev
  // and both call nextSeq() before either opened its write transaction, so
  // they could compute the same seq and the later put() would overwrite the
  // earlier one's checkpoint — deleting the artifact this function exists to
  // create. The lock cannot be taken any earlier than this: the flush() above
  // needs the draft writer to keep running, which the lock now suppresses.
  if (q.restoring) {
    throw Object.assign(new Error('a restore is already in progress for this note'), { code: 'restore-in-progress' });
  }
  // Held from here until this restore is durable. Everything after this point
  // runs inside try/finally: leaving the lock set would wedge the note's queue
  // permanently, so a failed restore must still release it.
  q.restoring = true;
  noteGeneration.set(id, currentGeneration(id) + 1);

  try {
    // pendingText is deliberately left alone. Whatever is queued — typed before
    // the lock or during the restore — is deferred, not discarded, and the
    // finally below runs it on top of the restored text.
    return await runRestore(id, target, currentRev);
  } finally {
    q.restoring = false;
    // Text typed while the lock was held was queued but never started; run it
    // now, as the next revision on top of the restored text. Fire and forget,
    // exactly as saveDraft does. If a write is somehow still in flight, its own
    // loop will pick the payload up, so starting a second one would be wrong.
    if (q.pendingText !== null && !q.inFlight) {
      runDraftWrite(id);
    }
  }
}

async function runRestore(id, target, currentRev) {
  const draftTx = openTransaction(conn, ['drafts'], 'readonly');
  const currentDraft = await requestToPromise(draftTx.objectStore('drafts').get(id));

  const newestVersions = await listVersions(id, { limit: 1 });
  const newestVersionText = newestVersions.length ? (await getVersion(id, newestVersions[0].seq)).text : undefined;
  const needsCheckpoint = currentDraft.text !== newestVersionText;

  const nextRev = currentRev + 1;
  // Monotonic: currentRev was read before this restore's async work, so edits
  // that arrived meanwhile may already have claimed higher revisions. Writing
  // nextRev back unconditionally would hand the next saveDraft an already-used
  // number, and flush() for that number could then resolve off the fast path
  // for text that has not been written.
  revCounters.set(id, Math.max(revCounters.get(id) || 0, nextRev));
  // durableRevs is NOT set here. flush()'s fast path treats durableRevs as the
  // sole authority for "this revision is on disk", so setting it before the
  // transaction below actually commits would let a concurrent flush(id, nextRev)
  // resolve for a restore that hasn't happened yet. It is set after the
  // transaction completes instead, matching every other durableRevs write here.

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

  durableRevs.set(id, Math.max(durableRevs.get(id) || 0, nextRev));
  // Drain any flush() waiters this restore's own durability now covers. This
  // mirrors what every successful runDraftWrite write already does via
  // resolveWaiters(), and closes a real hang: a flush(id, rev) call that
  // registered a waiter during this restore's async window (missing the fast
  // path because durableRevs hadn't been updated yet) would otherwise sit
  // unresolved until some unrelated later draft write happened to drain it —
  // or forever, if none ever comes. Safe by construction: resolveWaiters only
  // settles waiters whose rev <= durableRev, so a waiter for a revision
  // higher than nextRev (queued during the restore, correctly deferred by
  // the generation fence, not yet actually written) is left untouched here —
  // it stays pending until its own real write completes and calls
  // resolveWaiters normally, via the deferred write this function's caller
  // (restoreVersion's finally) starts once the lock is released.
  resolveWaiters(id, { noteId: id, requestedRev: nextRev, durableRev: durableRevs.get(id), completedAt: at });
  lastVersionText.set(id, target.text);
  emit({ type: 'note-changed', noteId: id });

  return { seq: restoredSeq, at, sourceRev: nextRev, size: byteLength };
}

// --- maintenance: the pruning ladder ----------------------------------------
//
// runMaintenance() walks every note and thins its version history:
//   1. the newest PROTECTED_RECENT_COUNT versions are always kept;
//   2. every version from the last PROTECTED_RECENT_MS is always kept;
//   3. the newest version is always kept, even if 1 and 2 somehow left it out
//      (an empty history is impossible, but this is the invariant the whole
//      task exists to guarantee, so it is asserted directly rather than left
//      to fall out of 1 and 2);
//   4. everything older than that is thinned to one version per UTC day
//      (ties broken by seq, i.e. the latest version written that day wins);
//   5. all of the above is bounded by PER_NOTE_HISTORY_BYTE_BUDGET. If the
//      protected set from 1–3 alone already exceeds the budget, there is
//      nothing pruning can do without deleting a protected recovery point —
//      so this note is skipped entirely for this run (nothing is deleted,
//      not even the day-thinning that would otherwise apply) and a
//      quota-warning event is emitted instead.
//
// Each note is read and deleted in its own pair of transactions, so a crash
// or reload mid-run leaves already-pruned notes pruned and resumes cleanly on
// the rest — recomputing toDelete from scratch is always safe because it is
// derived from what is still on disk, never from what was deleted last time.
//
// v1 has no automatic trash purge — design.md is explicit that trash is
// emptied only on explicit user confirmation, overriding the looser "and the
// trash purge" wording in store-api.md. purgeNote() (Task 6) already covers
// the explicit path; nothing automatic happens here, so `purged` is always 0.

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
  // all[0] is the newest version (listVersions is newest-first): explicitly
  // protected regardless of count/age so runMaintenance can never remove it.
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
    return { pruned, purged: 0 };
  });
}

async function withGlobalLock(work) {
  return navigator.locks.request('heldnote-global', work);
}

// --- per-note locking: cross-tab mutual exclusion via Web Locks ------------
//
// Distinct from draftQueues/q.restoring above: those serialize writes within
// a single tab/connection. acquireNoteLock/releaseNoteLock instead let one
// tab claim exclusive edit access to a note while other tabs (in a later
// task) can see the lock is held and open the note read-only. Named locks
// are per-origin, not per-tab, so a second acquireNoteLock(id) call for a
// note whose lock is still held — even one issued from this same module — is
// correctly refused by the browser: nothing here needs to track "who is
// asking", only whether the named lock is free.
//
// heldLocks intentionally does NOT short-circuit a repeat acquire for a note
// this tab already holds. ifAvailable:true reports the lock as unavailable
// until the previous holder's callback promise settles, and that is exactly
// the mutual-exclusion behaviour callers depend on.

const heldLocks = new Map(); // noteId -> release function for the lock this tab holds

export async function acquireNoteLock(id) {
  const lockName = `heldnote-note-${id}`;

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
      // Held until releaseNoteLock() resolves this promise.
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

// --- backup: export / import ------------------------------------------------
//
// exportAll()/importAll() are the app's only backup mechanism in v1 (no sync).
// exportAll flushes each note's pending revision before reading it, so an
// export immediately after typing reflects the latest text rather than
// whatever was last durable. importAll validates schemaVersion/shape entirely
// before touching anything (parseImportFile runs before withGlobalLock is even
// requested), so a malformed file changes nothing. Both of importAll's modes,
// and exportAll's read-and-build phase (but NOT its flush-wait phase — see
// the comment on exportAll itself for why that split is load-bearing, not
// stylistic), hold withGlobalLock (Task 10/12), like runMaintenance, since
// all three touch every store: without it, a concurrent replace-mode
// importAll could commit mid-export, and getNote() would throw not-found for
// a note the import just deleted out from under exportAll's loop (or, if a
// note id happens to be reused, the export could silently mix pre-/post-
// import fields into one file it reports as a successful backup).
//
// The part that isn't in the brief this was written against: keeping the
// per-note in-memory bookkeeping built up over Tasks 6-11 (revCounters,
// durableRevs, draftQueues, lastVersionText, memoryOnlyText, noteGeneration)
// consistent with what importAll just put on disk.
//
//  - replace mode deletes and rewrites every note/draft/version in one
//    transaction, so every one of those Maps is reset to empty first (an
//    entry for a note id that isn't in the import now describes a note that
//    no longer exists on disk) and then reseeded per imported note from the
//    data just written: revCounters and durableRevs both to note.localRev
//    (exactly what getNote() would derive from the draft record just
//    written), and lastVersionText to the newest imported version's text, but
//    only when that text still matches the note's current draft text
//    (mirroring commitVersion's own dedup invariant — if the draft has moved
//    on from the newest version, there is nothing to dedup against yet).
//    Skipping the reseed would leave two real bugs: a subsequent saveDraft()
//    would restart numbering at rev 1 while the record on disk already
//    carries the imported localRev (harmless by itself, since draftQueues is
//    also cleared and the next write still lands, but the numbers would no
//    longer describe real history), and — the serious one — durableRevs
//    staying at 0 for that id means flush()'s fast path can never answer
//    "already durable" for the imported revision. flush() has no other path
//    that resolves without a write in flight, so a flush() call for an
//    imported note's current revision, issued before any further edit,would
//    hang forever.
//  - copy mode assigns brand-new ids alongside the existing notes, so nothing
//    existing needs clearing (its on-disk state hasn't changed) — only the
//    fresh ids need the same seeding, for the same reason.
//
// heldLocks (Web Locks a tab holds for a note it's editing) and
// versionCommitsStopped (a whole-connection quota latch) are deliberately
// left untouched by either mode: the former is about who has editing access
// right now, not about what's on disk, and the latter describes storage
// pressure, not import data.

const SCHEMA_VERSION = 1;

// The `meta` store (db.js creates it for theme/zoom/language/last-opened-note)
// has no writer yet — settings persistence is its own feature, not this one.
// Export and import carry it anyway, so that whenever that feature arrives a
// backup round-trips settings without a second change to the file format, and
// so no backup taken in the meantime silently drops data another module wrote.
async function readAllMeta() {
  const tx = openTransaction(conn, ['meta'], 'readonly');
  const entries = [];
  await new Promise((resolve, reject) => {
    const req = tx.objectStore('meta').openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      entries.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return entries;
}

export async function exportAll() {
  // Two phases, deliberately split across the lock boundary.
  //
  // Phase 1 (unlocked): flush every note with a pending revision, so the
  // export reflects the latest typed text. This CANNOT run inside
  // withGlobalLock: a flush() here waits on a draft write that, on a quota
  // fault, retries via runMaintenance() — which itself requests this same
  // 'heldnote-global' lock. Web Locks has no reentrancy: if exportAll were
  // already holding the lock while awaiting that flush(), the retry's
  // runMaintenance() call would queue behind exportAll's own hold, which is
  // itself waiting on that same retry to finish — a permanent deadlock, and
  // anything else queued on the lock (e.g. a subsequent importAll) hangs
  // behind it too. Running the flush loop before ever requesting the lock
  // means exportAll is never simultaneously holding it and blocked on a
  // promise that needs it.
  //
  // Phase 2 (locked): the read-and-build phase (getNote/listVersions/
  // getVersion/Blob construction) is what the original Critical finding was
  // actually about — a concurrent replace-mode importAll committing mid-read
  // would throw not-found for a note it just deleted, or mix pre-/post-import
  // fields into one file reported as a successful backup. importAll holds
  // this same lock for its entire write, so serializing just this phase
  // against it is sufficient, and re-fetching noteSummaries fresh INSIDE the
  // lock (rather than reusing phase 1's list) means this phase always reads
  // one consistent state — either fully pre-import or fully post-import,
  // never a stale summary list pointing at notes an import deleted during
  // the (unlocked) phase 1 flush-wait.
  const pendingSummaries = await listNotes({ includeTrashed: true, limit: 100000 });
  for (const summary of pendingSummaries) {
    const rev = revCounters.get(summary.id);
    if (rev) await flush(summary.id, rev).catch(() => {});
  }

  return withGlobalLock(async () => {
    const noteSummaries = await listNotes({ includeTrashed: true, limit: 100000 });

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

    const meta = await readAllMeta();

    const payload = { schemaVersion: SCHEMA_VERSION, exportedAt: Date.now(), notes, versions, meta };
    return new Blob([JSON.stringify(payload)], { type: 'application/json' });
  });
}

// Per-record shape validation. store-api.md promises the file is validated
// "before touching anything", but only the envelope was ever checked, so a
// hand-edited or truncated backup could write records with undefined fields —
// and an undefined `title` then hangs listNotes()'s search cursor forever.
// Every field the write paths below dereference is checked here.

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidImportedNote(note) {
  return Boolean(note) && typeof note === 'object' && !Array.isArray(note)
    && typeof note.id === 'string' && note.id.length > 0
    && typeof note.title === 'string'
    && typeof note.text === 'string'
    && isFiniteNumber(note.createdAt)
    && isFiniteNumber(note.updatedAt)
    && isFiniteNumber(note.localRev)
    && typeof note.pinned === 'boolean'
    // exportAll writes deletedAt: null for a live note; a trashed one carries a
    // timestamp; a hand-written file may omit the key entirely.
    && (note.deletedAt === undefined || note.deletedAt === null || isFiniteNumber(note.deletedAt));
}

function isValidImportedVersion(version) {
  return Boolean(version) && typeof version === 'object' && !Array.isArray(version)
    && typeof version.noteId === 'string' && version.noteId.length > 0
    && isFiniteNumber(version.seq)
    && isFiniteNumber(version.at)
    && isFiniteNumber(version.sourceRev)
    && typeof version.text === 'string';
}

function isValidImportedMetaEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.key === 'string' && entry.key.length > 0;
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
  // `meta` is optional: files written before exportAll carried settings simply
  // do not have the key, and refusing those would break every existing backup.
  const meta = parsed.meta === undefined ? [] : parsed.meta;
  if (!Array.isArray(meta)) {
    throw Object.assign(new Error('file does not have the expected shape'), { code: 'invalid-import' });
  }

  const noteIds = new Set();
  for (const note of parsed.notes) {
    if (!isValidImportedNote(note)) {
      throw Object.assign(new Error('file contains a note that is missing required fields'), { code: 'invalid-import' });
    }
    noteIds.add(note.id);
  }
  for (const version of parsed.versions) {
    if (!isValidImportedVersion(version)) {
      throw Object.assign(new Error('file contains a version that is missing required fields'), { code: 'invalid-import' });
    }
    // A version naming a note the file does not carry has nowhere to go: copy
    // mode would map it to an undefined id and abort the whole transaction on
    // a DataError, and replace mode would write an unreachable orphan record.
    if (!noteIds.has(version.noteId)) {
      throw Object.assign(new Error(`file contains a version for unknown note ${version.noteId}`), { code: 'invalid-import' });
    }
  }
  for (const entry of meta) {
    if (!isValidImportedMetaEntry(entry)) {
      throw Object.assign(new Error('file contains a settings entry that is missing required fields'), { code: 'invalid-import' });
    }
  }

  return { ...parsed, meta };
}

function noteRecordFrom(note, idOverride) {
  return {
    id: idOverride || note.id, title: note.title, createdAt: note.createdAt, updatedAt: note.updatedAt,
    localRev: note.localRev, pinned: note.pinned, pinKey: note.pinned ? 1 : 0,
    isDeleted: note.deletedAt ? 1 : 0, ...(note.deletedAt ? { deletedAt: note.deletedAt } : {}),
  };
}

// noteId -> { seq, text } of the highest-seq (newest) version in `versions`,
// used to decide what lastVersionText should be seeded to after an import.
function newestVersionTextByNoteId(versions) {
  const newest = new Map();
  for (const v of versions) {
    const current = newest.get(v.noteId);
    if (!current || v.seq > current.seq) newest.set(v.noteId, { seq: v.seq, text: v.text });
  }
  return newest;
}

// Reseeds revCounters/durableRevs/lastVersionText for one just-imported note,
// exactly mirroring what getNote() would derive from the draft record
// importAll just wrote — see the comment block above this section for why
// this is required, not optional.
function seedImportedNoteState(id, note, newestVersionText) {
  revCounters.set(id, note.localRev);
  durableRevs.set(id, note.localRev);
  if (newestVersionText !== undefined && newestVersionText === note.text) {
    lastVersionText.set(id, newestVersionText);
  }
}

export async function importAll(file, { mode }) {
  const parsed = await parseImportFile(file);

  return withGlobalLock(async () => {
    if (mode === 'replace') {
      const tx = openTransaction(conn, ['notes', 'drafts', 'versions', 'meta'], 'readwrite', { durability: 'strict' });
      tx.objectStore('notes').clear();
      tx.objectStore('drafts').clear();
      tx.objectStore('versions').clear();
      // Replace means replace: settings from the file take over wholesale, the
      // same way notes do.
      tx.objectStore('meta').clear();
      for (const entry of parsed.meta) {
        tx.objectStore('meta').put(entry);
      }
      for (const note of parsed.notes) {
        tx.objectStore('notes').put(noteRecordFrom(note));
        tx.objectStore('drafts').put({ noteId: note.id, text: note.text, localRev: note.localRev, savedAt: note.updatedAt, byteLength: new TextEncoder().encode(note.text).length });
      }
      for (const v of parsed.versions) {
        tx.objectStore('versions').put({ noteId: v.noteId, seq: v.seq, at: v.at, sourceRev: v.sourceRev, text: v.text, byteLength: new TextEncoder().encode(v.text).length });
      }
      await awaitTransactionComplete(tx);

      // A draft write genuinely in flight for some note id right now has its
      // own waiters sitting in that note's *current* draftQueues entry.
      // draftQueues.clear() below discards that entry outright; whenever that
      // in-flight write eventually settles, its own resolveWaiters() call
      // re-fetches the queue via queueFor(), which after a clear() returns a
      // brand-new, empty queue object — not the one those waiters were
      // pushed onto. Left alone, those waiters would never resolve or
      // reject. Reject them now, before the entry describing them is thrown
      // away: requestedRev: Infinity + durableRev: -Infinity forces every
      // waiter in resolveWaiters' loop into the reject branch, regardless of
      // what revision it was waiting for.
      for (const [staleNoteId, staleQueue] of draftQueues) {
        if (staleQueue.waiters.length > 0) {
          const error = Object.assign(new Error('note was replaced by an import before this write could complete'), { code: 'import-replaced' });
          resolveWaiters(staleNoteId, { noteId: staleNoteId, requestedRev: Infinity, durableRev: -Infinity, completedAt: Date.now(), error });
        }
      }

      // Every note/draft/version that existed before this transaction is gone
      // now, except whatever id happens to be reused by the import, so every
      // per-note Map is reset to empty first...
      draftQueues.clear();
      revCounters.clear();
      durableRevs.clear();
      lastVersionText.clear();
      memoryOnlyText.clear();
      noteGeneration.clear();

      // ...then reseeded per imported note from what was just written.
      const newestText = newestVersionTextByNoteId(parsed.versions);
      for (const note of parsed.notes) {
        seedImportedNoteState(note.id, note, newestText.get(note.id)?.text);
      }

      return { notesAdded: parsed.notes.length, notesCopied: 0, versionsAdded: parsed.versions.length, skipped: 0 };
    }

    const idMap = new Map();
    const tx = openTransaction(conn, ['notes', 'drafts', 'versions', 'meta'], 'readwrite', { durability: 'strict' });
    // Notes are copied alongside the existing ones, but settings are global and
    // have no "copy" — a key can hold one value. The file's entries win, which
    // is the only behaviour that makes a copy-mode import of a backup taken on
    // another device carry that device's settings across.
    for (const entry of parsed.meta) {
      tx.objectStore('meta').put(entry);
    }
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

    // Fresh ids only: every existing note's on-disk state is untouched, so
    // only the new copies need revCounters/durableRevs/lastVersionText seeded
    // to what was just written under their new id.
    const remappedVersions = parsed.versions.map((v) => ({ ...v, noteId: idMap.get(v.noteId) }));
    const newestText = newestVersionTextByNoteId(remappedVersions);
    for (const note of parsed.notes) {
      const freshId = idMap.get(note.id);
      seedImportedNoteState(freshId, note, newestText.get(freshId)?.text);
    }

    return { notesAdded: 0, notesCopied: parsed.notes.length, versionsAdded: parsed.versions.length, skipped: 0 };
  });
}
