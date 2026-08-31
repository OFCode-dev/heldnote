// sync.js — Coordinator for Heldnote Drive sync v2.
//
// Orchestrates the six sync phases (Flush → Download → Compute → Apply →
// Upload → Finalize) described in docs/SYNC-SPEC.md. No merge logic lives
// here — that is sync-engine.js. This module is the IO shell: it calls
// store.js and drive-sync.js, wires up triggers, and tracks dirty state.
//
// ============================================================================
// MANIFEST — Required-but-not-yet-existing APIs
// ============================================================================
//
// ---- drive-sync.js v2 APIs ------------------------------------------------
//
// listAllSyncFiles(token)
//   → Promise<Array<{ id: string, headRevisionId: string }>>
//   List ALL 'heldnote-sync.json' files in appDataFolder with their Drive
//   file id and headRevisionId [C-22/33].
//
// downloadSyncFileText(token, fileId)
//   → Promise<string>
//   Download raw text of a sync file by Drive file id.
//
// uploadSyncFile(token, blob, { existingFileId, knownHeadRevisionId })
//   → Promise<{ fileId: string, headRevisionId: string }>
//   Upload sync file blob. When existingFileId + knownHeadRevisionId given,
//   re-GET metadata first: if headRevisionId differs, reject with code
//   'revision-mismatch'. Return new fileId + headRevisionId [C-20/21/52/53].
//
// deleteSyncFiles(token, fileIds)
//   → Promise<void>
//   Best-effort delete of extra sync files after successful upload [C-33].
//
// listLegacyBackups(token)
//   → Promise<Array<{ id: string }>>
//   List ALL 'heldnote-backup.json' files in appDataFolder [C-31].
//
// downloadLegacyBackupText(token, fileId)
//   → Promise<string>
//   Download raw text of a legacy backup file.
//
// ---- store.js v2 APIs -----------------------------------------------------
//
// getMeta(key) → Promise<any|undefined>
//   Read a single meta entry by key.
//
// setMeta(key, value) → Promise<void>
//   Upsert a meta entry { key, ...value }.
//
// batchSetMeta(entries) → Promise<void>
//   Write multiple meta entries atomically in one transaction [C-18].
//
// deleteMeta(key) → Promise<void>
//   Delete a meta entry by key.
//
// getAllTombstones() → Promise<Array<{ id, stamp }>>
//   Read all 'tombstone:*' meta entries [C-9/10].
//
// getAllSyncBases() → Promise<Map<string, { stamps, textHash }>>
//   Read all 'sync:*' meta entries as a Map keyed by noteId [C-1].
//
// getAllNotesForSync()
//   → Promise<Array<{ id, title, text, createdAt, updatedAt, pinned,
//       isDeleted, deletedAt, localRev, stamps }>>
//   Get every note (incl. trashed) with draft text + stamps in one txn.
//
// getAllVersionsForSync()
//   → Promise<Array<{ noteId, seq, at, sourceRev, text, textHash,
//       kind?, protectedUntil?, byteLength }>>
//   Get every version record with text + textHash in one txn [C-24/25].
//
// applyMergePlan(plan)
//   → Promise<{ applied: string[], skipped: string[] }>
//   Inside withGlobalLock, one readwrite txn: per-note fence check
//   (skip if localRev > fence.localRev [C-12/13]), create/update/purge
//   notes, write conflict versions + remote versions (seq re-keyed,
//   identity-deduped), write/delete tombstones [C-49/24/25].
//   Emit 'note-changed' per touched note, 'imported' if any created.
//
// getDeviceId() → Promise<string>
//   Read or create persistent deviceId (crypto.randomUUID) [C-35].
//
// getHLCState() → Promise<{ w, c, d }>
//   Read HLC state from meta, or init { w:0, c:0, d: deviceId }.
//
// setHLCState(state) → Promise<void>
//   Persist HLC state to meta.
//
// hasMemoryOnlyNotes() → boolean
//   True if any note has un-durable memoryOnlyText pending [C-15].
//
// isMemoryFallback() → boolean
//   True if store is in memory-only mode. Sync disabled entirely [C-15].
//
// ---- store.js event (not yet emitted) -------------------------------------
//
// { type: 'sync-dirty' }
//   Emitted after every synchronized mutation (draft flush, rename, pin,
//   trash, restore, purge, restoreVersion). Coordinator bumps dirtyGen
//   and schedules a sync pass [C-39].
//
// ============================================================================

