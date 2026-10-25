import { createPreviewStore, parsePreview, MAX_IMPORT_BYTES } from './model.js';

const store = createPreviewStore();
const $ = id => document.getElementById(id);
let selectedCollection = null;
let activeNote = store.snapshot().notes[0].id;
let confirmation = null;
const status = message => { $('status').textContent = message; };
const button = (label, action, className = '') => {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.addEventListener('click', () => attempt(action));
  return el;
};
function attempt(action) {
  try { action(); } catch (error) { status(error.message + ' The current sample library has not been replaced.'); }
}
function visibleNotes(state) {
  return state.notes.filter(n => selectedCollection === null || n.collectionId === selectedCollection);
}
function renderNotes(state = store.snapshot()) {
  const notes = visibleNotes(state);
  $('note-list').replaceChildren();
  for (const note of notes) {
    const item = button('', () => { activeNote = note.id; render(); }, 'note-card');
    item.setAttribute('aria-pressed', String(note.id === activeNote));
    const title = document.createElement('strong'); title.textContent = note.title;
    const excerpt = document.createElement('span'); excerpt.textContent = note.text.slice(0, 85) || 'A fresh sample page.';
    item.append(title, excerpt);
    $('note-list').append(item);
  }
  if (!notes.length) {
    const empty = document.createElement('p'); empty.className = 'small-print';
    empty.textContent = 'No samples here yet. Add a note or use a template.';
    $('note-list').append(empty);
  }
}
function render() {
  const state = store.snapshot();
  const notes = visibleNotes(state);
  if (!notes.some(n => n.id === activeNote)) activeNote = notes[0]?.id ?? null;
  $('collection-list').replaceChildren();
  for (const collection of [{ id: null, name: 'All notes' }, ...state.collections]) {
    const count = collection.id === null ? state.notes.length : state.notes.filter(n => n.collectionId === collection.id).length;
    const item = button(`${collection.name} · ${count}`, () => { selectedCollection = collection.id; render(); }, 'collection-item');
    item.setAttribute('aria-current', collection.id === selectedCollection ? 'true' : 'false');
    $('collection-list').append(item);
  }
  const collection = state.collections.find(c => c.id === selectedCollection);
  $('list-heading').textContent = collection?.name ?? 'All notes';
  $('collection-description').textContent = `${notes.length} sample ${notes.length === 1 ? 'note' : 'notes'} · session only`;
  $('delete-collection').hidden = selectedCollection === null;
  renderNotes(state);
  const note = state.notes.find(n => n.id === activeNote);
  $('note-editor').hidden = !note;
  $('empty-editor').hidden = !!note;
  if (note) {
    $('note-title').value = note.title;
    $('note-text').value = note.text;
    $('note-collection').replaceChildren();
    for (const c of [{ id: '', name: 'No collection' }, ...state.collections]) {
      const option = document.createElement('option'); option.value = c.id; option.textContent = c.name;
      $('note-collection').append(option);
    }
    $('note-collection').value = note.collectionId ?? '';
  }
  $('template-list').replaceChildren();
  for (const template of state.templates) {
    const card = document.createElement('article'); card.className = 'template-card';
    const title = document.createElement('h3'); title.textContent = template.name;
    const sample = document.createElement('p'); sample.textContent = template.text.slice(0, 110) || 'A blank starting point.';
    const use = button('Create new note', () => {
      activeNote = store.useTemplate(template.id, selectedCollection);
      render();
      $('note-text').focus();
      status('New sample note created from the template. Your previous note is unchanged.');
    });
    use.setAttribute('aria-label', `Create new note from ${template.name}`);
    card.append(title, sample, use); $('template-list').append(card);
  }
}
function confirmSamples(title, copy, action) {
  confirmation = action;
  $('confirm-title').textContent = title;
  $('confirm-copy').textContent = copy;
  $('confirm-dialog').returnValue = 'cancel';
  $('confirm-dialog').showModal();
}
$('confirm-dialog').addEventListener('close', () => {
  const action = confirmation;
  confirmation = null;
  if ($('confirm-dialog').returnValue === 'confirm' && action) attempt(action);
});
$('collection-form').addEventListener('submit', event => {
  event.preventDefault();
  attempt(() => {
    selectedCollection = store.createCollection($('collection-name').value);
    $('collection-form').reset(); render(); $('new-note').focus();
    status('Collection created. Add a sample note or choose a template.');
  });
});
$('delete-collection').addEventListener('click', () => attempt(() => {
  store.deleteCollection(selectedCollection);
  selectedCollection = null; render();
  $('collection-list').querySelector('button').focus();
  status('Collection removed. All of its sample notes are still in All notes.');
}));
$('new-note').addEventListener('click', () => attempt(() => {
  activeNote = store.createNote({ collectionId: selectedCollection });
  render(); $('note-title').focus(); $('note-title').select();
  status('New sample note. Changes stay in this tab until reload.');
}));
for (const id of ['note-title', 'note-text']) {
  $(id).addEventListener('input', () => attempt(() => {
    const title = $('note-title').value;
    store.updateNote(activeNote, { title: title.trim() ? title : 'Untitled sample', text: $('note-text').value });
    renderNotes();
    status('Sample draft updated in memory only. Download the preview to keep it.');
  }));
}
$('note-collection').addEventListener('change', () => attempt(() => {
  store.assignCollection(activeNote, $('note-collection').value || null);
  render(); status('Sample note moved. Its text is unchanged.');
}));
$('template-form').addEventListener('submit', event => {
  event.preventDefault();
  attempt(() => {
    store.createTemplate({ name: $('template-name').value, text: $('template-text').value });
    $('template-form').reset(); render(); $('template-details').open = false;
    $('template-details').querySelector('summary').focus();
    status('Personal template added for this session. Use it to create a new sample note.');
  });
});
$('export-preview').addEventListener('click', () => attempt(() => {
  const url = URL.createObjectURL(new Blob([store.exportPreview()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'heldnote-premium-preview.json';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Preview download requested. This file is for this prototype, not the real notepad.');
}));
$('import-preview').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0];
  $('import-file').value = '';
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Choose a preview file smaller than 1 MB.');
    const source = await file.text();
    parsePreview(source);
    confirmSamples('Import this preview?', 'Only the samples in this tab will be replaced.', () => {
      store.importPreview(source); selectedCollection = null; activeNote = null; render();
      status('Preview imported. Your real Heldnote library was not opened.');
    });
  } catch (error) { status(error.message + ' Your current samples are unchanged.'); }
});
$('reset-preview').addEventListener('click', () => confirmSamples('Reset these samples?', 'Your changes in this prototype will be replaced by the original examples.', () => {
  store.reset(); selectedCollection = null; activeNote = null; render();
  status('Original samples restored. Nothing was changed in the real notepad.');
}));
render();
for (const control of document.querySelectorAll('[disabled]')) control.disabled = false;
status('Sample workspace ready. Memory only; no payment or activation.');
