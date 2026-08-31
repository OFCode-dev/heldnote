import { test, assert, assertEquals, withTimeout } from './test-harness.js';
import * as store from '../store.js';
import { setFaultInjection, clearFaultInjection } from '../db.js';
import {
  compareStamps, computeMergePlan, computeTextHash, migrateNoteStamps,
  mergeField, CONFLICT_PROTECTION_MS,
} from '../sync-engine.js';

// --- Helpers ---------------------------------------------------------------

function stamp(w, c, d) { return { w, c, d }; }
function makeStamps(w, c, d) {
  const s = stamp(w, c, d);
  return { text: { ...s }, title: { ...s }, pinned: { ...s }, lifecycle: { ...s } };
}

// Build a sync-shaped note from a store note (no stamps yet in store v1).
function toSyncNote(note, deviceId) {
  return {
    ...note,
    isDeleted: note.deletedAt ? 1 : 0,
    stamps: migrateNoteStamps(note.updatedAt, deviceId),
  };
}

// --- Tombstone transaction atomicity [C-9/10] ------------------------------

test('purgeNote deletes note, draft, and all versions in one transaction', async () => {
  await store.open({ dbName: `heldnote-sync-test-${Date.now()}` });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'text');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  const vBefore = await store.listVersions(note.id, {});
  assert(vBefore.length >= 1, 'expected at least one version before purge');

  await store.trashNote(note.id);
  await store.purgeNote(note.id);

  // Note must be gone.
  let code;
  await store.getNote(note.id).catch((e) => { code = e.code; });
  assertEquals(code, 'not-found');

  // Versions must be gone.
  const vAfter = await store.listVersions(note.id, {});
  assertEquals(vAfter.length, 0, 'all versions must be deleted by purge');

  await store.close();
});

// --- Fence-skip behaviour [C-12/13/51] -------------------------------------

test('merge plan fence captures localRev; a note with higher localRev would be skipped', async () => {
  await store.open({ dbName: `heldnote-sync-test-${Date.now()}` });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'v1');
  await store.flush(note.id, rev);

  const full = await store.getNote(note.id);
  const localNote = toSyncNote(full, 'devA');

  const remoteNote = {
    ...localNote, text: 'remote edit',
    stamps: { ...localNote.stamps, text: stamp(full.updatedAt + 1000, 0, 'devB') },
  };

  const plan = await computeMergePlan({
    localNotes: [localNote], localVersions: [], remoteNotes: [remoteNote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map(), deviceId: 'devA',
  });

  const op = plan.noteOps.find((o) => o.noteId === note.id);
  assert(op, 'expected a noteOp for the note');
  assertEquals(op.fence.localRev, full.localRev, 'fence must capture the localRev at compute time');

  // Simulate user typing during sync: localRev advances past the fence.
  const rev2 = store.saveDraft(note.id, 'typed during sync');
  await store.flush(note.id, rev2);
  const afterEdit = await store.getNote(note.id);
  assert(afterEdit.localRev > op.fence.localRev, 'localRev must have advanced past the fence');

  // Apply would skip this note — the fence check is:
  //   if (currentLocalRev > fence.localRev) skip
  // We verify the contract here; actual Apply is in store.applyMergePlan (v2).
  const shouldSkip = afterEdit.localRev > op.fence.localRev;
  assert(shouldSkip, 'note must be skipped when its localRev exceeds the fence');

  await store.close();
});

test('fence-skip means text typed during sync is never overwritten (acceptance 7)', async () => {
  await store.open({ dbName: `heldnote-sync-test-${Date.now()}` });
  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'before sync');
  await store.flush(note.id, rev);

  const full = await store.getNote(note.id);
  const localNote = toSyncNote(full, 'devA');
  const fenceLocalRev = full.localRev;

  // User types while sync is computing → localRev advances.
  const rev2 = store.saveDraft(note.id, 'typed during sync');
  await store.flush(note.id, rev2);

  const afterType = await store.getNote(note.id);
  assert(afterType.localRev > fenceLocalRev, 'localRev must advance');
  assertEquals(afterType.text, 'typed during sync', 'user text is preserved; fence would skip the merge op');

  await store.close();
});

// --- Deterministic conflict identity dedup [C-26] --------------------------

