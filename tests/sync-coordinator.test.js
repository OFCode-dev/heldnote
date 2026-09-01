// Coordinator tests for sync.js, over a fake Drive transport.
//
// Before this file, sync.js and drive-sync.js had zero test coverage: the
// suite measured the merge engine, not the feature. Everything here is a
// coordinator decision — whether an upload happens, what status is emitted,
// what meta is left behind — which is exactly the class of behaviour the
// engine tests cannot see.
//
// The transport is injected through sync.js's test seam rather than mocked at
// the network layer, so these tests exercise the real six-phase cycle against
// the real store and a Drive that behaves like Drive.

import { test, assert, assertEquals } from './test-harness.js';
import * as store from '../store.js';
import * as sync from '../sync.js';
import { buildUploadPayload, setMaxSyncFileBytesForTests } from '../sync-engine.js';
import { LIMITS } from '../constants.js';

// --- Fake Drive ------------------------------------------------------------

function makeFakeDrive() {
  const state = {
    files: [],              // [{ id, headRevisionId }]
    contents: new Map(),    // fileId -> raw JSON text
    uploads: [],            // [{ text, existingFileId, knownHeadRevisionId }]
    deletes: [],
    revCounter: 0,
    legacy: [],             // [{ id, text }]
  };

  const transport = {
    withToken: async (work) => work('fake-token'),

    listAllSyncFiles: async () =>
      state.files.map((f) => ({ id: f.id, headRevisionId: f.headRevisionId })),

    downloadSyncFileText: async (_token, fileId) => {
      if (!state.contents.has(fileId)) throw new Error(`fake drive: no file ${fileId}`);
      return state.contents.get(fileId);
    },

    uploadSyncFile: async (_token, blob, { existingFileId, knownHeadRevisionId } = {}) => {
      const text = await blob.text();
      state.uploads.push({ text, existingFileId, knownHeadRevisionId });
      // Mirror Drive's head-revision guard as closely as Drive allows.
      if (existingFileId) {
        const current = state.files.find((f) => f.id === existingFileId);
        if (current && knownHeadRevisionId && current.headRevisionId !== knownHeadRevisionId) {
          throw Object.assign(new Error('revision mismatch'), { code: 'revision-mismatch' });
        }
      }
      const id = existingFileId || `file-${state.files.length + 1}`;
      state.revCounter += 1;
      const headRevisionId = `rev-${state.revCounter}`;
      state.contents.set(id, text);
      const existing = state.files.find((f) => f.id === id);
      if (existing) existing.headRevisionId = headRevisionId;
      else state.files.push({ id, headRevisionId });
      return { fileId: id, headRevisionId };
    },

    deleteSyncFiles: async (_token, fileIds) => {
      state.deletes.push(...fileIds);
      state.files = state.files.filter((f) => !fileIds.includes(f.id));
      for (const id of fileIds) state.contents.delete(id);
    },

    listLegacyBackups: async () => state.legacy.map((f) => ({ id: f.id })),
    downloadLegacyBackupText: async (_token, fileId) => {
      const found = state.legacy.find((f) => f.id === fileId);
      if (!found) throw new Error(`fake drive: no legacy file ${fileId}`);
      return found.text;
    },
  };

  return { state, transport };
}

