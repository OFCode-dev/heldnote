import { test, assert, assertEquals } from './test-harness.js';
import {
  compareStamps, createStamp, advanceHLC, migrateNoteStamps, legacyStamps,
  mergeField, computeMergePlan, computeTextHash, validateSyncFile,

  buildUploadPayload, unionSyncFiles, mergeNotePair,
  SYNC_FORMAT, CONFLICT_PROTECTION_MS, CLOCK_SKEW_THRESHOLD_MS, STAMP_FIELDS,
} from '../sync-engine.js';

// --- Helpers ---------------------------------------------------------------

function stamp(w, c, d) { return { w, c, d }; }

function makeStamps(w, c, d) {
  const s = stamp(w, c, d);
  return { text: { ...s }, title: { ...s }, pinned: { ...s }, lifecycle: { ...s } };
}

function makeNote(id, text, stamps, ov = {}) {
  return {
    id, title: ov.title || 'Untitled.txt', text,
    createdAt: ov.createdAt || 1000, updatedAt: ov.updatedAt || stamps.text.w,
    pinned: ov.pinned || false, isDeleted: ov.isDeleted || 0,
    deletedAt: ov.deletedAt || null, localRev: ov.localRev || 0, stamps,
  };
}

function validSyncFileJSON(notes = [], versions = [], tombstones = []) {
  return JSON.stringify({ syncFormat: 2, schemaVersion: 1, writerDeviceId: 'w', writtenAt: 1, notes, versions, tombstones });
}

// --- HLC stamps ------------------------------------------------------------

test('compareStamps: orders by wall clock first', () => {
  assert(compareStamps(stamp(100, 0, 'a'), stamp(200, 0, 'a')) < 0);
  assert(compareStamps(stamp(200, 0, 'a'), stamp(100, 0, 'a')) > 0);
});

test('compareStamps: breaks ties by counter', () => {
  assert(compareStamps(stamp(100, 0, 'a'), stamp(100, 1, 'a')) < 0);
  assert(compareStamps(stamp(100, 2, 'a'), stamp(100, 1, 'a')) > 0);
});

test('compareStamps: breaks counter ties by deviceId lexicographically', () => {
  assert(compareStamps(stamp(100, 0, 'a'), stamp(100, 0, 'b')) < 0);
  assert(compareStamps(stamp(100, 0, 'z'), stamp(100, 0, 'a')) > 0);
});

test('compareStamps: equal stamps return 0', () => {
  assertEquals(compareStamps(stamp(100, 1, 'x'), stamp(100, 1, 'x')), 0);
});

test('compareStamps: null stamps are less than any real stamp', () => {
  assert(compareStamps(null, stamp(1, 0, 'a')) < 0);
  assert(compareStamps(stamp(1, 0, 'a'), null) > 0);
  assertEquals(compareStamps(null, null), 0);
});

test('createStamp: advances wall clock when Date.now is ahead', () => {
  const state = { w: 0, c: 0, d: 'dev' };
  const s = createStamp(state);
  assert(s.w > 0, 'w should be set to current time');
  assertEquals(s.c, 0);
  assertEquals(s.d, 'dev');
});

test('createStamp: bumps counter when wall clock has not advanced', () => {
  const now = Date.now();
  const state = { w: now + 10000, c: 5, d: 'dev' };
  const s = createStamp(state);
  assertEquals(s.w, now + 10000);
  assertEquals(s.c, 6);
});

test('advanceHLC: absorbs a remote wall clock value', () => {
  const state = { w: 100, c: 0, d: 'dev' };
  advanceHLC(state, stamp(5000, 0, 'other'));
  assert(state.w >= 5000, 'w must advance to at least the remote w');
});

test('advanceHLC: returns true when remote is >24h ahead (clock skew)', () => {
  const state = { w: 0, c: 0, d: 'dev' };
  const future = Date.now() + CLOCK_SKEW_THRESHOLD_MS + 1000;
  const skew = advanceHLC(state, stamp(future, 0, 'other'));
  assertEquals(skew, true);
});