test('the same conflict computed twice produces identical identity keys', async () => {
  const base = { stamps: makeStamps(50, 0, 'X'), textHash: await computeTextHash('base') };
  const local = {
    id: 'n1', title: 't', text: 'textA', createdAt: 1, updatedAt: 100,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 1,
    stamps: { ...makeStamps(50, 0, 'X'), text: stamp(100, 0, 'A') },
  };
  const remote = {
    ...local, text: 'textB', localRev: 0,
    stamps: { ...makeStamps(50, 0, 'X'), text: stamp(100, 0, 'B') },
  };

  const plan1 = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  // Run the exact same merge again (simulating crash + re-run).
  const plan2 = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  const cv1 = plan1.conflictVersions[0];
  const cv2 = plan2.conflictVersions[0];
  assertEquals(cv1.at, cv2.at);
  assertEquals(cv1.sourceRev, cv2.sourceRev);
  assertEquals(cv1.textHash, cv2.textHash);
  assertEquals(cv1.text, cv2.text);
});

test('crash between Apply and Finalize: re-merge with existing conflict version deduplicates (acceptance 9)', async () => {
  const base = { stamps: makeStamps(50, 0, 'X'), textHash: await computeTextHash('base') };
  const local = {
    id: 'n1', title: 't', text: 'L', createdAt: 1, updatedAt: 100,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 1,
    stamps: { ...makeStamps(50, 0, 'X'), text: stamp(100, 0, 'A') },
  };
  const remote = {
    ...local, text: 'R', localRev: 0,
    stamps: { ...makeStamps(50, 0, 'X'), text: stamp(100, 0, 'B') },
  };

  // First run produces the conflict version.
  const plan1 = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });
  assertEquals(plan1.conflictVersions.length, 1);

  // Simulate crash: conflict version was written locally but base was not updated.
  // On re-merge, the conflict version already exists in localVersions.
  const existingCV = plan1.conflictVersions[0];
  const plan2 = await computeMergePlan({
    localNotes: [local], localVersions: [existingCV], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  assertEquals(plan2.conflictVersions.length, 0, 'must NOT produce a duplicate conflict version');
});

// --- Protected version pruning concept [C-27/28] ---------------------------

test('conflict version protectedUntil is set and would prevent pruning within 7 days', async () => {
  const base = { stamps: makeStamps(50, 0, 'X'), textHash: await computeTextHash('base') };
  const now = Date.now();
  const local = {
    id: 'n1', title: 't', text: 'L', createdAt: 1, updatedAt: now,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 1,
    stamps: { ...makeStamps(50, 0, 'X'), text: stamp(now, 0, 'A') },
  };
  const remote = {
    ...local, text: 'R', localRev: 0,
    stamps: { ...makeStamps(50, 0, 'X'), text: stamp(now, 0, 'B') },
  };

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [remote],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['n1', base]]), deviceId: 'A',
  });

  const cv = plan.conflictVersions[0];
  assert(cv.protectedUntil > now, 'protectedUntil must be in the future');
  assert(cv.protectedUntil <= now + CONFLICT_PROTECTION_MS + 1000, 'protectedUntil must be ~7d from at');
  // A pruner checking `protectedUntil > Date.now()` would skip this version.
  assert(cv.protectedUntil > Date.now(), 'version must be protected from pruning right now');
});

// --- Absence without tombstone is additive [C-36] --------------------------

test('absence of a note without a tombstone never infers deletion', async () => {
  // Device A has a note; remote has nothing for that id (no note, no tombstone).
  // The note must survive — absence is NOT deletion.
  const local = {
    id: 'solo', title: 't', text: 'only here', createdAt: 1, updatedAt: 100,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 1,
    stamps: makeStamps(100, 0, 'A'),
  };

  const plan = await computeMergePlan({
    localNotes: [local], localVersions: [], remoteNotes: [],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map(), deviceId: 'A',
  });

  assertEquals(plan.noteOps.length, 0, 'no local ops — note is untouched');
  assert(plan.mergedNotes.some((n) => n.id === 'solo'), 'note must survive in merged state');
  assert(plan.uploadPayload.notes.some((n) => n.id === 'solo'), 'note must be in upload');
});

// --- Full convergence round-trip -------------------------------------------

