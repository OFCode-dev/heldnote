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
  legacyStamps, unionSyncFiles, syncStateSignature, getMaxSyncFileBytes,
} from './sync-engine.js';

// --- Drive transport seam --------------------------------------------------
//
// The coordinator reaches Drive only through drive(). This exists for the same
// reason db.js's fault-injection seam does: every interesting coordinator
// behaviour — a rejected remote file, an upload that must or must not happen,
// a revision mismatch, a legacy migration — is defined entirely by what the
// transport returns, and none of it is reachable from a test that can only
// talk to real Drive. drive-sync.js had no tests at all before this seam.
// Production always uses realTransport; only tests replace it.
const realTransport = {
  withToken, listAllSyncFiles, downloadSyncFileText,
  uploadSyncFile, deleteSyncFiles, listLegacyBackups, downloadLegacyBackupText,
};
let transportOverride = null;
function drive() { return transportOverride || realTransport; }

export function setSyncTransportForTests(transport) { transportOverride = transport; }
export function clearSyncTransportForTests() { transportOverride = null; }

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
    let rejectedFiles = 0;
    let remoteFilePresent = false;

    await drive().withToken(async (token) => {
      // withToken re-runs this entire callback after refreshing an expired
      // token, so everything it accumulates must be reset here rather than at
      // declaration — otherwise a partial first pass is added to a complete
      // second one and the user is told about twice as many rejected files
      // and skipped notes as exist.
      skippedNotes = [];
      invalidLegacyRecords = 0;
      rejectedFiles = 0;
      remoteFilePresent = false;
      primaryFile = null;
      extraFileIds = [];

      const syncFiles = await drive().listAllSyncFiles(token);


      if (syncFiles.length > 0) {
        const parsed = [];
        const validFileIds = new Set();
        for (const file of syncFiles) {
          const raw = await drive().downloadSyncFileText(token, file.id);
          const validation = validateSyncFile(raw);
          if (validation.code === 'update-required') {
            throw Object.assign(new Error('update required'), { code: 'update-required' });
          }
          if (validation.errors.length > 0) {
            // Counted, not just logged [D6b]: a rejected remote file is a
            // fact the user is entitled to, and it is the difference between
            // "your devices agree" and "one of them is holding garbage".
            console.warn('heldnote: sync file rejected:', validation.errors);
            rejectedFiles += 1;
            continue;
          }
          skippedNotes.push(...validation.skippedNotes);
          parsed.push(validation.syncFile);
          validFileIds.add(file.id);
          if (!primaryFile) primaryFile = file;
        }
        // remoteFilePresent means "a VALID remote sync file was read", never
        // "some file exists" [D6]. Setting it from syncFiles.length let a
        // directory of unparseable garbage stand in for a synchronized
        // remote, which then satisfied the skip-upload gate below.
        remoteFilePresent = parsed.length > 0;
        remoteState = parsed.length > 0 ? unionSyncFiles(parsed) : { notes: [], versions: [], tombstones: [] };
        extraFileIds = syncFiles
          .filter((file) => validFileIds.has(file.id) && file.id !== primaryFile?.id)
          .map((file) => file.id);
      } else {
        // Legacy migration [C-31].
        const legacyFiles = await drive().listLegacyBackups(token);
        if (legacyFiles.length > 0) {
          const legacyParsed = [];
          for (const file of legacyFiles) {
            try {
              const raw = await drive().downloadLegacyBackupText(token, file.id);
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

    // Finalize runs on BOTH exits below — after an upload, and after finding
    // the remote already holds the intended state. Both outcomes agree on the
    // same merged state, so both must record it as the new base.
    //
    // Getting this wrong is subtle and expensive: a pure-download cycle (the
    // most common cycle in a two-device product) ends with content matching,
    // so it takes the no-upload exit. If that exit skipped finalize, the
    // downloaded note would carry no sync base — and isNewerThanBase treats a
    // null base as "changed", on both sides. The next edit on the other device
    // would then fabricate a protected sync-conflict version here, for a note
    // this user never touched, and push it everywhere.
    const skippedSet = new Set(applyResult.skipped);
    // A validation-skipped (oversized) remote note has NO readable remote
    // copy agreeing with anything, so its base must not move: advancing it
    // from the local-only branch would let a later valid remote replacement
    // overwrite an unsent local edit without a conflict version
    // [final review #2]. Applies to base deletions too.
    for (const s of plan.skippedNotes) skippedSet.add(s.id);
    async function finalize(extraEntries = [], { basesFrom = 'merged' } = {}) {
      const metaEntries = [...extraEntries];
      if (basesFrom === 'remote') {
        // Size-failure path: the upload did NOT happen, so a base may only
        // record what the remote provably holds. Writing the merged stamps
        // would mark a never-uploaded local edit as agreed, and the next
        // remote edit would overwrite it with no conflict version
        // [final review #1]. Remote-confirmed bases keep divergence
        // detection alive AND keep freshly downloaded notes based.
        for (const n of plan.remoteCanonical.notes) {
          if (skippedSet.has(n.id)) continue;
          metaEntries.push({ key: `sync:${n.id}`, stamps: n.stamps, textHash: await computeTextHash(n.text ?? '') });
        }
      } else {
        for (const b of plan.newBases) {
          if (!skippedSet.has(b.noteId)) {
            metaEntries.push({ key: `sync:${b.noteId}`, stamps: b.stamps, textHash: b.textHash });
          }
        }
      }
      metaEntries.push({ key: 'lastSyncAt', value: Date.now() });
      await store.batchSetMeta(metaEntries);
      if (basesFrom !== 'remote') {
        // A base deletion encodes a tombstone the remote has agreed to.
        // Without an upload the remote confirmed nothing - delete none.
        for (const id of plan.baseDeletes) {
          if (!skippedSet.has(id)) await store.deleteMeta(`sync:${id}`);
        }
      }
      // The condition that set retry-pending no longer holds. Leaving it set
      // makes every future 'online' event fire a cycle that can never clear it.
      await store.deleteMeta('sync-retry-pending').catch(() => {});
      // If dirtyGen advanced during this run, schedule another pass [C-40].
      const currentDirtyGen = (await store.getMeta('dirtyGen')) || 0;
      if (currentDirtyGen !== dirtyGenAtStart) syncScheduled = true;
    }

    // ---- Upload decision [D6] ----
    //
    // "Synced" may mean exactly two things: the remote already holds the
    // state we intend it to hold, or the upload below succeeded. Nothing else.
    //
    // This used to be decided by counting operations to apply LOCALLY
    // (plan.noteOps and friends). That answers a different question. A device
    // that edited while the remote stood still has nothing to apply locally
    // and every reason to upload, so the gate fired on the single most common
    // case in the product: edit on your laptop, watch it go green, and the
    // text never leaves the machine. No base advanced either, so it repeated
    // forever. Compare content instead — it cannot drift from what a user
    // means by "synced".
    // Both sides of this comparison pass through the SAME canonical
    // transform (retention filter + oversized-note exclusion), built by
    // computeMergePlan as plan.remoteCanonical. Signing the raw remote here
    // instead made retention trimming look like a content difference: a
    // remote file with >50 versions on a note re-uploaded on every quiet
    // cycle, and two devices with skewed clocks could ping-pong rewrites
    // forever [D6 review C2]. Extra remote history the filter hides simply
    // stays in the file until a real change uploads.
    const intendedSignature = await syncStateSignature(plan.uploadPayload);
    const remoteSignature = await syncStateSignature(plan.remoteCanonical);
    const remoteMatchesIntended = remoteFilePresent && intendedSignature === remoteSignature;

    if (remoteMatchesIntended && extraFileIds.length === 0) {
      // The only path allowed to claim 'synced' without uploading. It still
      // finalizes — the remote provably holds the intended state, so that is
      // the agreed base.
      await finalize();
      lastAutoSyncAt = Date.now();
      emitStatus({
        state: 'synced', at: Date.now(), clockWarning,
        skippedNotes: skippedNotes.length, invalidLegacyRecords, rejectedFiles,
      });
      return;
    }

    // ---- Phase 5: Upload [C-20/21/52/53] ----
    //
    // Size guard [D6 review C3]: never upload a file that validateSyncFile
    // would reject on the next cycle - that would be a self-inflicted
    // corrupt remote, re-written on every cycle, that every device then
    // refuses to read. Measured on the EXACT serialized text that would be
    // uploaded, with the same byte accounting the validator uses. On
    // failure: no upload at all (so the loop is bounded - each cycle costs
    // one local computation and zero network writes), no 'synced' claim, a
    // durable actionable status, and everything local stays exactly as the
    // apply phase left it. Finalize still runs: bases record the merge that
    // DID happen locally, and the upload-needed decision is content-based
    // (above), so advancing bases cannot mask the pending upload - while
    // skipping finalize would leave downloaded notes baseless and fabricate
    // sync-conflict versions later, the exact regression the D6 review
    // caught once already.
    const rawPayloadText = JSON.stringify(plan.uploadPayload);
    const payloadBytes = new TextEncoder().encode(rawPayloadText).length;
    if (payloadBytes > getMaxSyncFileBytes()) {
      await finalize([], { basesFrom: 'remote' });
      emitStatus({ state: 'error', reason: 'payload-too-large', bytes: payloadBytes });
      return;
    }
    const blob = new Blob([rawPayloadText], { type: 'application/json' });
    let uploadResult = null;
    let uploadAttempts = 0;

    while (uploadAttempts < MAX_UPLOAD_RETRIES) {
      uploadAttempts += 1;
      try {
        uploadResult = await drive().withToken(async (token) => {
          return drive().uploadSyncFile(token, blob, {
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
      await drive().withToken(async (token) => {
        await drive().deleteSyncFiles(token, extraFileIds).catch(() => {});
      }, { silent }).catch(() => {});
    }

    // ---- Phase 6: Finalize [C-18/40] ----
    // headRevisionId is the only upload-specific entry; everything else is
    // shared with the no-upload exit above.
    await finalize([{ key: 'headRevisionId', value: uploadResult.headRevisionId }]);

    lastAutoSyncAt = Date.now();

    emitStatus({
      state: 'synced', at: Date.now(), clockWarning,
      skippedNotes: skippedNotes.length, invalidLegacyRecords, rejectedFiles,
    });
  } catch (error) {
    if (error.code === 'auth-needed' || error.code === 'auth-expired') {
      // Terminal for this trigger set: reconnecting provides its own
      // trigger, so a leftover retry marker would re-run a cycle that
      // cannot proceed on every 'online' event [final review #3].
      try { await store.deleteMeta('sync-retry-pending'); } catch (_) { /* best effort */ }
      emitStatus({ state: 'auth-needed' });
    } else if (error.code === 'update-required') {
      try { await store.deleteMeta('sync-retry-pending'); } catch (_) { /* best effort */ }
      // The comment here used to read "status already set" — nothing set it,
      // so the panel stayed on "Syncing…" forever while notes-ui.js already
      // had a translated string waiting for this exact shape.
      emitStatus({ state: 'error', reason: 'update-required' });
    } else {
      console.error('heldnote: sync failed', error);
      try { await store.setMeta('sync-retry-pending', { at: Date.now() }); } catch (_) {}
      emitStatus({ state: 'retry-pending' });
    }
  }
}