test('advanceHLC: returns false for normal remote stamps', () => {
  const state = { w: 0, c: 0, d: 'dev' };
  assertEquals(advanceHLC(state, stamp(Date.now(), 0, 'x')), false);
});

test('migrateNoteStamps: creates all four fields from updatedAt', () => {
  const s = migrateNoteStamps(12345, 'dev1');
  for (const f of STAMP_FIELDS) {
    assertEquals(s[f].w, 12345);
    assertEquals(s[f].c, 0);
    assertEquals(s[f].d, 'dev1');
  }
});


test('legacyStamps: uses a sentinel below UUID device ids', () => {
  const s = legacyStamps(999);
  assertEquals(s.text.d, '0000');
});

// --- mergeField ------------------------------------------------------------

test('mergeField: both unchanged (same as base) → none', () => {
  const base = stamp(100, 0, 'a');
  assertEquals(mergeField(base, base, base), 'none');
});

test('mergeField: only local changed → local', () => {
  const base = stamp(100, 0, 'a');
  assertEquals(mergeField(stamp(200, 0, 'a'), base, base), 'local');
});

test('mergeField: only remote changed → remote', () => {
  const base = stamp(100, 0, 'a');
  assertEquals(mergeField(base, stamp(200, 0, 'b'), base), 'remote');
});

test('mergeField: both changed, local stamp higher → local', () => {
  const base = stamp(100, 0, 'a');
  assertEquals(mergeField(stamp(300, 0, 'a'), stamp(200, 0, 'b'), base), 'local');
});

test('mergeField: both changed, remote stamp higher → remote', () => {
  const base = stamp(100, 0, 'a');
  assertEquals(mergeField(stamp(200, 0, 'a'), stamp(300, 0, 'b'), base), 'remote');
});

test('mergeField: no base, both have stamps → higher wins', () => {
  assertEquals(mergeField(stamp(200, 0, 'b'), stamp(200, 0, 'a'), null), 'local');
  assertEquals(mergeField(stamp(200, 0, 'a'), stamp(200, 0, 'b'), null), 'remote');
});

test('mergeField: equal wall clock resolved deterministically by counter then deviceId [C-6]', () => {
  const a = stamp(100, 0, 'A');
  const b = stamp(100, 0, 'B');
  // 'B' > 'A' lexicographically, so b wins
  assertEquals(mergeField(a, b, null), 'remote');
  assertEquals(mergeField(b, a, null), 'local');
});

test('mergeField: tie on w and d broken by counter', () => {
  assertEquals(mergeField(stamp(100, 1, 'x'), stamp(100, 0, 'x'), null), 'local');
  assertEquals(mergeField(stamp(100, 0, 'x'), stamp(100, 1, 'x'), null), 'remote');
});

// --- computeTextHash -------------------------------------------------------

