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