async function openScenario() {
  const dbName = `heldnote-coord-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.open({ dbName });
  const fake = makeFakeDrive();
  sync.setSyncTransportForTests(fake.transport);
  return fake;
}

async function closeScenario() {
  sync.clearSyncTransportForTests();
  sync.destroySync();
  await store.close();
}

// Establishes the precondition the regression is about: one note, already
// uploaded once, so a valid remote sync file exists and local and remote
// share a sync base.
async function syncedPair() {
  const fake = await openScenario();

  const note = await store.createNote();
  const rev = store.saveDraft(note.id, 'v1');
  await store.flush(note.id, rev);
  await store.commitVersion(note.id);

  // First cycle: no remote file yet, so the coordinator must create one.
  await sync.syncNow();
  assertEquals(fake.state.uploads.length, 1, 'first sync must upload — there is no remote file yet');
  assertEquals(fake.state.files.length, 1, 'first sync must leave exactly one remote sync file');

  return { note, fake };
}

// --- The regression [D6] ---------------------------------------------------

test('a cycle with no local or remote change reports synced without uploading', async () => {
  const { fake } = await syncedPair();
  try {
    const before = fake.state.uploads.length;
    await sync.syncNow();
    assertEquals(fake.state.uploads.length - before, 0,
      'an unchanged library must not re-upload');
    assertEquals(sync.getSyncStatus().state, 'synced');
  } finally {
    await closeScenario();
  }
});

test('sync-retry-pending is cleared when a cycle finds the remote already in sync', async () => {
  const { fake } = await syncedPair();
  try {
    await store.setMeta('sync-retry-pending', { at: Date.now() });
    const before = fake.state.uploads.length;

    await sync.syncNow();

    assertEquals(fake.state.uploads.length - before, 0, 'nothing changed, so nothing to upload');
    assert(!(await store.getMeta('sync-retry-pending')),
      'a cycle that confirms the remote is in sync must clear retry-pending, '
      + 'or every future online event fires a cycle that can never clear it');
  } finally {
    await closeScenario();
  }
});

test('a remote of only unreadable files is not treated as a synchronized remote', async () => {
  const fake = await openScenario();
  try {
    const note = await store.createNote();
    const rev = store.saveDraft(note.id, 'text that must survive a corrupt remote');
    await store.flush(note.id, rev);

    // A file exists, but it cannot be parsed. Existence is not synchronization.
    fake.state.files.push({ id: 'corrupt-1', headRevisionId: 'rev-x' });
    fake.state.contents.set('corrupt-1', '{ this is not valid json');

    await sync.syncNow();

    assertEquals(fake.state.uploads.length, 1,
      'an unreadable remote must not satisfy the skip-upload gate');
    const status = sync.getSyncStatus();
    assertEquals(status.state, 'synced');
    assertEquals(status.rejectedFiles, 1, 'the rejected file must be surfaced, not only logged');
    assert(fake.state.contents.has('corrupt-1'), 'a file that failed to parse must never be deleted');
  } finally {
    await closeScenario();
  }
});

// --- Base advancement on the no-upload path [D6 regression] ----------------
//
// The most common cycle in a two-device product is a pure download: this
// device has never seen the note, applies it, and now holds exactly what the
// remote holds. Content matches, so the upload is correctly skipped — but the
// cycle must still record the agreed base. A note with no sync base is read
// as "changed on both sides" forever after (isNewerThanBase returns true when
// the base is null), so the next edit on the OTHER device fabricates a
// protected sync-conflict version here, for a note this user never touched,
// and pushes it to every device.
test('a pure-download cycle records a sync base for the note it imported', async () => {
  const { note, fake } = await syncedPair();
  const publishedJson = fake.state.contents.get('file-1');
  await closeScenario();

  // A second device: a fresh store that has never seen this note.
  const fakeB = await openScenario();
  fakeB.state.files.push({ id: 'file-1', headRevisionId: 'rev-1' });
  fakeB.state.contents.set('file-1', publishedJson);
  try {
    await sync.syncNow();

    const imported = await store.getNote(note.id);
    assertEquals(imported.text, 'v1', 'the note must actually be downloaded');

    const bases = await store.getAllSyncBases();
    assert(bases.has(note.id),
      'a downloaded note must get a sync base, or the next remote edit fabricates '
      + 'a sync-conflict version for a note this device never edited');
  } finally {
    await closeScenario();
  }
});

// The case that isolates remoteFilePresent from the signature comparison.
// With notes present, differing signatures already force an upload, so the
// flag's semantics never come under load. With an empty library BOTH
// signatures are the empty-state hash, and the flag is the only thing left
// deciding whether an unreadable remote counts as "your devices agree".
test('an empty library plus an unreadable remote is not reported as a clean sync', async () => {
  const fake = await openScenario();
  try {
    fake.state.files.push({ id: 'corrupt-1', headRevisionId: 'rev-x' });
    fake.state.contents.set('corrupt-1', '{ this is not valid json');

    await sync.syncNow();

    assertEquals(fake.state.uploads.length, 1,
      'an unreadable remote must not stand in for a valid synchronized remote, '
      + 'even when there is nothing local to send');
    assertEquals(sync.getSyncStatus().rejectedFiles, 1,
      'the user must be told a Drive file could not be read');
    assert(fake.state.contents.has('corrupt-1'), 'a file that failed to parse must never be deleted');
  } finally {
    await closeScenario();
  }
});

// withToken re-runs its whole callback after refreshing an expired token
// (drive-sync.js). Phase 2's counters live outside that callback, so a
// partial first pass must not be added to a complete second one.
test('counters are not double-counted when the token refreshes mid-download', async () => {
  const fake = await openScenario();
  try {
    const note = await store.createNote();
    const rev = store.saveDraft(note.id, 'local text');
    await store.flush(note.id, rev);

    fake.state.files.push({ id: 'corrupt-1', headRevisionId: 'rev-x' });
    fake.state.contents.set('corrupt-1', '{ not valid json');
    fake.state.files.push({ id: 'good-1', headRevisionId: 'rev-y' });
    fake.state.contents.set('good-1', JSON.stringify({
      syncFormat: 2, schemaVersion: 1, writerDeviceId: 'other', writtenAt: 1,
      notes: [], versions: [], tombstones: [],
    }));

    // Expire the token exactly once, after the corrupt file has been counted.
    let expired = false;
    const realDownload = fake.transport.downloadSyncFileText;
    fake.transport.downloadSyncFileText = async (token, fileId) => {
      if (!expired && fileId === 'good-1') {
        expired = true;
        throw Object.assign(new Error('token expired'), { code: 'auth-expired' });
      }
      return realDownload(token, fileId);
    };
    fake.transport.withToken = async (work) => {
      try { return await work('stale-token'); } catch (e) {
        if (e.code === 'auth-expired') return work('fresh-token');
        throw e;
      }
    };

    await sync.syncNow();

    assertEquals(sync.getSyncStatus().rejectedFiles, 1,
      'one unreadable file is one unreadable file, however many times the '
      + 'download phase had to restart');
  } finally {
    await closeScenario();
  }
});

test('an unsupported future sync format surfaces update-required instead of staying on syncing', async () => {
  const fake = await openScenario();
  try {
    const note = await store.createNote();
    const rev = store.saveDraft(note.id, 'local text');
    await store.flush(note.id, rev);

    fake.state.files.push({ id: 'future-1', headRevisionId: 'rev-y' });
    fake.state.contents.set('future-1', JSON.stringify({
      syncFormat: 3, schemaVersion: 1, notes: [], versions: [], tombstones: [],
    }));

    await sync.syncNow();

    const status = sync.getSyncStatus();
    assertEquals(status.state, 'error');
    assertEquals(status.reason, 'update-required');
    assertEquals(fake.state.uploads.length, 0,
      'a client that cannot read the remote format must not overwrite it');
  } finally {
    await closeScenario();
  }
});

test('a local-only edit after the first sync uploads instead of reporting synced', async () => {
  const { note, fake } = await syncedPair();
  try {
    // The local device edits. Remote is untouched, so the merge plan has
    // nothing to APPLY LOCALLY — which is exactly the condition planIsEmpty
    // tests, and the reason the coordinator wrongly short-circuits.
    const rev = store.saveDraft(note.id, 'v2 — the edit that must reach Drive');
    await store.flush(note.id, rev);
    await store.commitVersion(note.id);

    const before = fake.state.uploads.length;
    await sync.syncNow();
    const uploaded = fake.state.uploads.length - before;

    assertEquals(uploaded, 1,
      'a local edit must be uploaded before the coordinator may report synced');

    const remote = JSON.parse(fake.state.contents.get('file-1'));
    const remoteNote = remote.notes.find((n) => n.id === note.id);
    assert(remoteNote, 'the edited note must be present in the remote sync file');
    assertEquals(remoteNote.text, 'v2 — the edit that must reach Drive',
      'the remote sync file must carry the edited text');
    assertEquals(sync.getSyncStatus().state, 'synced');
  } finally {
    await closeScenario();
  }
});

// --- C2: retention/signature symmetry [D6 review] ---------------------------

test('a remote file carrying more history than retention keeps is not re-uploaded on quiet cycles', async () => {
  const fake = await openScenario();
  try {
    // A remote file whose note has PROTECTED_RECENT_COUNT + 10 versions, all
    // days outside the 24h age window. Retention will trim both the import
    // and any intended payload to the newest 50 — so a device whose content
    // matches the remote must NOT see the trimming as a difference and
    // rewrite the file (with skewed clocks on two devices, that rewrite
    // becomes a ping-pong).
    const now = Date.now();
    const at0 = now - 5 * 24 * 60 * 60 * 1000;
    const stamp = { w: at0, c: 0, d: 'remote-dev' };
    const note = {
      id: 'bighist', title: 'big-history.txt', text: 'body', createdAt: at0, updatedAt: at0,
      pinned: false, isDeleted: 0, deletedAt: null,
      stamps: { text: stamp, title: stamp, pinned: stamp, lifecycle: stamp },
    };
    const versions = [];
    const total = LIMITS.PROTECTED_RECENT_COUNT + 10;
    for (let i = 0; i < total; i += 1) {
      versions.push({ noteId: 'bighist', at: at0 - i * 60_000, sourceRev: total - i, textHash: '', text: 'h' + i });
    }
    const text = JSON.stringify(buildUploadPayload({ notes: [note], versions, tombstones: [], deviceId: 'remote-dev' }));
    fake.state.files.push({ id: 'file-1', headRevisionId: 'rev-0' });
    fake.state.contents.set('file-1', text);

    await sync.syncNow(); // pure download
    await sync.syncNow(); // quiet cycle
    assertEquals(fake.state.uploads.length, 0,
      'matching content must not upload, even though retention would trim the remote file');
    // And the identity normalization behind that: the second cycle must not
    // re-import history the first cycle already imported.
    assertEquals((await store.getAllVersionsForSync()).length, LIMITS.PROTECTED_RECENT_COUNT,
      'each remote version imports exactly once');
    assertEquals(sync.getSyncStatus().state, 'synced');

    // The gate must not be over-suppressed either: a real edit still uploads.
    const rev = store.saveDraft('bighist', 'edited after the quiet cycles');
    await store.flush('bighist', rev);
    await sync.syncNow();
    assertEquals(fake.state.uploads.length, 1, 'a real local change must still upload');
  } finally {
    await closeScenario();
  }
});

// --- C3: oversized outgoing payload [D6 review] -----------------------------

test('an outgoing payload over the size limit is never uploaded and surfaces an actionable error', async () => {
  const fake = await openScenario();
  try {
    setMaxSyncFileBytesForTests(600);
    const note = await store.createNote();
    const rev = store.saveDraft(note.id, 'x'.repeat(2000));
    await store.flush(note.id, rev);

    await sync.syncNow();
    assertEquals(fake.state.uploads.length, 0, 'an oversized payload must never reach Drive');
    let status = sync.getSyncStatus();
    assertEquals(status.state, 'error', 'must not report synced');
    assertEquals(status.reason, 'payload-too-large');

    // Bounded: further cycles keep refusing without uploading anything.
    await sync.syncNow();
    assertEquals(fake.state.uploads.length, 0, 'no repeated attempts to upload an invalid file');

    // Local data untouched.
    const full = await store.getNote(note.id);
    assertEquals(full.text.length, 2000, 'local text preserved');

    // Recovery: once the payload fits, sync resumes by itself.
    setMaxSyncFileBytesForTests(undefined);
    await sync.syncNow();
    assertEquals(fake.state.uploads.length, 1, 'sync resumes when the payload fits again');
    assertEquals(sync.getSyncStatus().state, 'synced');
  } finally {
    setMaxSyncFileBytesForTests(undefined);
    await closeScenario();
  }
});

// --- Final-review findings [D6 focused review] ------------------------------

test('a size-blocked upload must not advance bases past a local edit (no silent loss)', async () => {
  const { note, fake } = await syncedPair();
  try {
    // Local edit that will fail to upload because of the size limit.
    const rev = store.saveDraft(note.id, 'A2 written on this device');
    await store.flush(note.id, rev);
    setMaxSyncFileBytesForTests(300);
    await sync.syncNow();
    assertEquals(sync.getSyncStatus().reason, 'payload-too-large', 'precondition: size guard fired');
    assertEquals(fake.state.uploads.length, 1, 'precondition: the oversized payload was not uploaded');

    // Meanwhile the other device edits the same note to a newer stamp.
    const uploaded = JSON.parse(fake.state.uploads[0].text);
    const remoteNote = { ...uploaded.notes.find((n) => n.id === note.id) };
    remoteNote.text = 'B2 written elsewhere';
    remoteNote.stamps = { ...remoteNote.stamps, text: { w: Date.now() + 60_000, c: 0, d: 'device-B' } };
    const newFile = JSON.stringify(buildUploadPayload({
      notes: [remoteNote], versions: uploaded.versions, tombstones: [], deviceId: 'device-B',
    }));
    fake.state.contents.set(fake.state.files[0].id, newFile);
    fake.state.files[0].headRevisionId = 'rev-B';

    // Size pressure gone; the next cycle merges for real.
    setMaxSyncFileBytesForTests(undefined);
    await sync.syncNow();

    // B2 wins on stamps - fine. But A2 was never uploaded, so it must
    // survive as a conflict version, not vanish because the size-failure
    // cycle advanced the base over it.
    const versions = await store.getAllVersionsForSync();
    const preserved = versions.some((v) => v.text === 'A2 written on this device');
    assert(preserved, 'the never-uploaded local edit must be preserved as a version');
  } finally {
    setMaxSyncFileBytesForTests(undefined);
    await closeScenario();
  }
});

test('a validation-skipped oversized remote note must not have its base advanced', async () => {
  const fake = await openScenario();
  try {
    const note = await store.createNote();
    const rev = store.saveDraft(note.id, 'local readable text');
    await store.flush(note.id, rev);

    // The remote holds the SAME note id, but oversized - validation skips it.
    const local = (await store.getAllNotesForSync()).find((n) => n.id === note.id);
    const huge = { ...local, text: 'y'.repeat(LIMITS.MAX_NOTE_SIZE_BYTES + 1) };
    const text = JSON.stringify(buildUploadPayload({ notes: [huge], versions: [], tombstones: [], deviceId: 'remote-dev' }));
    fake.state.files.push({ id: 'file-1', headRevisionId: 'rev-0' });
    fake.state.contents.set('file-1', text);

    await sync.syncNow();
    // No readable remote copy agreed with the local state, so no base may be
    // recorded for this note - a base here would let a later valid remote
    // replacement overwrite the local text without a conflict version.
    const base = await store.getMeta(`sync:${note.id}`);
    assertEquals(base, undefined, 'no base for a note whose remote copy was skipped as oversized');
  } finally {
    await closeScenario();
  }
});

test('terminal update-required clears a leftover sync-retry-pending marker', async () => {
  const fake = await openScenario();
  try {
    await store.setMeta('sync-retry-pending', { at: 1 });
    const futureFile = JSON.stringify({
      ...JSON.parse(JSON.stringify(buildUploadPayload({ notes: [], versions: [], tombstones: [], deviceId: 'future-dev' }))),
      syncFormat: 99,
    });
    fake.state.files.push({ id: 'file-1', headRevisionId: 'rev-0' });
    fake.state.contents.set('file-1', futureFile);

    await sync.syncNow();
    assertEquals(sync.getSyncStatus().reason, 'update-required', 'precondition: terminal state reached');
    const pending = await store.getMeta('sync-retry-pending');
    assertEquals(pending, undefined,
      'a terminal non-retryable state must not leave the online-event retry loop armed');
  } finally {
    await closeScenario();
  }
});
