import { test, assert, assertEquals } from './test-harness.js';
import { encodeOrganizationSnapshot, decodeOrganizationSnapshot, assertSnapshotForBackup } from '../preview/premium/organization-codec.js';
import { EXACT_TEXT, backupFixture, organizationFixture, backupText, refusalCases } from './fixtures/organization-cases.js';
import { buildUploadPayload, validateSyncFile, unionSyncFiles, computeMergePlan, syncStateSignature } from '../sync-engine.js';
import * as store from '../store.js';

const clone = value => JSON.parse(JSON.stringify(value));
function errorCode(fn) {
  try { fn(); } catch (error) { return error.code; }
  throw new Error('Expected refusal');
}
const snapshotText = () => encodeOrganizationSnapshot(backupText(), organizationFixture());
// Record key order is not backup content; text values remain exact strings.
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const orderedNotes = values => canonical([...values].sort((a, b) => a.id.localeCompare(b.id)));
const orderedVersions = values => canonical([...values].sort((a, b) => a.noteId.localeCompare(b.noteId) || a.seq - b.seq));
const openTestStore = () => store.open({ dbName: `heldnote-test-organization-${Date.now()}-${Math.random().toString(36).slice(2)}` });

test('organization codec: preserves original backup bytes and exact text/history/template strings', () => {
  const raw = backupText();
  const metadata = organizationFixture();
  const before = JSON.stringify(metadata);
  const encoded = encodeOrganizationSnapshot(raw, metadata);
  const decoded = decodeOrganizationSnapshot(encoded);
  assertEquals([...new TextEncoder().encode(decoded.backupJson)], [...new TextEncoder().encode(raw)]);
  assertEquals(JSON.parse(decoded.backupJson).notes[0].text, EXACT_TEXT);
  assertEquals(JSON.parse(decoded.backupJson).versions, backupFixture().versions);
  assertEquals(decoded.organization.templates[0].text, EXACT_TEXT);
  assertEquals(encodeOrganizationSnapshot(decoded.backupJson, decoded.organization), encoded);
  decoded.organization.templates[0].text = 'caller edit';
  assertEquals(JSON.stringify(metadata), before, 'codec cannot mutate caller metadata');
  assertEquals(assertSnapshotForBackup(encoded, raw).backupJson, raw);
});

test('organization codec: legacy backup without meta and opaque legacy extensions survive', () => {
  const legacy = backupFixture();
  delete legacy.meta;
  legacy.fixtureExtension = { spelling: 'preserve me' };
  legacy.notes[0].fixtureExtension = ['do not normalize'];
  const raw = JSON.stringify(legacy, null, 4) + '\r\n';
  assertEquals(decodeOrganizationSnapshot(encodeOrganizationSnapshot(raw, organizationFixture())).backupJson, raw);
});

for (const [name, code, mutate] of refusalCases) {
  test(`organization codec refuses ${name} without changing the existing snapshot`, () => {
    const existing = snapshotText();
    const candidate = JSON.parse(existing);
    mutate(candidate);
    const candidateBefore = JSON.stringify(candidate);
    let current = existing;
    assertEquals(errorCode(() => {
      const checked = decodeOrganizationSnapshot(JSON.stringify(candidate));
      current = JSON.stringify(checked); // only publish a fully validated candidate
    }), code);
    assertEquals(current, existing);
    assertEquals(JSON.stringify(candidate), candidateBefore);
  });
}

test('organization codec: same note IDs with different text cannot rebind a snapshot', () => {
  const existing = snapshotText();
  const target = backupFixture(); target.notes[0].text = 'Different target draft';
  const before = JSON.stringify(target);
  assertEquals(errorCode(() => assertSnapshotForBackup(existing, before)), 'snapshot-mismatch');
  assertEquals(JSON.stringify(target), before);
  assertEquals(decodeOrganizationSnapshot(existing).backupJson, backupText());
  assertEquals(errorCode(() => assertSnapshotForBackup(existing, JSON.stringify(backupFixture()))), 'snapshot-mismatch', 'even a formatting-only difference needs an explicit rebind design');
});

test('organization codec: malformed JSON and Drive/preview documents are not legacy backups', () => {
  assertEquals(errorCode(() => decodeOrganizationSnapshot('{')), 'invalid-json');
  for (const extra of [{ syncFormat: 2 }, { format: 'heldnote-premium-preview' }]) {
    assertEquals(errorCode(() => encodeOrganizationSnapshot(JSON.stringify({ ...backupFixture(), ...extra }), organizationFixture())), 'invalid-backup');
  }
});

test('organization compatibility: actual legacy import/export preserves note and history content', async () => {
  await openTestStore();
  try {
    const raw = decodeOrganizationSnapshot(snapshotText()).backupJson;
    await store.importAll(new Blob([raw]), { mode: 'replace' });
    const restored = JSON.parse(await (await store.exportAll()).text());
    assertEquals(orderedNotes(restored.notes), orderedNotes(backupFixture().notes));
    assertEquals(orderedVersions(restored.versions), orderedVersions(backupFixture().versions));
    assertEquals(restored.meta, backupFixture().meta);
  } finally { await store.close(); }
});

