// sync-engine.js — Pure merge logic for Heldnote Drive sync v2.
//
// ONLY pure functions: HLC stamps, three-way per-field merge, plan builder,
// sync file validation. No IO (no network, no IndexedDB, no DOM). Every
// function is deterministic given its inputs — crash recovery re-derives the
// identical plan, including identical conflict version records [C-26].

import { LIMITS } from './constants.js';

// --- Constants -------------------------------------------------------------

export const SYNC_FORMAT = 2;
export const SCHEMA_VERSION = 1;
export const CLOCK_SKEW_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const CONFLICT_PROTECTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SYNC_FILE_BYTES = 50 * 1024 * 1024;
export const STAMP_FIELDS = ['text', 'title', 'pinned', 'lifecycle'];

// --- HLC stamps [C-3/5/6] -------------------------------------------------
// { w, c, d }: wall-ms (never decreasing), counter (resets when w advances),
// deviceId. Total order: w → c → d lexicographic. Deterministic, no ties.

export function compareStamps(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.w !== b.w) return a.w - b.w;
  if (a.c !== b.c) return a.c - b.c;
  if (a.d < b.d) return -1;
  if (a.d > b.d) return 1;
  return 0;
}

export function createStamp(hlcState) {
  const now = Date.now();
  if (now > hlcState.w) {
    hlcState.w = now;
    hlcState.c = 0;
  } else {
    hlcState.c += 1;
  }
  return { w: hlcState.w, c: hlcState.c, d: hlcState.d };
}

// Advance local HLC on receiving a remote stamp. Returns true if remote.w
// is >24h ahead of local now (clock skew warning) [C-5].
export function advanceHLC(hlcState, remoteStamp) {
  if (!remoteStamp) return false;
  const skew = remoteStamp.w - Date.now();
  hlcState.w = Math.max(hlcState.w, remoteStamp.w);
  return skew > CLOCK_SKEW_THRESHOLD_MS;
}

// Lazy migration for pre-sync notes: all four fields from updatedAt [C-3].
export function migrateNoteStamps(updatedAt, deviceId) {
  const s = { w: updatedAt || 0, c: 0, d: deviceId };
  return { text: { ...s }, title: { ...s }, pinned: { ...s }, lifecycle: { ...s } };
}


// Legacy backup notes use a sentinel below every UUID-like device id, so an
// equal-wall legacy value can never outrank a real synchronized mutation.
export function legacyStamps(updatedAt) {
  return migrateNoteStamps(updatedAt, '0000');
}

// --- Hashing [C-25] --------------------------------------------------------

