// Session-only experiment. No production imports, browser storage or services.
export const FORMAT = 'heldnote-premium-preview';
export const MAX_IMPORT_BYTES = 1_000_000;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const text = (value, max, empty = false) => typeof value === 'string' &&
  value.length <= max && (empty || value.trim().length > 0);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const serialize = state => JSON.stringify({ format: FORMAT, version: 1,
  collections: state.collections, notes: state.notes, templates: state.templates }, null, 2);

export function fixtures() {
  return {
    collections: [{ id: 'sample-work', name: 'Everyday work' }, { id: 'sample-personal', name: 'Personal' }],
    notes: [
      { id: 'sample-welcome', title: 'A little room to begin', text: 'Try a collection. Make a template your own.\n\nThese are sample notes, separate from your Heldnote library.\nNothing here is saved after you reload.', collectionId: 'sample-work' },
      { id: 'sample-walk', title: 'A thought from the walk', text: 'Leave a little space between one thing and the next.\n', collectionId: 'sample-personal' },
      { id: 'sample-idea', title: 'An unfinished idea', text: 'A place to return to.\n\nMaybe the next step can be smaller.', collectionId: null },
    ],
    templates: [
      { id: 'sample-meeting', name: 'Meeting notes', text: 'Meeting\n\nWhat we discussed\n\nDecisions\n\nNext steps\n' },
      { id: 'sample-day', name: 'A daily page', text: 'Today\n\nOne thing on my mind\n\nA small next step\n' },
    ],
  };
}

function validate(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !Array.isArray(state.collections) || !Array.isArray(state.notes) || !Array.isArray(state.templates)) {
    fail('This is not a complete preview library.');
  }
  if (state.notes.length > 200 || state.collections.length > 30 || state.templates.length > 30) {
    fail('This preview supports up to 200 sample notes, 30 collections and 30 templates.');
  }
  for (const records of [state.collections, state.notes, state.templates]) {
    const ids = new Set();
    for (const record of records) {
      if (!record || !id(record.id) || ids.has(record.id)) fail('The preview contains invalid or duplicate identifiers.');
      ids.add(record.id);
    }
  }
  const collectionIds = new Set(state.collections.map(c => c.id));
  for (const c of state.collections) if (!text(c.name, 80)) fail('Give each collection a name of up to 80 characters.');
  for (const t of state.templates) {
    if (!text(t.name, 120) || !text(t.text, 50_000, true)) fail('A template needs a name and at most 50,000 characters of text.');
  }
  for (const n of state.notes) {
    if (!text(n.title, 120) || !text(n.text, 50_000, true) ||
        !(n.collectionId === null || collectionIds.has(n.collectionId))) fail('The preview contains an invalid sample note or collection reference.');
  }
  // A file produced by this preview must fit its own importer, even when many
  // individually valid sample notes together exceed the session file budget.
  if (new TextEncoder().encode(serialize(state)).length > MAX_IMPORT_BYTES) fail('The sample library is full (1 MB). Download it before starting a fresh preview.');
  return state;
}

export function parsePreview(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_IMPORT_BYTES) fail('Choose a preview file smaller than 1 MB.');
  let data;
  try { data = JSON.parse(source); } catch { fail('The preview file is not valid JSON.'); }
  if (!data || data.format !== FORMAT || data.version !== 1 ||
      'schemaVersion' in data || 'syncFormat' in data) {
    fail('Only Heldnote Premium preview files are accepted. Your real Heldnote backups belong in the notepad.');
  }
  return clone(validate(data));
}

export function createPreviewStore(initial = fixtures()) {
  let state = clone(validate(initial));
  let serial = 0;
  const nextId = () => {
    const used = new Set([...state.notes, ...state.collections, ...state.templates].map(item => item.id));
    let candidate;
    do { candidate = `preview-${++serial}`; } while (used.has(candidate));
    return candidate;
  };
  const change = mutate => {
    const candidate = clone(state);
    const result = mutate(candidate);
    validate(candidate);
    state = candidate;
    return result;
  };
  const find = (items, recordId) => items.find(item => item.id === recordId) || fail('That sample item is no longer available.');
  return {
    snapshot: () => clone(state),
    createCollection(name) {
      const collectionId = nextId();
      return change(s => { s.collections.push({ id: collectionId, name: name.trim() }); return collectionId; });
    },
    deleteCollection(collectionId) {
      change(s => {
        find(s.collections, collectionId);
        s.collections = s.collections.filter(c => c.id !== collectionId);
        for (const n of s.notes) if (n.collectionId === collectionId) n.collectionId = null;
      });
    },
    assignCollection(noteId, collectionId) {
      change(s => { find(s.notes, noteId).collectionId = collectionId; });
    },
    createNote({ title = 'Untitled sample', text: body = '', collectionId = null } = {}) {
      const noteId = nextId();
      return change(s => { s.notes.push({ id: noteId, title, text: body, collectionId }); return noteId; });
    },
    updateNote(noteId, { title, text: body }) {
      change(s => { Object.assign(find(s.notes, noteId), { title, text: body }); });
    },
    createTemplate({ name, text: body }) {
      const templateId = nextId();
      return change(s => { s.templates.push({ id: templateId, name: name.trim(), text: body }); return templateId; });
    },
    useTemplate(templateId, collectionId = null) {
      const template = find(state.templates, templateId);
      const noteId = nextId();
      return change(s => {
        s.notes.push({ id: noteId, title: template.name, text: template.text, collectionId });
        return noteId;
      });
    },
    exportPreview() {
      return serialize(state);
    },
    importPreview(source) {
      const parsed = parsePreview(source);
      state = { collections: parsed.collections, notes: parsed.notes, templates: parsed.templates };
    },
    reset() { state = fixtures(); },
  };
}