import * as store from './store.js';
import {
  isConfigured, isConnected, hasFreshToken, withToken,
  // v2 APIs — see MANIFEST above:
  listAllSyncFiles, downloadSyncFileText, uploadSyncFile,
  deleteSyncFiles, listLegacyBackups, downloadLegacyBackupText,
} from './drive-sync.js';
import {

  validateSyncFile, computeMergePlan, computeTextHash,
  legacyStamps, unionSyncFiles,
} from './sync-engine.js';

// --- Constants -------------------------------------------------------------

const DIRTY_DEBOUNCE_MS = 30_000;
const DIRTY_MIN_INTERVAL_MS = 300_000;
const VISIBILITY_THROTTLE_MS = 300_000;
const MAX_UPLOAD_RETRIES = 3;

// --- Module state ----------------------------------------------------------

let syncRunning = false;
let syncScheduled = false;
let dirtyTimer = null;
let lastAutoSyncAt = 0;
let lastVisibilitySyncAt = 0;
let statusListeners = new Set();
let currentStatus = { state: 'idle' };

let unsubscribeStore = null;
let initialized = false;

// --- Status ----------------------------------------------------------------

function emitStatus(status) {
  currentStatus = status;
  for (const h of statusListeners) {
    try { h(status); } catch (e) { console.error('heldnote: sync status listener threw', e); }
  }
}

export function getSyncStatus() { return currentStatus; }

export function onSyncStatus(handler) {
  statusListeners.add(handler);
  return () => statusListeners.delete(handler);
}

// --- Init / Destroy --------------------------------------------------------


export function initSync() {
  if (initialized) return;
  if (store.isMemoryFallback && store.isMemoryFallback()) {
    emitStatus({ state: 'disabled', reason: 'memory-mode' });
    return;
  }
  if (!isConfigured() || !isConnected()) { emitStatus({ state: 'idle' }); return; }


  initialized = true;
  unsubscribeStore = store.subscribe((event) => {
    if (event.type === 'sync-dirty') scheduleDirtySync();
  });

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnline);

  if (hasFreshToken()) {
    syncNow({ silent: true }).catch((e) => console.error('heldnote: initial sync failed', e));
  }
}


export function destroySync() {
  initialized = false;
  if (unsubscribeStore) { unsubscribeStore(); unsubscribeStore = null; }
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('online', onOnline);
  if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null; }
  syncRunning = false;
  syncScheduled = false;

  emitStatus({ state: 'idle' });
}

// --- Triggers --------------------------------------------------------------

function onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!isConfigured() || !isConnected() || !hasFreshToken()) return;
  const now = Date.now();
  if (now - lastVisibilitySyncAt < VISIBILITY_THROTTLE_MS) return;
  lastVisibilitySyncAt = now;
  syncNow({ silent: true }).catch((e) => console.error('heldnote: visibility sync failed', e));
}

async function onOnline() {
  if (!isConfigured() || !isConnected()) return;
  try {
    const pending = await store.getMeta('sync-retry-pending');
    if (pending) syncNow({ silent: true }).catch(() => {});
  } catch (_) { /* getMeta not yet implemented */ }
}

function scheduleDirtySync() {
  if (!isConfigured() || !isConnected() || !hasFreshToken()) return;
  if (dirtyTimer) clearTimeout(dirtyTimer);
  const wait = Math.max(DIRTY_DEBOUNCE_MS, lastAutoSyncAt + DIRTY_MIN_INTERVAL_MS - Date.now());
  dirtyTimer = setTimeout(() => {
    dirtyTimer = null;
    syncNow({ silent: true }).catch((e) => console.error('heldnote: dirty sync failed', e));
  }, wait);
}

// --- Coordinator -----------------------------------------------------------


export async function syncNow({ silent = false } = {}) {
  if (store.isMemoryFallback && store.isMemoryFallback()) {
    emitStatus({ state: 'disabled', reason: 'memory-mode' });
    return;
  }
  if (syncRunning) { syncScheduled = true; return; }
  syncRunning = true;
  try {
    await runSyncCycle({ silent });
  } finally {
    syncRunning = false;
    if (syncScheduled) {
      syncScheduled = false;
      syncNow({ silent: true }).catch((e) => console.error('heldnote: follow-up sync failed', e));
    }
  }
}

// --- The six-phase sync cycle ----------------------------------------------

