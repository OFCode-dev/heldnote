import { openDb, openTransaction, awaitTransactionComplete, requestToPromise } from './db.js';

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