export async function computeTextHash(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Validation [C-29/42/43] -----------------------------------------------

function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function isValidStamp(s) {
  return Boolean(s) && typeof s === 'object'
    && isFiniteNumber(s.w) && isFiniteNumber(s.c)
    && typeof s.d === 'string' && s.d.length > 0;
}

function isValidStamps(stamps) {
  return Boolean(stamps) && typeof stamps === 'object'
    && STAMP_FIELDS.every((f) => isValidStamp(stamps[f]));
}


export function isValidSyncNote(n) {
  return Boolean(n) && typeof n === 'object' && !Array.isArray(n)
    && typeof n.id === 'string' && n.id.length > 0
    && typeof n.title === 'string' && typeof n.text === 'string'
    && isFiniteNumber(n.createdAt) && isFiniteNumber(n.updatedAt)
    && typeof n.pinned === 'boolean'
    && (n.isDeleted === undefined || n.isDeleted === 0 || n.isDeleted === 1)
    && (n.deletedAt === undefined || n.deletedAt === null || isFiniteNumber(n.deletedAt))
    && isValidStamps(n.stamps);
}


export function isValidSyncVersion(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
    && typeof v.noteId === 'string' && v.noteId.length > 0
    && isFiniteNumber(v.at) && isFiniteNumber(v.sourceRev)
    && typeof v.text === 'string' && typeof v.textHash === 'string'
    && (v.kind === undefined || typeof v.kind === 'string')
    && (v.protectedUntil === undefined || isFiniteNumber(v.protectedUntil));
}

function isValidTombstone(t) {
  return Boolean(t) && typeof t === 'object'
    && typeof t.id === 'string' && t.id.length > 0
    && isValidStamp(t.stamp);
}

// Parse + validate a sync file. Oversized notes are skipped (not rejected).
// Returns { syncFile, skippedNotes, errors }.
export function validateSyncFile(rawText) {
  const errors = [];
  const skippedNotes = [];

  const byteLen = new TextEncoder().encode(rawText).length;
  if (byteLen > MAX_SYNC_FILE_BYTES) {
    errors.push(`sync file is ${byteLen} bytes, over ${MAX_SYNC_FILE_BYTES}-byte limit`);
    return { syncFile: null, skippedNotes, errors };
  }

  let parsed;
  try { parsed = JSON.parse(rawText); } catch (_) {
    errors.push('sync file is not valid JSON');
    return { syncFile: null, skippedNotes, errors };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('sync file does not have the expected shape');
    return { syncFile: null, skippedNotes, errors };
  }
  if (!isFiniteNumber(parsed.syncFormat)) {
    errors.push('sync file is missing syncFormat');
    return { syncFile: null, skippedNotes, errors };
  }

  if (parsed.syncFormat > SYNC_FORMAT) {
    errors.push(`syncFormat ${parsed.syncFormat} is newer than ${SYNC_FORMAT}; update the app`);
    return { syncFile: null, skippedNotes, errors, code: 'update-required' };
  }
  if (!Array.isArray(parsed.notes) || !Array.isArray(parsed.versions) || !Array.isArray(parsed.tombstones)) {
    errors.push('sync file is missing notes, versions, or tombstones arrays');
    return { syncFile: null, skippedNotes, errors };
  }

  const validNotes = [];
  const noteIds = new Set();
  const skippedIds = new Set();
  for (const note of parsed.notes) {
    if (!isValidSyncNote(note)) {
      errors.push('note with missing fields or invalid stamps');
      return { syncFile: null, skippedNotes, errors };
    }
    if (noteIds.has(note.id)) {
      errors.push(`duplicate note id ${note.id}`);
      return { syncFile: null, skippedNotes, errors };
    }
    noteIds.add(note.id);
    const nb = new TextEncoder().encode(note.text).length;
    if (nb > LIMITS.MAX_NOTE_SIZE_BYTES) {
      skippedNotes.push({ id: note.id, reason: 'oversized', bytes: nb });
      skippedIds.add(note.id);
      continue;
    }
    validNotes.push(note);
  }

  const validVersions = [];
  const vKeys = new Set();
  for (const v of parsed.versions) {
    if (!isValidSyncVersion(v)) {
      errors.push('version with missing fields');
      return { syncFile: null, skippedNotes, errors };
    }
    if (skippedIds.has(v.noteId)) continue;
    const vk = `${v.noteId}\u0000${v.at}\u0000${v.sourceRev}\u0000${v.textHash}`;
    if (vKeys.has(vk)) continue;
    vKeys.add(vk);
    validVersions.push(v);
  }

  const validTombstones = [];
  const tIds = new Set();
  for (const t of parsed.tombstones) {
    if (!isValidTombstone(t)) {
      errors.push('invalid tombstone');
      return { syncFile: null, skippedNotes, errors };
    }
    if (tIds.has(t.id)) {
      const idx = validTombstones.findIndex((x) => x.id === t.id);
      if (idx >= 0 && compareStamps(t.stamp, validTombstones[idx].stamp) > 0) validTombstones[idx] = t;
      continue;
    }
    tIds.add(t.id);
    validTombstones.push(t);
  }

  return {
    syncFile: {
      syncFormat: parsed.syncFormat, schemaVersion: parsed.schemaVersion,
      writerDeviceId: parsed.writerDeviceId, writtenAt: parsed.writtenAt,
      notes: validNotes, versions: validVersions, tombstones: validTombstones,
    },
    skippedNotes, errors,
  };
}

// --- Per-field merge [C-1/2/4/47] ------------------------------------------
// Returns 'local', 'remote', or 'none'. True conflicts resolve via
// compareStamps total order — deterministic on every device [C-6].


export function mergeField(localStamp, remoteStamp, baseStamp) {
  const lc = baseStamp ? compareStamps(localStamp, baseStamp) > 0 : !!localStamp;
  const rc = baseStamp ? compareStamps(remoteStamp, baseStamp) > 0 : !!remoteStamp;
  if (!lc && !rc) return 'none';
  if (lc && !rc) return 'local';
  if (!lc && rc) return 'remote';
  return compareStamps(localStamp, remoteStamp) >= 0 ? 'local' : 'remote';
}

// Pairwise union uses the same field granularity as the three-way merge. With
// no base, both records are observations and the higher stamp wins per field.
export function mergeNotePair(a, b) {
  if (!a) return b;
  if (!b) return a;

  const merged = { ...a, stamps: { ...a.stamps } };
  if (compareStamps(b.stamps.text, a.stamps.text) > 0) {
    merged.text = b.text;
    merged.stamps.text = b.stamps.text;
  }
  if (compareStamps(b.stamps.title, a.stamps.title) > 0) {
    merged.title = b.title;
    merged.stamps.title = b.stamps.title;
  }
  if (compareStamps(b.stamps.pinned, a.stamps.pinned) > 0) {
    merged.pinned = b.pinned;
    merged.pinKey = b.pinned ? 1 : 0;
    merged.stamps.pinned = b.stamps.pinned;
  }
  if (compareStamps(b.stamps.lifecycle, a.stamps.lifecycle) > 0) {
    merged.isDeleted = b.isDeleted;
    merged.deletedAt = b.deletedAt;
    merged.stamps.lifecycle = b.stamps.lifecycle;
  }

  const created = [a.createdAt, b.createdAt].filter(Number.isFinite);
  const updated = [a.updatedAt, b.updatedAt].filter(Number.isFinite);
  merged.createdAt = created.length ? Math.min(...created) : 0;
  merged.updatedAt = updated.length ? Math.max(...updated) : 0;
  return merged;
}

// --- Merge plan [C-1/2/4/7/8/9/10/11/23/24/25/26/27/36/37/38/47] ----------

function isNewerThanBase(stamp, baseStamp) {
  if (!baseStamp) return !!stamp;
  return compareStamps(stamp, baseStamp) > 0;
}


export async function computeMergePlan({
  localNotes, localVersions, remoteNotes, remoteVersions,
  localTombstones, remoteTombstones, bases, deviceId,
  skippedNotes = [],
}) {
  const localById = new Map(localNotes.map((n) => [n.id, n]));
  const remoteById = new Map(remoteNotes.map((n) => [n.id, n]));
  const localTombById = new Map(localTombstones.map((t) => [t.id, t]));
  const remoteTombById = new Map(remoteTombstones.map((t) => [t.id, t]));
  const allIds = new Set([...localById.keys(), ...remoteById.keys(), ...localTombById.keys(), ...remoteTombById.keys()]);

  const plan = {
    noteOps: [], conflictVersions: [], remoteVersionsToImport: [],
    tombstoneWrites: [], tombstoneDeletes: [],

    mergedNotes: [], mergedTombstones: [], newBases: [], baseDeletes: [],
    clockWarning: false, skippedNotes: [...skippedNotes],
  };


  // Clock skew is a property of every remote observation, including notes or
  // tombstones that do not enter the both-sides merge branch.
  for (const note of remoteNotes) {
    for (const field of STAMP_FIELDS) {
      if (note.stamps[field].w - Date.now() > CLOCK_SKEW_THRESHOLD_MS) plan.clockWarning = true;
    }
  }
  for (const tombstone of remoteTombstones) {
    if (tombstone.stamp.w - Date.now() > CLOCK_SKEW_THRESHOLD_MS) plan.clockWarning = true;
  }

  const retentionNow = Date.now();
  const retentionCutoff = retentionNow - LIMITS.PROTECTED_RECENT_MS;
  const retainedVersion = (v) => v.protectedUntil > retentionNow || v.at >= retentionCutoff;

  const localVIds = new Set();
  for (const v of localVersions) localVIds.add(`${v.noteId}\u0000${v.at}\u0000${v.sourceRev}\u0000${v.textHash || ''}`);

  const remoteVByNote = new Map();
  for (const v of remoteVersions) {
    if (!remoteVByNote.has(v.noteId)) remoteVByNote.set(v.noteId, []);
    remoteVByNote.get(v.noteId).push(v);
  }

  // Helper: import remote versions for a note, deduped by identity.
  function importRemoteVersions(noteId) {

    for (const v of (remoteVByNote.get(noteId) || [])) {
      if (!retainedVersion(v)) continue;
      const k = `${v.noteId}\u0000${v.at}\u0000${v.sourceRev}\u0000${v.textHash}`;
      if (!localVIds.has(k)) { plan.remoteVersionsToImport.push(v); localVIds.add(k); }
    }
  }

  for (const id of allIds) {

    const local = localById.get(id);
    let remote = remoteById.get(id);
    const lt = localTombById.get(id);
    let rt = remoteTombById.get(id);
    const base = bases instanceof Map ? bases.get(id) : (bases && bases[id]);
    const bs = base ? base.stamps : null;

    // A multi-file union deliberately keeps a remote note and tombstone for
    // the same id. Resolve them here, where the three-way base is available.
    if (remote && rt) {
      if (compareStamps(rt.stamp, remote.stamps.lifecycle) > 0) {
        if (isNewerThanBase(remote.stamps.text, bs ? bs.text : null)) {
          remote = {
            ...remote,
            isDeleted: 1,
            deletedAt: rt.stamp.w,
            stamps: { ...remote.stamps, lifecycle: rt.stamp },
          };
          rt = null;
        } else {
          remote = null;
        }
      } else {
        rt = null;
      }
    }

    // -- Both tombstones, no notes --
    if (lt && rt && !local && !remote) {
      const w = compareStamps(lt.stamp, rt.stamp) >= 0 ? lt : rt;
      plan.mergedTombstones.push(w);
      if (compareStamps(rt.stamp, lt.stamp) > 0) plan.tombstoneWrites.push(rt);
      continue;
    }

    // -- Note vs tombstone [C-7/8/9/10/11/37] --
    if ((local && rt && !lt) || (remote && lt && !rt)) {
      const note = local || remote;
      const tomb = rt || lt;
      const isLocal = !!local;
      const bs = base ? base.stamps : null;
      const tombWins = compareStamps(tomb.stamp, note.stamps.lifecycle) > 0;

      if (tombWins) {
        const textDiv = isNewerThanBase(note.stamps.text, bs ? bs.text : null);
        if (textDiv) {
          // Resurrect-as-trash: note survives in Trash, tombstone dropped [C-7].
          const trashed = { ...note, isDeleted: 1, deletedAt: tomb.stamp.w, stamps: { ...note.stamps, lifecycle: tomb.stamp } };
          if (isLocal) {

            plan.noteOps.push({ noteId: id, fence: { localRev: note.localRev || 0, noteRev: note.noteRev || 0 }, action: 'update', note: trashed });
          } else {
            plan.noteOps.push({ noteId: id, fence: null, action: 'create', note: trashed });
            plan.tombstoneDeletes.push(id);
            importRemoteVersions(id);
          }
          plan.mergedNotes.push(trashed);
          plan.newBases.push({ noteId: id, stamps: trashed.stamps, textHash: await computeTextHash(trashed.text) });
        } else {
          // Purge stands.

          if (isLocal) plan.noteOps.push({ noteId: id, fence: { localRev: note.localRev || 0, noteRev: note.noteRev || 0 }, action: 'purge' });
          if (rt && !lt) plan.tombstoneWrites.push(rt);
          plan.mergedTombstones.push(tomb);
          plan.baseDeletes.push(id);
        }
      } else {
        // Note lifecycle wins → drop tombstone, keep note [C-11].
        if (lt) plan.tombstoneDeletes.push(id);
        if (!isLocal) {
          plan.noteOps.push({ noteId: id, fence: null, action: 'create', note: remote });
          importRemoteVersions(id);
        }
        plan.mergedNotes.push(note);
        plan.newBases.push({ noteId: id, stamps: note.stamps, textHash: await computeTextHash(note.text) });
      }
      continue;
    }

    // -- Note only on one side, no tombstone [C-36] --
    if (local && !remote && !rt) {
      plan.mergedNotes.push(local);
      plan.newBases.push({ noteId: id, stamps: local.stamps, textHash: await computeTextHash(local.text) });
      continue;
    }
    if (remote && !local && !lt) {
      plan.noteOps.push({ noteId: id, fence: null, action: 'create', note: remote });
      plan.mergedNotes.push(remote);
      plan.newBases.push({ noteId: id, stamps: remote.stamps, textHash: await computeTextHash(remote.text) });
      importRemoteVersions(id);
      continue;
    }

    // -- Tombstone only on one side --

    if (lt && !remote && !rt) { plan.mergedTombstones.push(lt); plan.baseDeletes.push(id); continue; }
    if (rt && !local && !lt) {
      plan.tombstoneWrites.push(rt);
      plan.mergedTombstones.push(rt);
      plan.baseDeletes.push(id);
      continue;
    }

    // -- Both sides have the note → per-field merge --
    if (local && remote) {
      const bs = base ? base.stamps : null;

      const merged = { ...local };
      const ms = { ...local.stamps };
      let hasConflict = false;
      let loserText = null;
      let loserStamp = null;
      const lost = {};

      // text
      const tr = mergeField(local.stamps.text, remote.stamps.text, bs ? bs.text : null);
      const ltc = isNewerThanBase(local.stamps.text, bs ? bs.text : null);
      const rtc = isNewerThanBase(remote.stamps.text, bs ? bs.text : null);
      const textConflict = ltc && rtc && local.text !== remote.text;
      if (tr === 'remote') {
        merged.text = remote.text; ms.text = remote.stamps.text;
        if (textConflict) { loserText = local.text; loserStamp = local.stamps.text; hasConflict = true; }
      } else if (tr === 'local' && textConflict) {
        loserText = remote.text; loserStamp = remote.stamps.text; hasConflict = true;
      }

      // title
      const tir = mergeField(local.stamps.title, remote.stamps.title, bs ? bs.title : null);
      if (tir === 'remote') {
        if (isNewerThanBase(local.stamps.title, bs ? bs.title : null)) lost.title = local.title;
        merged.title = remote.title; ms.title = remote.stamps.title;
      } else if (tir === 'local' && isNewerThanBase(remote.stamps.title, bs ? bs.title : null)) {
        lost.title = remote.title;
      }

      // pinned
      const pr = mergeField(local.stamps.pinned, remote.stamps.pinned, bs ? bs.pinned : null);
      if (pr === 'remote') {
        if (isNewerThanBase(local.stamps.pinned, bs ? bs.pinned : null)) lost.pinned = local.pinned;
        merged.pinned = remote.pinned; merged.pinKey = remote.pinned ? 1 : 0; ms.pinned = remote.stamps.pinned;
      } else if (pr === 'local' && isNewerThanBase(remote.stamps.pinned, bs ? bs.pinned : null)) {
        lost.pinned = remote.pinned;
      }

      // lifecycle
      const lr = mergeField(local.stamps.lifecycle, remote.stamps.lifecycle, bs ? bs.lifecycle : null);
      if (lr === 'remote') {
        if (isNewerThanBase(local.stamps.lifecycle, bs ? bs.lifecycle : null)) lost.lifecycle = { isDeleted: local.isDeleted, deletedAt: local.deletedAt };
        merged.isDeleted = remote.isDeleted; merged.deletedAt = remote.deletedAt; ms.lifecycle = remote.stamps.lifecycle;
      } else if (lr === 'local' && isNewerThanBase(remote.stamps.lifecycle, bs ? bs.lifecycle : null)) {
        lost.lifecycle = { isDeleted: remote.isDeleted, deletedAt: remote.deletedAt };
      }

      merged.stamps = ms;

      const updated = [local.updatedAt, remote.updatedAt].filter(Number.isFinite);
      const created = [local.createdAt, remote.createdAt].filter(Number.isFinite);
      merged.updatedAt = updated.length ? Math.max(...updated) : 0;
      merged.createdAt = created.length ? Math.min(...created) : 0;

      const needsUpdate = tr === 'remote' || tir === 'remote' || pr === 'remote' || lr === 'remote' || hasConflict;

      if (needsUpdate) plan.noteOps.push({
        noteId: id,
        fence: { localRev: local.localRev || 0, noteRev: local.noteRev || 0 },
        action: 'update',
        note: merged,
      });

      // Conflict version with deterministic identity [C-26].
      if (hasConflict && loserText !== null) {
        const lth = await computeTextHash(loserText);
        const cv = {
          noteId: id, at: loserStamp.w, sourceRev: loserStamp.c,
          textHash: lth, text: loserText, kind: 'sync-conflict',
          protectedUntil: loserStamp.w + CONFLICT_PROTECTION_MS,
          lostFields: Object.keys(lost).length > 0 ? lost : undefined,
        };
        const ik = `${id}\u0000${cv.at}\u0000${cv.sourceRev}\u0000${lth}`;
        if (!localVIds.has(ik)) { plan.conflictVersions.push(cv); localVIds.add(ik); }
      }

      plan.mergedNotes.push(merged);
      plan.newBases.push({ noteId: id, stamps: ms, textHash: await computeTextHash(merged.text) });
      importRemoteVersions(id);
      continue;
    }
  }

  // Build upload payload with all surviving versions (identity-deduped).

  const skippedIds = new Set(plan.skippedNotes.map((entry) => entry.id));
  const surv = new Set(plan.mergedNotes.filter((n) => !skippedIds.has(n.id)).map((n) => n.id));
  const upIds = new Set();
  const upVersions = [];
  function addV(v) {

    if (!surv.has(v.noteId) || !retainedVersion(v)) return;
    const k = `${v.noteId}\u0000${v.at}\u0000${v.sourceRev}\u0000${v.textHash || ''}`;
    if (upIds.has(k)) return;
    upIds.add(k);
    upVersions.push({ noteId: v.noteId, at: v.at, sourceRev: v.sourceRev, textHash: v.textHash || '', text: v.text, ...(v.kind ? { kind: v.kind } : {}), ...(v.protectedUntil !== undefined ? { protectedUntil: v.protectedUntil } : {}) });
  }
  for (const v of localVersions) addV(v);
  for (const v of remoteVersions) addV(v);
  for (const v of plan.conflictVersions) addV(v);


  plan.uploadPayload = buildUploadPayload({
    notes: plan.mergedNotes.filter((note) => !skippedIds.has(note.id)),
    versions: upVersions,
    tombstones: plan.mergedTombstones,
    deviceId,
    schemaVersion: SCHEMA_VERSION,
  });
  return plan;
}

// --- Upload payload --------------------------------------------------------

export function buildUploadPayload({ notes, versions, tombstones, deviceId, schemaVersion }) {
  return {
    syncFormat: SYNC_FORMAT, schemaVersion: schemaVersion || SCHEMA_VERSION,
    writerDeviceId: deviceId, writtenAt: Date.now(),
    notes: notes.map((n) => ({ id: n.id, title: n.title, text: n.text, createdAt: n.createdAt, updatedAt: n.updatedAt, pinned: typeof n.pinned === 'boolean' ? n.pinned : n.pinKey === 1, isDeleted: n.isDeleted || 0, deletedAt: n.deletedAt || null, stamps: n.stamps })),
    versions: versions.map((v) => ({ noteId: v.noteId, at: v.at, sourceRev: v.sourceRev, textHash: v.textHash, text: v.text, ...(v.kind ? { kind: v.kind } : {}), ...(v.protectedUntil !== undefined ? { protectedUntil: v.protectedUntil } : {}) })),
    tombstones: tombstones.map((t) => ({ id: t.id, stamp: t.stamp })),
  };
}

// --- Multi-file union [C-22/33] --------------------------------------------

export function unionSyncFiles(files) {
  if (files.length === 0) return { notes: [], versions: [], tombstones: [] };
  if (files.length === 1) return { notes: files[0].notes, versions: files[0].versions, tombstones: files[0].tombstones };


  const notesById = new Map();
  const allV = [];
  const tombsById = new Map();
  for (const f of files) {
    for (const n of f.notes) {
      notesById.set(n.id, mergeNotePair(notesById.get(n.id), n));
    }
    allV.push(...f.versions);
    for (const t of f.tombstones) {
      const existing = tombsById.get(t.id);
      if (!existing || compareStamps(t.stamp, existing.stamp) > 0) tombsById.set(t.id, t);
    }
  }
  const vIds = new Set();
  const uV = [];
  for (const v of allV) {
    if (!notesById.has(v.noteId)) continue;
    const k = `${v.noteId}\u0000${v.at}\u0000${v.sourceRev}\u0000${v.textHash}`;
    if (vIds.has(k)) continue;
    vIds.add(k);
    uV.push(v);
  }
  return { notes: Array.from(notesById.values()), versions: uV, tombstones: Array.from(tombsById.values()) };
}
