// Synthetic only. Fixed identifiers/text/times, with a fresh object each call.
export const EXACT_TEXT = 'Synthetic 📝 Türkçe\r\n  space\t\u0000e\u0301\n\n';
export function backupFixture() {
  return {
    schemaVersion: 1, exportedAt: 1000,
    notes: [
      { id: 'fixture-note-a', title: 'Synthetic A', text: EXACT_TEXT, createdAt: 1, updatedAt: 2, localRev: 2, pinned: false, deletedAt: null },
      { id: 'fixture-note-b', title: 'Synthetic B', text: 'Unrelated sample\n', createdAt: 1, updatedAt: 2, localRev: 1, pinned: true, deletedAt: null },
    ],
    versions: [
      { noteId: 'fixture-note-a', seq: 1, at: 1, sourceRev: 1, text: 'Earlier synthetic text\r\n\t' },
      { noteId: 'fixture-note-a', seq: 2, at: 2, sourceRev: 2, text: EXACT_TEXT },
    ],
    meta: [{ key: 'fixture-setting', value: 'sample' }],
  };
}
export function organizationFixture() {
  return {
    collections: [{ id: 'fixture-collection', name: 'Sample work' }],
    templates: [{ id: 'fixture-template', name: 'Sample routine', text: EXACT_TEXT }],
    memberships: [{ noteId: 'fixture-note-a', collectionId: 'fixture-collection' }],
  };
}
export const backupText = () => JSON.stringify(backupFixture(), null, 2) + '\r\n';

// Executable negative vectors: mutate a newly decoded valid snapshot, never a
// shared fixture. Tests assert the stated error and that caller values survive.
const changeBackup = mutate => snapshot => {
  const backup = JSON.parse(snapshot.backupJson); mutate(backup); snapshot.backupJson = JSON.stringify(backup);
};
export const refusalCases = [
  ['future snapshot', 'unsupported-version', s => { s.version = 2; }],
  ['unknown old snapshot', 'unsupported-version', s => { s.version = 0; }],
  ['fractional version', 'unsupported-version', s => { s.version = 1.1; }],
  ['wrong format', 'unsupported-format', s => { s.format = 'heldnote-premium-preview'; }],
  ['unknown envelope field', 'unsupported-field', s => { s.features = ['sharing']; }],
  ['unknown organization field', 'unsupported-field', s => { s.organization.tags = []; }],
  ['unknown template field', 'unsupported-field', s => { s.organization.templates[0].shared = true; }],
  ['missing collection array', 'invalid-organization', s => { delete s.organization.collections; }],
  ['duplicate collection', 'duplicate-id', s => { s.organization.collections.push({ ...s.organization.collections[0] }); }],
  ['duplicate template', 'duplicate-id', s => { s.organization.templates.push({ ...s.organization.templates[0] }); }],
  ['duplicate membership', 'duplicate-membership', s => { s.organization.memberships.push({ ...s.organization.memberships[0] }); }],
  ['orphan note membership', 'orphan-membership', s => { s.organization.memberships[0].noteId = 'missing'; }],
  ['orphan collection membership', 'orphan-membership', s => { s.organization.memberships[0].collectionId = 'missing'; }],
  ['future backup', 'unsupported-backup-version', changeBackup(b => { b.schemaVersion = 2; })],
  ['duplicate backup note', 'duplicate-id', changeBackup(b => { b.notes.push({ ...b.notes[0] }); })],
  ['duplicate history key', 'duplicate-id', changeBackup(b => { b.versions.push({ ...b.versions[0] }); })],
  ['orphan history', 'orphan-history', changeBackup(b => { b.versions[0].noteId = 'missing'; })],
  ['invalid legacy text', 'invalid-backup', changeBackup(b => { b.notes[0].text = { value: 'not text' }; })],
];
