const DEFAULT_DB_NAME = 'heldnote';
const DB_VERSION = 1;

export function openDb({ name = DEFAULT_DB_NAME, version = DB_VERSION, onVersionChange } = {}) {
  return new Promise((resolve) => {
    // Test-only seam, same shape as the quota/abort faults below: force the
    // open to report an outcome other than 'ok' so the caller's storage-
    // unavailable path can be exercised. Every real outcome below is reachable
    // only from a real browser condition, so without this the in-memory
    // fallback in store.js could not be tested at all.
    if (fault && fault.openOutcome) {
      resolve({ outcome: fault.openOutcome, error: new DOMException('fault injection', 'UnknownError') });
      return;
    }

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
