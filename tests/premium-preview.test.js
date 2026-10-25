import { test, assert, assertEquals } from './test-harness.js';
import { createPreviewStore, FORMAT } from '../preview/premium/model.js';
import * as realStore from '../store.js';

const exactText = 'Türkçe — 📝\r\n  untouched\t\n\u0000e\u0301\n\n';
function rejectsWithoutChange(store, action) {
  const before = store.exportPreview();
  let failed = false;
  try { action(); } catch { failed = true; }
  assert(failed, 'must reject');
  assertEquals(store.exportPreview(), before, 'rejection must be atomic');
}

test('preview: removing a collection retains all note text and unrelated notes', () => {
  const s = createPreviewStore();
  s.updateNote('sample-welcome', { title: 'Exact draft', text: exactText });
  const before = s.snapshot();
  s.deleteCollection('sample-work');
  const after = s.snapshot();
  assertEquals(after.notes.length, before.notes.length);
  assertEquals(after.notes.find(n => n.id === 'sample-welcome'), { ...before.notes[0], collectionId: null });
  assertEquals(after.notes.slice(1), before.notes.slice(1));
  assertEquals(after.templates, before.templates);
});

test('preview: using a personal template creates a note without replacing a draft', () => {
  const s = createPreviewStore();
  s.updateNote('sample-welcome', { title: 'Active draft', text: exactText });
  const templateId = s.createTemplate({ name: 'My routine', text: exactText });
  const before = s.snapshot().notes;
  const noteId = s.useTemplate(templateId, 'sample-personal');
  const after = s.snapshot().notes;
  assertEquals(after.slice(0, before.length), before);
  assertEquals(after.at(-1), { id: noteId, title: 'My routine', text: exactText, collectionId: 'sample-personal' });
  assert(s.useTemplate(templateId) !== noteId, 'each use creates a distinct note');
});

test('preview: assigning a collection changes only the selected note membership', () => {
  const s = createPreviewStore();
  const before = s.snapshot();
  s.assignCollection('sample-idea', 'sample-work');
  const after = s.snapshot();
  assertEquals(after.notes.slice(0, 2), before.notes.slice(0, 2));
  assertEquals(after.notes[2], { ...before.notes[2], collectionId: 'sample-work' });
  assertEquals(after.templates, before.templates);
});

test('preview: invalid membership and missing templates cannot mutate notes', () => {
  const s = createPreviewStore();
  rejectsWithoutChange(s, () => s.assignCollection('sample-welcome', 'missing'));
  rejectsWithoutChange(s, () => s.useTemplate('missing'));
  rejectsWithoutChange(s, () => s.deleteCollection('missing'));
});

test('preview: export/import preserves exact text, templates and collections', () => {
  const s = createPreviewStore();
  s.updateNote('sample-idea', { title: 'Byte check', text: exactText });
  s.createTemplate({ name: 'Exact template', text: exactText });
  const exported = s.exportPreview();
  const other = createPreviewStore();
  other.importPreview(exported);
  assertEquals(other.exportPreview(), exported);
  assertEquals(JSON.parse(exported).format, FORMAT);
  assert(!('schemaVersion' in JSON.parse(exported)), 'must not masquerade as a real backup');
});

test('preview: malformed, future and duplicate-ID imports leave samples intact', () => {
  const s = createPreviewStore();
  rejectsWithoutChange(s, () => s.importPreview('{'));
  rejectsWithoutChange(s, () => s.importPreview('null'));
  const data = JSON.parse(s.exportPreview());
  rejectsWithoutChange(s, () => s.importPreview(JSON.stringify({ ...data, version: 2 })));
  data.notes.push({ ...data.notes[0] });
  rejectsWithoutChange(s, () => s.importPreview(JSON.stringify(data)));
});

test('preview: dangling collection references and oversized imports are atomic', () => {
  const s = createPreviewStore();
  const data = JSON.parse(s.exportPreview());
  data.notes[0].collectionId = 'missing';
  rejectsWithoutChange(s, () => s.importPreview(JSON.stringify(data)));
  rejectsWithoutChange(s, () => s.importPreview(' '.repeat(1_000_001)));
});

test('preview: generated identifiers avoid identifiers in imported samples', () => {
  const s = createPreviewStore();
  const data = JSON.parse(s.exportPreview());
  data.notes[0].id = 'preview-1';
  data.templates[0].id = 'preview-2';
  s.importPreview(JSON.stringify(data));
  assertEquals(s.createNote(), 'preview-3');
});

test('preview: a full sample library remains exportable and importable after rejection', () => {
  const s = createPreviewStore();
  let rejected = false;
  for (let i = 0; i < 30; i++) {
    const before = s.exportPreview();
    try { s.createNote({ title: 'Large sample', text: '📝'.repeat(25_000) }); }
    catch {
      assertEquals(s.exportPreview(), before);
      rejected = true; break;
    }
  }
  assert(rejected, 'must bound the total preview file');
  const other = createPreviewStore();
  other.importPreview(s.exportPreview());
  assertEquals(other.exportPreview(), s.exportPreview());
});

test('preview: independent instances and returned snapshots cannot affect each other', () => {
  const a = createPreviewStore();
  const b = createPreviewStore();
  const before = b.exportPreview();
  a.updateNote('sample-welcome', { title: 'Changed', text: exactText });
  const snapshot = a.snapshot();
  snapshot.notes[0].text = 'outside mutation';
  assertEquals(a.snapshot().notes[0].text, exactText);
  assertEquals(b.exportPreview(), before);
});

test('preview: reset affects samples only and restores independent fixtures', () => {
  const s = createPreviewStore();
  const before = s.exportPreview();
  s.createNote({ title: 'Disposable example', text: exactText });
  s.reset();
  assertEquals(s.exportPreview(), before);
});

test('preview: real backups and preview files reject each other without touching real draft/history', async () => {
  // Explicit synthetic database; never use the production database name.
  await realStore.open({ dbName: `heldnote-test-preview-compat-${Date.now()}` });
  try {
    const n = await realStore.createNote();
    const rev = realStore.saveDraft(n.id, exactText);
    await realStore.flush(n.id, rev);
    await realStore.commitVersion(n.id);
    const original = await (await realStore.exportAll()).text();
    const preview = createPreviewStore();
    rejectsWithoutChange(preview, () => preview.importPreview(original));
    let code;
    try { await realStore.importAll(new Blob([preview.exportPreview()]), { mode: 'replace' }); }
    catch (error) { code = error.code; }
    assertEquals(code, 'invalid-import');
    const after = JSON.parse(await (await realStore.exportAll()).text());
    const before = JSON.parse(original);
    assertEquals(after.notes, before.notes, 'real note and draft must remain byte-preserving');
    assertEquals(after.versions, before.versions, 'real history must remain byte-preserving');
    // Existing real backup is still accepted by the unchanged production importer.
    await realStore.importAll(new Blob([original]), { mode: 'copies' });
    assertEquals((await realStore.listNotes({})).length, 2);
  } finally { await realStore.close(); }
});
