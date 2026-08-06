import { openDb, openTransaction, awaitTransactionComplete, requestToPromise } from './db.js';
import { LIMITS } from './constants.js';

let conn = null;
let listeners = new Set();
let memoryFallback = null;

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
  const tx = openTransaction(conn, ['notes'], 'readonly');
  const notesStore = tx.objectStore('notes');
  const results = [];

  await new Promise((resolve, reject) => {
    const req = notesStore.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      const record = cursor.value;
      const isTrashed = record.isDeleted === 1;
      const matchesQuery = !query || record.title.toLowerCase().includes(query.toLowerCase());
      if ((includeTrashed || !isTrashed) && matchesQuery) {
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

function queueFor(noteId) {
  let q = draftQueues.get(noteId);
  if (!q) {
    q = { pendingText: null, pendingRev: null, inFlight: false, waiters: [], lastFailure: null };
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

  if (!q.inFlight) {
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

  while (q.pendingText !== null) {
    const text = q.pendingText;
    const rev = q.pendingRev;
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

// --- version layer: snapshot the current draft into an immutable history ---
//
// commitVersion() flushes the draft to durability first (so sourceRev always
// names a durable revision), then snapshots the draft's current text into the
// versions store, deduping against the last-committed text so unchanged notes
// don't accumulate no-op versions. lastVersionText is connection-scoped (like
// revCounters/durableRevs) and is cleared in close().

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