test('organization compatibility: current importer refuses snapshot/future backup before any overwrite', async () => {
  await openTestStore();
  try {
    const note = await store.createNote();
    const rev = store.saveDraft(note.id, EXACT_TEXT);
    await store.flush(note.id, rev); await store.commitVersion(note.id);
    const before = JSON.parse(await (await store.exportAll()).text());
    const future = JSON.stringify({ ...backupFixture(), schemaVersion: 2 });
    for (const source of [snapshotText(), future]) {
      let code;
      try { await store.importAll(new Blob([source]), { mode: 'replace' }); } catch (error) { code = error.code; }
      assertEquals(code, 'invalid-import');
      const after = JSON.parse(await (await store.exportAll()).text());
      assertEquals(after.notes, before.notes); assertEquals(after.versions, before.versions);
    }
  } finally { await store.close(); }
});

test('organization compatibility: old backup round trip strips unknown root/note/history fields', async () => {
  await openTestStore();
  try {
    const annotated = backupFixture();
    annotated.organization = organizationFixture();
    annotated.notes[0].collectionId = 'fixture-collection';
    annotated.versions[0].templateId = 'fixture-template';
    await store.importAll(new Blob([JSON.stringify(annotated)]), { mode: 'replace' });
    const after = JSON.parse(await (await store.exportAll()).text());
    assert(!('organization' in after));
    assert(after.notes.every(n => !('collectionId' in n)));
    assert(after.versions.every(v => !('templateId' in v)));
    assertEquals(orderedNotes(after.notes), orderedNotes(backupFixture().notes));
    assertEquals(orderedVersions(after.versions), orderedVersions(backupFixture().versions));
  } finally { await store.close(); }
});

test('organization compatibility: copy import changes note IDs without remapping arbitrary meta references', async () => {
  await openTestStore();
  try {
    const legacy = backupFixture();
    legacy.meta.push({ key: 'fixture-organization', value: organizationFixture() });
    await store.importAll(new Blob([JSON.stringify(legacy)]), { mode: 'copy' });
    const after = JSON.parse(await (await store.exportAll()).text());
    const originalIds = new Set(legacy.notes.map(n => n.id));
    assert(after.notes.every(n => !originalIds.has(n.id)), 'copies have fresh IDs');
    const meta = after.meta.find(m => m.key === 'fixture-organization');
    assertEquals(meta.value, organizationFixture(), 'arbitrary settings survive but references remain old');
    assert(!after.notes.some(n => n.id === meta.value.memberships[0].noteId), 'metadata cannot be automatically attached to copied notes');
    assertEquals(after.notes.map(n => n.text).sort(), legacy.notes.map(n => n.text).sort());
    assertEquals(after.versions.map(v => v.text).sort(), legacy.versions.map(v => v.text).sort());
  } finally { await store.close(); }
});

function annotatedSyncFixture() {
  const b = backupFixture();
  const stamp = { w: 2, c: 0, d: 'fixture-device' };
  const wire = buildUploadPayload({
    notes: b.notes.map(n => ({ ...n, stamps: { text: stamp, title: stamp, pinned: stamp, lifecycle: stamp } })),
    versions: b.versions.map(v => ({ ...v, textHash: '' })), tombstones: [], deviceId: 'fixture-writer', schemaVersion: 1,
  });
  wire.organization = organizationFixture();
  wire.notes[0].collectionId = 'fixture-collection';
  return wire;
}

test('organization compatibility: actual Drive validate/union/merge/upload drops unknown metadata', async () => {
  const wire = annotatedSyncFixture();
  const before = JSON.stringify(wire);
  const checked = validateSyncFile(before);
  assertEquals(checked.errors, []);
  assert(!('organization' in checked.syncFile), 'root metadata is lost during validation');
  assertEquals(checked.syncFile.notes[0].collectionId, 'fixture-collection', 'note fields can survive parse but not upload');
  const remote = unionSyncFiles([checked.syncFile]);
  const plan = await computeMergePlan({
    localNotes: [], localVersions: [], localTombstones: [], remoteNotes: remote.notes,
    remoteVersions: remote.versions, remoteTombstones: remote.tombstones, bases: new Map(), deviceId: 'fixture-reader',
  });
  assert(!('organization' in plan.uploadPayload));
  assert(plan.uploadPayload.notes.every(n => !('collectionId' in n)));
  assertEquals(plan.uploadPayload.notes.map(n => n.text).sort(), wire.notes.map(n => n.text).sort());
  assertEquals(plan.uploadPayload.versions.map(v => v.text).sort(), wire.versions.map(v => v.text).sort());
  assertEquals(JSON.stringify(wire), before, 'pure engine must not mutate source fixture');
});

test('organization compatibility: old Drive content signature ignores organization-only changes', async () => {
  const original = annotatedSyncFixture();
  const changed = clone(original);
  changed.organization.collections[0].name = 'Another name';
  changed.notes[0].collectionId = 'another-collection';
  assertEquals(await syncStateSignature(original), await syncStateSignature(changed));
});

test('organization compatibility: sync schema bump alone does not block old clients; syncFormat bump does', () => {
  const wire = annotatedSyncFixture();
  wire.schemaVersion = 99;
  assert(validateSyncFile(JSON.stringify(wire)).syncFile, 'current validator does not gate backup schemaVersion in Drive payloads');
  wire.syncFormat = 3;
  assertEquals(validateSyncFile(JSON.stringify(wire)).code, 'update-required');
  assertEquals(validateSyncFile(snapshotText()).syncFile, null, 'organization snapshot must not be used as the Drive sync file');
});