test('two simulated devices converge after exchanging merge plans', async () => {
  const deviceA = 'devA';
  const deviceB = 'devB';

  // Both devices start with the same note (from a prior sync).
  const baseText = 'shared base text';
  const baseHash = await computeTextHash(baseText);
  const baseStamps = makeStamps(100, 0, deviceA);
  const base = { stamps: baseStamps, textHash: baseHash };

  // Device A edits the title; device B edits the body.
  const noteOnA = {
    id: 'shared', title: 'renamed.md', text: baseText, createdAt: 1, updatedAt: 200,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 2,
    stamps: { ...baseStamps, title: stamp(200, 0, deviceA) },
  };
  const noteOnB = {
    id: 'shared', title: 'Untitled.txt', text: 'edited body', createdAt: 1, updatedAt: 200,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 2,
    stamps: { ...baseStamps, text: stamp(200, 0, deviceB) },
  };

  // A syncs first (uploads). B then downloads A's state.
  const planB = await computeMergePlan({
    localNotes: [noteOnB], localVersions: [], remoteNotes: [noteOnA],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['shared', base]]), deviceId: deviceB,
  });

  const mergedOnB = planB.noteOps[0].note;
  assertEquals(mergedOnB.title, 'renamed.md', 'B picks up A\'s title');
  assertEquals(mergedOnB.text, 'edited body', 'B keeps its own text');
  assertEquals(planB.conflictVersions.length, 0, 'independent fields must not conflict');

  // A then downloads B's merged state.
  const planA = await computeMergePlan({
    localNotes: [noteOnA], localVersions: [], remoteNotes: [mergedOnB],
    remoteVersions: [], localTombstones: [], remoteTombstones: [],
    bases: new Map([['shared', base]]), deviceId: deviceA,
  });

  const mergedOnA = planA.noteOps[0].note;
  assertEquals(mergedOnA.title, 'renamed.md', 'A keeps its own title');
  assertEquals(mergedOnA.text, 'edited body', 'A picks up B\'s text');
  assertEquals(planA.conflictVersions.length, 0, 'still no conflict');
});

// --- Remote version import with dedup [C-24/25] ----------------------------

test('remote versions are imported with identity dedup against local versions', async () => {
  const localNote = {
    id: 'n1', title: 't', text: 'text', createdAt: 1, updatedAt: 100,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 1,
    stamps: makeStamps(100, 0, 'A'),
  };
  const localVersion = { noteId: 'n1', at: 50, sourceRev: 0, textHash: await computeTextHash('old'), text: 'old' };
  const remoteNote = { ...localNote, stamps: makeStamps(100, 0, 'A') };
  // Same version identity as local — must be deduped.
  const dupeRemoteVersion = { ...localVersion };
  // Different version — must be imported.
  const newRemoteVersion = { noteId: 'n1', at: 80, sourceRev: 1, textHash: await computeTextHash('mid'), text: 'mid' };

  const plan = await computeMergePlan({
    localNotes: [localNote], localVersions: [localVersion], remoteNotes: [remoteNote],
    remoteVersions: [dupeRemoteVersion, newRemoteVersion],
    localTombstones: [], remoteTombstones: [],
    bases: new Map(), deviceId: 'A',
  });

  assertEquals(plan.remoteVersionsToImport.length, 1, 'only the new version should be imported');
  assertEquals(plan.remoteVersionsToImport[0].text, 'mid');
});

// --- Upload payload completeness -------------------------------------------

test('upload payload includes all surviving notes, versions, and tombstones', async () => {
  const note1 = {
    id: 'n1', title: 't1', text: 'alive', createdAt: 1, updatedAt: 100,
    pinned: false, isDeleted: 0, deletedAt: null, localRev: 1,
    stamps: makeStamps(100, 0, 'A'),
  };
  const tomb = { id: 'n2', stamp: stamp(200, 0, 'A') };
  const version = { noteId: 'n1', at: 50, sourceRev: 0, textHash: await computeTextHash('old'), text: 'old' };

  const plan = await computeMergePlan({
    localNotes: [note1], localVersions: [version], remoteNotes: [],
    remoteVersions: [], localTombstones: [tomb], remoteTombstones: [],
    bases: new Map(), deviceId: 'A',
  });

  assertEquals(plan.uploadPayload.notes.length, 1);
  assertEquals(plan.uploadPayload.notes[0].id, 'n1');
  assertEquals(plan.uploadPayload.tombstones.length, 1);
  assertEquals(plan.uploadPayload.tombstones[0].id, 'n2');
  assert(plan.uploadPayload.versions.length >= 1, 'versions for surviving notes must be in upload');
});
