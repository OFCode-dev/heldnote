// notes-ui.js
import * as store from './store.js';
import { t } from './i18n.js';

export function renderNotesPanel(container, { onSelect, onImportComplete, onNoteDeleted }) {
  container.innerHTML = `
    <button id="new-note">${t('notes.new')}</button>
    <input id="search" type="search" aria-label="${t('notes.searchLabel')}">
    <button id="toggle-trash"></button>
    <ul id="note-list"></ul>
    <div id="undo-banner" hidden></div>
    <section id="backup-panel">
      <h2>${t('backup.title')}</h2>
      <button id="export-backup">${t('backup.export')}</button>
      <button id="import-copy">${t('backup.importCopy')}</button>
      <button id="import-replace">${t('backup.importReplace')}</button>
      <input id="import-file" type="file" accept="application/json" hidden>
      <div id="backup-status" role="status"></div>
    </section>
  `;

  const list = container.querySelector('#note-list');
  const searchInput = container.querySelector('#search');
  const toggleTrashButton = container.querySelector('#toggle-trash');
  let lastTrashedId = null;
  let viewingTrash = false;

  function updateToggleLabel() {
    toggleTrashButton.textContent = viewingTrash ? t('trash.backToNotes') : t('trash.viewTrash');
  }
  updateToggleLabel();

  toggleTrashButton.addEventListener('click', () => {
    viewingTrash = !viewingTrash;
    updateToggleLabel();
    refresh();
  });

  async function refresh() {
    const query = searchInput.value.trim() || undefined;
    const notes = await store.listNotes({ query, includeTrashed: viewingTrash });
    // listNotes({includeTrashed: true}) returns live AND trashed notes mixed
    // together (it only stops EXCLUDING trashed ones); the trash view still
    // has to filter down to trashed-only itself.
    const visible = viewingTrash ? notes.filter((note) => note.deletedAt != null) : notes;
    list.innerHTML = '';

    if (viewingTrash && visible.length === 0) {
      const li = document.createElement('li');
      li.textContent = t('trash.empty');
      list.appendChild(li);
      return;
    }

    for (const note of visible) {
      const li = document.createElement('li');

      if (viewingTrash) {
        const label = document.createElement('span');
        label.textContent = note.title || t('note.untitled');

        const restoreButton = document.createElement('button');
        restoreButton.textContent = t('trash.restore');
        restoreButton.addEventListener('click', async () => {
          if (await runNoteAction(() => store.restoreNote(note.id))) refresh();
        });

        const purgeButton = document.createElement('button');
        purgeButton.textContent = t('trash.deletePermanently');
        purgeButton.addEventListener('click', async () => {
          if (!window.confirm(t('trash.deleteConfirm'))) return;
          if (!(await runNoteAction(() => store.purgeNote(note.id)))) return;
          if (onNoteDeleted) onNoteDeleted(note.id);
          refresh();
        });

        li.append(label, restoreButton, purgeButton);
      } else {
        const button = document.createElement('button');
        button.textContent = `${note.pinned ? '📌 ' : ''}${note.title || t('note.untitled')}`;
        button.addEventListener('click', () => onSelect(note.id));

        const pinButton = document.createElement('button');
        pinButton.textContent = note.pinned ? t('notes.unpin') : t('notes.pin');
        pinButton.addEventListener('click', async () => {
          await store.setPinned(note.id, !note.pinned);
          refresh();
        });

        const trashButton = document.createElement('button');
        trashButton.textContent = t('trash.move');
        trashButton.addEventListener('click', async () => {
          await store.trashNote(note.id);
          lastTrashedId = note.id;
          showUndo();
          refresh();
        });

        li.append(button, pinButton, trashButton);
      }

      list.appendChild(li);
    }
  }

  function showUndo() {
    const banner = container.querySelector('#undo-banner');
    banner.hidden = false;
    banner.innerHTML = '';
    const undoButton = document.createElement('button');
    undoButton.textContent = t('trash.restore');
    undoButton.addEventListener('click', async () => {
      if (lastTrashedId) await store.restoreNote(lastTrashedId);
      banner.hidden = true;
      refresh();
    });
    banner.appendChild(undoButton);
  }

  container.querySelector('#new-note').addEventListener('click', async () => {
    viewingTrash = false;
    updateToggleLabel();
    const note = await store.createNote();
    await refresh();
    onSelect(note.id);
  });

  searchInput.addEventListener('input', () => refresh());

  // --- Backup: export / import ----------------------------------------
  //
  // Design doc: "With no sync in v1, export is the only way out. It is a
  // durability mechanism." Two import modes only, matching store-api.md:
  // 'copy' (safe, additive) and 'replace' (destructive, transactional,
  // requires an explicit warning and an offered safety export first).

  const exportButton = container.querySelector('#export-backup');
  const importCopyButton = container.querySelector('#import-copy');
  const importReplaceButton = container.querySelector('#import-replace');
  const importFileInput = container.querySelector('#import-file');
  const backupStatus = container.querySelector('#backup-status');
  let pendingImportMode = null;

  function showBackupStatus(message) {
    backupStatus.textContent = message;
  }

  // store-api.md: "Callers branch on `code`; they never parse a message."
  // Only invalid-import means the file is at fault — reporting a storage
  // failure as "not a valid backup" blames the user's file for something it
  // did not do, during the one destructive operation in the app.
  function backupErrorMessage(error, fileScopedKey) {
    if (error && error.code === 'invalid-import') return t(fileScopedKey);
    if (error && error.code === 'quota-exceeded') return t('backup.errorQuota');
    return t('backup.errorStorage');
  }

  // Every store call behind a button needs this. A rejection with no handler
  // is a click that visibly does nothing — the same silent-failure class the
  // editor was just fixed for, here on the irreversible action (purge) and
  // the only recovery path (restore).
  async function runNoteAction(work) {
    try {
      await work();
      return true;
    } catch (error) {
      console.error('heldnote: note action failed', error);
      showBackupStatus(backupErrorMessage(error, 'backup.errorStorage'));
      return false;
    }
  }

  function backupFileName() {
    const date = new Date().toISOString().slice(0, 10);
    return `heldnote-backup-${date}.json`;
  }

  async function exportBackup() {
    try {
      const blob = await store.exportAll();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = backupFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return true;
    } catch (error) {
      console.error('heldnote: export failed', error);
      showBackupStatus(t('backup.exportError'));
      return false;
    }
  }

  exportButton.addEventListener('click', () => { exportBackup(); });

  importCopyButton.addEventListener('click', () => {
    pendingImportMode = 'copy';
    importFileInput.click();
  });

  importReplaceButton.addEventListener('click', () => {
    if (!window.confirm(t('backup.replaceWarning'))) return;
    if (window.confirm(t('backup.safetyExportOffer'))) {
      // Deliberately not awaited: awaiting here would yield past this click
      // handler's user-gesture context, and some browsers only honor
      // importFileInput.click() below as a real file-picker trigger within
      // that same synchronous gesture. The safety export runs concurrently
      // instead; its own success or failure is reported independently via
      // showBackupStatus.
      exportBackup();
    }
    pendingImportMode = 'replace';
    importFileInput.click();
  });

  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files[0];
    const mode = pendingImportMode;
    pendingImportMode = null;
    importFileInput.value = '';
    if (!file || !mode) return;
    try {
      await store.importAll(file, { mode });
      showBackupStatus(t('backup.importSuccess'));
      viewingTrash = false;
      updateToggleLabel();
      await refresh();
      if (onImportComplete) onImportComplete(mode);
    } catch (error) {
      // importAll rejects with code 'invalid-import' for a malformed file
      // (bad JSON, wrong shape, unsupported schemaVersion, ...) without a
      // partial write — that is the only case where the file is at fault.
      // storage-unavailable and quota-exceeded reach here too, and calling
      // those "not a valid backup" would blame the file for something it did
      // not do, right after the user agreed to a destructive replace.
      console.error('heldnote: import failed', error);
      showBackupStatus(backupErrorMessage(error, 'backup.importError'));
    }
  });

  refresh();
  return { refresh };
}