async function runSyncCycle({ silent = false }) {
  emitStatus({ state: 'syncing' });

  try {
    // ---- Phase 1: Flush [C-15/39] ----

    await store.flushAllPending();
    if (store.hasMemoryOnlyNotes && store.hasMemoryOnlyNotes()) {
      emitStatus({ state: 'error', reason: 'memory-pending' });
      return;
    }
    const dirtyGenAtStart = (await store.getMeta('dirtyGen')) || 0;

    // ---- Phase 2: Download [C-22/31/33/41] ----
    let remoteState = null;
    let primaryFile = null;     // { id, headRevisionId } for upload guard

    let extraFileIds = [];
    let skippedNotes = [];
    let invalidLegacyRecords = 0;
    let remoteFilePresent = false;

    await withToken(async (token) => {
      const syncFiles = await listAllSyncFiles(token);


      if (syncFiles.length > 0) {
        remoteFilePresent = true;
        const parsed = [];
        const validFileIds = new Set();
        for (const file of syncFiles) {
          const raw = await downloadSyncFileText(token, file.id);
          const validation = validateSyncFile(raw);
          if (validation.code === 'update-required') {
            throw Object.assign(new Error('update required'), { code: 'update-required' });
          }
          if (validation.errors.length > 0) {
            console.warn('heldnote: sync file rejected:', validation.errors);
            continue;
          }
          skippedNotes.push(...validation.skippedNotes);
          parsed.push(validation.syncFile);
          validFileIds.add(file.id);
          if (!primaryFile) primaryFile = file;
        }
        remoteState = parsed.length > 0 ? unionSyncFiles(parsed) : { notes: [], versions: [], tombstones: [] };
        extraFileIds = syncFiles
          .filter((file) => validFileIds.has(file.id) && file.id !== primaryFile?.id)
          .map((file) => file.id);
      } else {
        // Legacy migration [C-31].
        const legacyFiles = await listLegacyBackups(token);
        if (legacyFiles.length > 0) {
          const legacyParsed = [];
          for (const file of legacyFiles) {
            try {
              const raw = await downloadLegacyBackupText(token, file.id);
              const data = JSON.parse(raw);

              if (data && Array.isArray(data.notes)) {
                const notes = [];
                for (const note of data.notes) {
                  const candidate = {
                    ...note,
                    stamps: legacyStamps(note.updatedAt),
                    pinned: note.pinned,
                    isDeleted: note.deletedAt ? 1 : 0,
                  };
                  const checked = validateSyncFile(JSON.stringify({
                    syncFormat: 2, schemaVersion: 1, notes: [candidate], versions: [], tombstones: [],
                  }));
                  if (checked.syncFile) {
                    notes.push(...checked.syncFile.notes);
                    skippedNotes.push(...checked.skippedNotes);
                  } else {
                    invalidLegacyRecords += 1;
                  }
                }
                const versions = [];
                for (const version of (Array.isArray(data.versions) ? data.versions : [])) {
                  const candidate = {
                    ...version,
                    textHash: typeof version.textHash === 'string' ? version.textHash : '',
                  };
                  const checked = validateSyncFile(JSON.stringify({
                    syncFormat: 2, schemaVersion: 1, notes: [], versions: [candidate], tombstones: [],
                  }));
                  if (checked.syncFile) versions.push(...checked.syncFile.versions);
                  else invalidLegacyRecords += 1;
                }
                legacyParsed.push({ notes, versions, tombstones: [] });
              }
            } catch (e) { console.warn('heldnote: legacy backup parse failed', e); }
          }
          remoteState = legacyParsed.length > 0 ? unionSyncFiles(legacyParsed) : null;
        }
        if (!remoteState) remoteState = { notes: [], versions: [], tombstones: [] };
      }
    }, { silent });

    // Gate: a fresh device must not upload before its first download [C-41].
    const initialScanDone = await store.getMeta('initialScanDone');
    if (!initialScanDone) {
      await store.setMeta('initialScanDone', true);
    }

    // ---- Phase 3: Compute (pure) [C-23] ----
    const deviceId = await store.getDeviceId();

    const localNotes = await store.getAllNotesForSync();
    const localVersions = await store.getAllVersionsForSync();
    const localTombstones = await store.getAllTombstones();
    const bases = await store.getAllSyncBases();


    const remoteStamps = [];
    for (const rn of remoteState.notes) {
      for (const f of ['text', 'title', 'pinned', 'lifecycle']) {
        if (rn.stamps && rn.stamps[f]) remoteStamps.push(rn.stamps[f]);
      }
    }
    for (const rt of remoteState.tombstones) if (rt.stamp) remoteStamps.push(rt.stamp);
    const absorbed = await store.absorbRemoteStamps(remoteStamps);
    if (absorbed.clockWarning) await store.setMeta('sync-clock-warning', true);

    const plan = await computeMergePlan({
      localNotes, localVersions,
      remoteNotes: remoteState.notes,
      remoteVersions: remoteState.versions,
      localTombstones,
      remoteTombstones: remoteState.tombstones,

      bases, deviceId, skippedNotes,
    });


    if (plan.clockWarning) await store.setMeta('sync-clock-warning', true);
    const clockWarning = Boolean(await store.getMeta('sync-clock-warning'));
    if (clockWarning) emitStatus({ state: 'syncing', clockWarning: true });

    // ---- Phase 4: Apply [C-12/13/14/49/51] ----

    const applyResult = await store.applyMergePlan(plan);
    if (applyResult.skipped.length > 0) syncScheduled = true;

    const planIsEmpty = plan.noteOps.length === 0
      && plan.conflictVersions.length === 0
      && plan.remoteVersionsToImport.length === 0
      && plan.tombstoneWrites.length === 0
      && plan.tombstoneDeletes.length === 0;

    if (planIsEmpty && extraFileIds.length === 0 && remoteFilePresent) {
      lastAutoSyncAt = Date.now();
      emitStatus({
        state: 'synced', at: Date.now(), clockWarning,
        skippedNotes: skippedNotes.length, invalidLegacyRecords,
      });
      return;
    }

    // ---- Phase 5: Upload [C-20/21/52/53] ----
    const blob = new Blob([JSON.stringify(plan.uploadPayload)], { type: 'application/json' });
    let uploadResult = null;
    let uploadAttempts = 0;

    while (uploadAttempts < MAX_UPLOAD_RETRIES) {
      uploadAttempts += 1;
      try {
        uploadResult = await withToken(async (token) => {
          return uploadSyncFile(token, blob, {
            existingFileId: primaryFile ? primaryFile.id : null,
            knownHeadRevisionId: primaryFile ? primaryFile.headRevisionId : null,
          });
        }, { silent });
        break;
      } catch (e) {

        if (e.code === 'revision-mismatch' && uploadAttempts < MAX_UPLOAD_RETRIES) {
          // The blob is now stale. A follow-up cycle must return to Download;
          // resending these bytes could only repeat the same failed comparison.
          console.warn('heldnote: upload revision mismatch, restarting from download');
          syncScheduled = true;
          await store.setMeta('sync-retry-pending', { at: Date.now() });
          emitStatus({ state: 'retry-pending' });
          return;
        }
        throw e;
      }
    }

    if (!uploadResult) {
      // All retries exhausted — set durable retry-pending [C-21/52].
      await store.setMeta('sync-retry-pending', { at: Date.now() });
      emitStatus({ state: 'retry-pending' });
      return;
    }

    // Clean up extra sync files only after a successful upload [C-33].
    if (extraFileIds.length > 0) {
      await withToken(async (token) => {
        await deleteSyncFiles(token, extraFileIds).catch(() => {});
      }, { silent }).catch(() => {});
    }

    // ---- Phase 6: Finalize [C-18/40] ----
    const metaEntries = [];

    const skippedSet = new Set(applyResult.skipped);
    for (const b of plan.newBases) {
      if (!skippedSet.has(b.noteId)) {
        metaEntries.push({ key: `sync:${b.noteId}`, stamps: b.stamps, textHash: b.textHash });
      }
    }
    metaEntries.push({ key: 'lastSyncAt', value: Date.now() });
    metaEntries.push({ key: 'headRevisionId', value: uploadResult.headRevisionId });

    await store.batchSetMeta(metaEntries);
    for (const id of plan.baseDeletes) {
      if (!skippedSet.has(id)) await store.deleteMeta(`sync:${id}`);
    }

    // Clear retry-pending on success.
    await store.deleteMeta('sync-retry-pending').catch(() => {});

    // If dirtyGen advanced during this run, schedule another pass [C-40].
    const currentDirtyGen = (await store.getMeta('dirtyGen')) || 0;
    if (currentDirtyGen !== dirtyGenAtStart) {
      syncScheduled = true;
    }

    lastAutoSyncAt = Date.now();

    emitStatus({
      state: 'synced', at: Date.now(), clockWarning,
      skippedNotes: skippedNotes.length, invalidLegacyRecords,
    });
  } catch (error) {
    if (error.code === 'auth-needed' || error.code === 'auth-expired') {
      emitStatus({ state: 'auth-needed' });
    } else if (error.code === 'update-required') {
      // Already handled above; status already set.
    } else {
      console.error('heldnote: sync failed', error);
      try { await store.setMeta('sync-retry-pending', { at: Date.now() }); } catch (_) {}
      emitStatus({ state: 'retry-pending' });
    }
  }
}