test('computeTextHash: produces a hex SHA-256 digest', async () => {
  const hash = await computeTextHash('hello');
  assertEquals(hash.length, 64);
  assert(/^[0-9a-f]+$/.test(hash), 'expected hex string');
  // Known SHA-256 of "hello"
  assertEquals(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

// --- computeMergePlan: convergence -----------------------------------------

test('edit on A, sync A, sync B → B gets A\'s text (acceptance 1)', async () => {
  const baseStamp = stamp(100, 0, 'A');
  const newStamp = stamp(200, 0, 'A');
  const base = { stamps: makeStamps(100, 0, 'A'), textHash: await computeTextHash('old') };
  const localNote = makeNote('n1', 'old', makeStamps(100, 0, 'A'), { localRev: 1 });
  const remoteNote = makeNote('n1', 'edited on A', { ...makeStamps(100, 0, 'A'), text: newStamp }, {});
  // Override remote text stamp to be newer
  remoteNote.stamps.text = newStamp;

  const plan = await computeMergePlan({
    localNotes: [localNote], localVersions: [], remoteNotes: [remoteNote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'B',
  });

  assertEquals(plan.noteOps.length, 1);
  assertEquals(plan.noteOps[0].note.text, 'edited on A');
  assertEquals(plan.conflictVersions.length, 0, 'no conflict when only one side changed');
});

test('same note edited on both → conflict version created (acceptance 2)', async () => {
  const base = { stamps: makeStamps(50, 0, 'A'), textHash: await computeTextHash('base') };
  const localNote = makeNote('n1', 'local edit', { ...makeStamps(50, 0, 'A'), text: stamp(100, 0, 'A') });
  localNote.stamps.text = stamp(100, 0, 'A');
  const remoteNote = makeNote('n1', 'remote edit', { ...makeStamps(50, 0, 'A'), text: stamp(100, 0, 'B') });
  remoteNote.stamps.text = stamp(100, 0, 'B');

  const plan = await computeMergePlan({
    localNotes: [localNote], localVersions: [], remoteNotes: [remoteNote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  // 'B' > 'A' lexicographically, so remote wins
  assertEquals(plan.noteOps[0].note.text, 'remote edit');
  assertEquals(plan.conflictVersions.length, 1);
  assertEquals(plan.conflictVersions[0].text, 'local edit');
  assertEquals(plan.conflictVersions[0].kind, 'sync-conflict');
  assert(plan.conflictVersions[0].protectedUntil > 0, 'conflict version must have protectedUntil');
});

test('A renames while B edits body → merged note has both changes (acceptance 3)', async () => {
  const base = { stamps: makeStamps(50, 0, 'A'), textHash: await computeTextHash('original') };
  const localNote = makeNote('n1', 'original', makeStamps(50, 0, 'A'), { title: 'renamed.md', localRev: 1 });
  localNote.stamps.title = stamp(200, 0, 'A');
  const remoteNote = makeNote('n1', 'edited body', makeStamps(50, 0, 'A'));
  remoteNote.stamps.text = stamp(200, 0, 'B');

  const plan = await computeMergePlan({
    localNotes: [localNote], localVersions: [], remoteNotes: [remoteNote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  const merged = plan.noteOps[0].note;
  assertEquals(merged.title, 'renamed.md', 'title from A');
  assertEquals(merged.text, 'edited body', 'text from B');
  assertEquals(plan.conflictVersions.length, 0, 'independent fields must not conflict');
});

test('remote-only note → added locally (no duplicates)', async () => {
  const remoteNote = makeNote('new1', 'hello', makeStamps(100, 0, 'B'));
  const plan = await computeMergePlan({
    localNotes: [], localVersions: [], remoteNotes: [remoteNote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map(), deviceId: 'A',
  });
  assertEquals(plan.noteOps.length, 1);
  assertEquals(plan.noteOps[0].action, 'create');
  assertEquals(plan.noteOps[0].noteId, 'new1');
  assertEquals(plan.noteOps[0].fence, null, 'no fence for a brand-new local note');
});

test('local-only note → included in upload, no local ops', async () => {
  const localNote = makeNote('loc1', 'mine', makeStamps(100, 0, 'A'), { localRev: 3 });
  const plan = await computeMergePlan({
    localNotes: [localNote], localVersions: [], remoteNotes: [],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map(), deviceId: 'A',
  });
  assertEquals(plan.noteOps.length, 0);
  assert(plan.uploadPayload.notes.some((n) => n.id === 'loc1'), 'local note must be in upload');
});

// --- Tombstones and deletion -----------------------------------------------

test('tombstone propagates from remote to local (acceptance 4 — trash)', async () => {
  const rt = { id: 'del1', stamp: stamp(300, 0, 'B') };
  const plan = await computeMergePlan({
    localNotes: [], localVersions: [], remoteNotes: [],
    remoteVersions: [], localTombstones: [], remoteTombstones: [rt],
    bases: new Map(), deviceId: 'A',
  });
  assertEquals(plan.tombstoneWrites.length, 1);
  assertEquals(plan.tombstoneWrites[0].id, 'del1');
});

test('purge-vs-edit: note survives in Trash with edited text (acceptance 4)', async () => {
  // B purges note, but A edited its text after last sync.
  const base = { stamps: makeStamps(100, 0, 'A'), textHash: await computeTextHash('old') };
  const localNote = makeNote('n1', 'freshly edited', makeStamps(100, 0, 'A'), { localRev: 5 });
  localNote.stamps.text = stamp(200, 0, 'A'); // text edited after base
  const remoteTomb = { id: 'n1', stamp: stamp(150, 0, 'B') };

  const plan = await computeMergePlan({
    localNotes: [localNote], localVersions: [], remoteNotes: [],
    remoteVersions: [], localTombstones: [], remoteTombstones: [remoteTomb],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  assertEquals(plan.noteOps.length, 1);
  assertEquals(plan.noteOps[0].action, 'update');
  assertEquals(plan.noteOps[0].note.isDeleted, 1, 'note must be trashed, not purged');
  assertEquals(plan.noteOps[0].note.text, 'freshly edited', 'edited text must survive');
  assertEquals(plan.mergedTombstones.length, 0, 'tombstone must be dropped');
});

test('restore-after-purge: note survives, tombstone dropped (acceptance 4)', async () => {
  // A purged note, but B restored it (lifecycle stamp newer than tombstone).
  const localTomb = { id: 'n1', stamp: stamp(100, 0, 'A') };
  const remoteNote = makeNote('n1', 'restored text', makeStamps(50, 0, 'B'));
  remoteNote.stamps.lifecycle = stamp(200, 0, 'B'); // restored after purge

  const plan = await computeMergePlan({
    localNotes: [], localVersions: [], remoteNotes: [remoteNote],
    remoteVersions: [], localTombstones: [localTomb], remoteTombstones: [],
    bases: new Map(), deviceId: 'A',
  });

  assertEquals(plan.tombstoneDeletes.length, 1, 'local tombstone must be deleted');
  assertEquals(plan.tombstoneDeletes[0], 'n1');
  assertEquals(plan.noteOps.length, 1);
  assertEquals(plan.noteOps[0].action, 'create', 'restored note must be created locally');
  assertEquals(plan.noteOps[0].note.text, 'restored text');
});

// --- Deterministic conflict identity / dedup [C-26] ------------------------

test('conflict version identity is deterministic: at=loser.stamps.text.w, sourceRev=loser.stamps.text.c', async () => {
  const base = { stamps: makeStamps(50, 0, 'A'), textHash: await computeTextHash('base') };
  const local = makeNote('n1', 'L', { ...makeStamps(50, 0, 'A'), text: stamp(100, 3, 'A') });
  local.stamps.text = stamp(100, 3, 'A');
  const remote = makeNote('n1', 'R', { ...makeStamps(50, 0, 'A'), text: stamp(100, 3, 'B') });
  remote.stamps.text = stamp(100, 3, 'B');

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  // 'B' > 'A' → remote wins, local text is loser
  const cv = plan.conflictVersions[0];
  assertEquals(cv.at, 100, 'at must equal loser stamp w');
  assertEquals(cv.sourceRev, 3, 'sourceRev must equal loser stamp c');
  assertEquals(cv.text, 'L');
});

test('duplicate conflict version is deduped when it already exists locally', async () => {
  const base = { stamps: makeStamps(50, 0, 'A'), textHash: await computeTextHash('base') };
  const local = makeNote('n1', 'L', makeStamps(50, 0, 'A'));
  local.stamps.text = stamp(100, 0, 'A');
  const remote = makeNote('n1', 'R', makeStamps(50, 0, 'A'));
  remote.stamps.text = stamp(100, 0, 'B');

  // Simulate that the conflict version already exists locally from a prior crash.
  const existingCVHash = await computeTextHash('L');
  const existingCV = { noteId: 'n1', at: 100, sourceRev: 0, textHash: existingCVHash, text: 'L' };

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [existingCV], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  assertEquals(plan.conflictVersions.length, 0, 'conflict version already exists locally — must be deduped');
});

test('two devices compute identical conflict versions for the same conflict (crash recovery safety)', async () => {
  const base = { stamps: makeStamps(50, 0, 'X'), textHash: await computeTextHash('base') };
  const noteA = makeNote('n1', 'textA', makeStamps(50, 0, 'X'));
  noteA.stamps.text = stamp(100, 0, 'A');
  const noteB = makeNote('n1', 'textB', makeStamps(50, 0, 'X'));
  noteB.stamps.text = stamp(100, 0, 'B');

  // Device A's perspective: local=A, remote=B
  const planA = await computeMergePlan({
    localNotes: [noteA], localVersions: [], remoteNotes: [noteB],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  // Device B's perspective: local=B, remote=A
  const planB = await computeMergePlan({
    localNotes: [noteB], localVersions: [], remoteNotes: [noteA],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'B',
  });

  // Both must converge: B wins text ('B' > 'A'), A's text is the loser.
  assertEquals(planA.conflictVersions[0].at, planB.conflictVersions[0].at);
  assertEquals(planA.conflictVersions[0].sourceRev, planB.conflictVersions[0].sourceRev);
  assertEquals(planA.conflictVersions[0].textHash, planB.conflictVersions[0].textHash);
  assertEquals(planA.conflictVersions[0].text, 'textA');
  assertEquals(planB.conflictVersions[0].text, 'textA');
});

// --- Fence [C-12/13] -------------------------------------------------------

test('fence records localRev so Apply can skip notes edited during sync (acceptance 7)', async () => {
  const base = { stamps: makeStamps(50, 0, 'A'), textHash: await computeTextHash('old') };
  const local = makeNote('n1', 'old', makeStamps(50, 0, 'A'), { localRev: 10 });
  const remote = makeNote('n1', 'remote edit', makeStamps(50, 0, 'A'));
  remote.stamps.text = stamp(200, 0, 'B');

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  assertEquals(plan.noteOps[0].fence.localRev, 10, 'fence must capture the note localRev at compute time');
});

// --- Equal wall clock (acceptance 8) ---------------------------------------

test('equal-wall-clock edits converge identically on both devices via HLC total order', async () => {
  // Both devices edit at the exact same wall ms. HLC deviceId tiebreak
  // ensures a deterministic winner — 'B' > 'A' lexicographically.
  const base = { stamps: makeStamps(50, 0, 'X'), textHash: await computeTextHash('base') };
  const local = makeNote('n1', 'devA', makeStamps(50, 0, 'X'), { localRev: 1 });
  local.stamps.text = stamp(100, 0, 'A');
  const remote = makeNote('n1', 'devB', makeStamps(50, 0, 'X'));
  remote.stamps.text = stamp(100, 0, 'B');

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  assertEquals(plan.noteOps[0].note.text, 'devB', 'device B must win (B > A lexicographically)');
  assertEquals(plan.conflictVersions[0].text, 'devA', 'device A text is the loser');
});

// --- protectedUntil on conflict versions [C-27/28] -------------------------

test('conflict version protectedUntil is at + 7 days', async () => {
  const base = { stamps: makeStamps(50, 0, 'X'), textHash: await computeTextHash('base') };
  const local = makeNote('n1', 'L', makeStamps(50, 0, 'X'));
  local.stamps.text = stamp(1000, 5, 'A');
  const remote = makeNote('n1', 'R', makeStamps(50, 0, 'X'));
  remote.stamps.text = stamp(1000, 5, 'B');

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  const cv = plan.conflictVersions[0];
  assertEquals(cv.protectedUntil, cv.at + CONFLICT_PROTECTION_MS);
});

// --- validateSyncFile ------------------------------------------------------

test('validateSyncFile: valid file passes', () => {
  const n = { id: 'n1', title: 't', text: 'x', createdAt: 1, updatedAt: 1, pinned: false, stamps: makeStamps(1, 0, 'd') };
  const raw = validSyncFileJSON([n]);
  const { syncFile, errors } = validateSyncFile(raw);
  assertEquals(errors.length, 0);
  assertEquals(syncFile.notes.length, 1);
});

test('validateSyncFile: future syncFormat rejected with "update the app"', () => {
  const raw = JSON.stringify({ syncFormat: 99, schemaVersion: 1, notes: [], versions: [], tombstones: [] });

  const { errors, code } = validateSyncFile(raw);
  assert(errors.length > 0);
  assert(errors[0].includes('update the app'));
  assertEquals(code, 'update-required');
});

test('validateSyncFile: not valid JSON rejected', () => {
  const { errors } = validateSyncFile('{{bad');
  assert(errors.length > 0);
});

test('validateSyncFile: missing stamps on note rejected', () => {
  const n = { id: 'n1', title: 't', text: 'x', createdAt: 1, updatedAt: 1, pinned: false };
  const raw = validSyncFileJSON([n]);
  const { errors } = validateSyncFile(raw);
  assert(errors.length > 0);
});

test('validateSyncFile: duplicate note id rejected', () => {
  const n = { id: 'n1', title: 't', text: 'x', createdAt: 1, updatedAt: 1, pinned: false, stamps: makeStamps(1, 0, 'd') };
  const raw = validSyncFileJSON([n, n]);
  const { errors } = validateSyncFile(raw);
  assert(errors.length > 0);
});

test('validateSyncFile: oversized note skipped (not rejected)', () => {
  const bigText = 'x'.repeat(3 * 1024 * 1024); // 3 MB > MAX_NOTE_SIZE_BYTES (2 MB)
  const n = { id: 'big', title: 't', text: bigText, createdAt: 1, updatedAt: 1, pinned: false, stamps: makeStamps(1, 0, 'd') };
  const raw = validSyncFileJSON([n]);
  const { syncFile, skippedNotes, errors } = validateSyncFile(raw);
  assertEquals(errors.length, 0, 'oversized note must not reject the file');
  assertEquals(skippedNotes.length, 1);
  assertEquals(skippedNotes[0].id, 'big');
  assertEquals(syncFile.notes.length, 0, 'oversized note must not appear in validated notes');
});

// --- unionSyncFiles --------------------------------------------------------


test('mergeNotePair: independently unions title from A and text from B', () => {
  const a = makeNote('n1', 'old', makeStamps(100, 0, 'A'), { title: 'renamed.md' });
  a.stamps.title = stamp(300, 0, 'A');
  const b = makeNote('n1', 'new body', makeStamps(100, 0, 'B'));
  b.stamps.text = stamp(300, 0, 'B');
  const merged = mergeNotePair(a, b);
  assertEquals(merged.title, 'renamed.md');
  assertEquals(merged.text, 'new body');
});

test('unionSyncFiles: merges duplicate notes per field', () => {
  const file1 = { notes: [makeNote('n1', 'old', makeStamps(100, 0, 'A'), { title: 'new-title.md' })], versions: [], tombstones: [] };
  file1.notes[0].stamps.title = stamp(300, 0, 'A');
  const file2 = { notes: [makeNote('n1', 'new', makeStamps(100, 0, 'B'))], versions: [], tombstones: [] };
  file2.notes[0].stamps.text = stamp(300, 0, 'B');
  const result = unionSyncFiles([file1, file2]);
  assertEquals(result.notes.length, 1);
  assertEquals(result.notes[0].title, 'new-title.md');
  assertEquals(result.notes[0].text, 'new');
});

test('unionSyncFiles: keeps a divergent note and tombstone for three-way resolution', () => {
  const file1 = { notes: [makeNote('n1', 'text', makeStamps(100, 0, 'A'))], versions: [], tombstones: [] };
  const file2 = { notes: [], versions: [], tombstones: [{ id: 'n1', stamp: stamp(200, 0, 'B') }] };
  const result = unionSyncFiles([file1, file2]);
  assertEquals(result.notes.length, 1);
  assertEquals(result.tombstones.length, 1);
});

// --- buildUploadPayload ----------------------------------------------------

test('buildUploadPayload includes syncFormat 2 and all merged data', () => {
  const notes = [makeNote('n1', 'text', makeStamps(100, 0, 'A'))];
  const payload = buildUploadPayload({ notes, versions: [], tombstones: [], deviceId: 'A', schemaVersion: 1 });
  assertEquals(payload.syncFormat, SYNC_FORMAT);
  assertEquals(payload.writerDeviceId, 'A');
  assertEquals(payload.notes.length, 1);
  assertEquals(payload.notes[0].id, 'n1');
});

// --- lostFields on conflict versions [C-47] --------------------------------

test('lostFields captures losing non-text field values when text also conflicts', async () => {
  const base = { stamps: makeStamps(50, 0, 'X'), textHash: await computeTextHash('base') };
  const local = makeNote('n1', 'localText', makeStamps(50, 0, 'X'), { title: 'local.md' });
  local.stamps.text = stamp(100, 0, 'A');
  local.stamps.title = stamp(100, 0, 'A'); // local renamed
  const remote = makeNote('n1', 'remoteText', makeStamps(50, 0, 'X'), { title: 'remote.md' });
  remote.stamps.text = stamp(100, 0, 'B');
  remote.stamps.title = stamp(100, 0, 'B'); // remote also renamed

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  const cv = plan.conflictVersions[0];
  assert(cv.lostFields, 'conflict version must carry lostFields');
  assert('title' in cv.lostFields, 'lostFields must include the losing title');
});

// --- Retention parity with pruneNote [live-test finding 2026-08-31] --------

test('versions older than the age window still sync while inside the newest-N count', async () => {
  const now = Date.now();
  const base = { stamps: makeStamps(now - 1000, 0, 'A'), textHash: await computeTextHash('t') };
  const note = makeNote('n1', 't', makeStamps(now - 1000, 0, 'A'), { localRev: 1 });
  // Ten versions, all 5-15 days old — far outside the 24h age window, but
  // well inside PROTECTED_RECENT_COUNT, so pruneNote would keep every one.
  const versions = [];
  for (let i = 0; i < 10; i++) {
    versions.push({ noteId: 'n1', at: now - (5 + i) * 24 * 60 * 60 * 1000, sourceRev: i, textHash: await computeTextHash('v' + i), text: 'v' + i });
  }
  const plan = await computeMergePlan({
    localNotes: [note], localVersions: versions, remoteNotes: [{ ...note }],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });
  assertEquals(plan.uploadPayload.versions.length, 10,
    'old-but-recent-by-count versions must be in the upload payload');
});

test('remote versions inside the count window import even when older than the age window', async () => {
  const now = Date.now();
  const base = { stamps: makeStamps(now - 1000, 0, 'A'), textHash: await computeTextHash('t') };
  const note = makeNote('n1', 't', makeStamps(now - 1000, 0, 'A'), { localRev: 1 });
  const remoteVersion = { noteId: 'n1', at: now - 10 * 24 * 60 * 60 * 1000, sourceRev: 3, textHash: await computeTextHash('old history'), text: 'old history' };
  const plan = await computeMergePlan({
    localNotes: [note], localVersions: [], remoteNotes: [{ ...note }],
    remoteVersions: [remoteVersion], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });
  assertEquals(plan.remoteVersionsToImport.length, 1, 'a 10-day-old remote version within the count window must import');
});

test('beyond the count window, old unprotected versions are dropped from upload', async () => {
  const now = Date.now();
  const base = { stamps: makeStamps(now - 1000, 0, 'A'), textHash: await computeTextHash('t') };
  const note = makeNote('n1', 't', makeStamps(now - 1000, 0, 'A'), { localRev: 1 });
  const versions = [];
  const total = 60; // PROTECTED_RECENT_COUNT is 50
  for (let i = 0; i < total; i++) {
    versions.push({ noteId: 'n1', at: now - (2 + i) * 24 * 60 * 60 * 1000, sourceRev: i, textHash: await computeTextHash('w' + i), text: 'w' + i });
  }
  const plan = await computeMergePlan({
    localNotes: [note], localVersions: versions, remoteNotes: [{ ...note }],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });
  assertEquals(plan.uploadPayload.versions.length, 50,
    'only the newest PROTECTED_RECENT_COUNT old versions travel');
});
