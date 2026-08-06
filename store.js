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
