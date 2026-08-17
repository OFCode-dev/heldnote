// notes-ui.js
import * as store from './store.js';
import * as driveSync from './drive-sync.js';
import { t, getLanguage } from './i18n.js';

// The continuous-return mark from brand-brief.md §2: one uninterrupted line
// forming a lowercase h that curves back on itself. Inline so it needs no
// asset request and inherits its stroke color from CSS.
export const BRAND_MARK = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
  <path class="brand-mark-stroke" d="M6 4v16M6 11c0-3 3-4.5 6-4.5s6 1.5 6 4.5v6c0 2-1.5 3-3 3"
    fill="none" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const diffMs = timestamp - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(diffMs / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diffMs / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diffMs / 3_600_000), 'hour');
  if (abs < 7 * 86_400_000) return rtf.format(Math.round(diffMs / 86_400_000), 'day');
  return new Date(timestamp).toLocaleDateString(getLanguage());
}

export function renderNotesPanel(container, { onSelect, onImportComplete, onNoteDeleted, onToggleTheme }) {
  container.innerHTML = `
    <header id="brand">
      ${BRAND_MARK}
      <span class="wordmark">heldnote</span>
      <span class="brand-spacer"></span>
      <button id="theme-toggle" aria-label="${t('theme.toggle')}" title="${t('theme.toggle')}">◐</button>
    </header>
    <div class="sidebar-actions">
      <button id="new-note">${t('notes.new')}</button>
      <input id="search" type="search" placeholder="${t('notes.searchPlaceholder')}" aria-label="${t('notes.searchLabel')}">
    </div>
    <ul id="note-list"></ul>
    <div id="undo-banner" hidden></div>
    <div class="sidebar-footer">
      <button id="toggle-trash"></button>
      <details id="backup-panel">
        <summary>${t('backup.title')}</summary>
        <div class="backup-actions">
          <button id="export-backup">${t('backup.export')}</button>
          <button id="import-copy">${t('backup.importCopy')}</button>
          <button id="import-replace">${t('backup.importReplace')}</button>
        </div>
        <div id="drive-section" hidden>
          <div class="backup-divider">${t('drive.title')}</div>
          <div class="backup-actions">
            <button id="drive-connect" hidden>${t('drive.connect')}</button>
            <button id="drive-backup" hidden>${t('drive.backupNow')}</button>
            <button id="drive-restore" hidden>${t('drive.restore')}</button>
            <button id="drive-disconnect" hidden>${t('drive.disconnect')}</button>
          </div>
          <div id="drive-status" class="drive-status"></div>
        </div>
        <input id="import-file" type="file" accept="application/json" hidden>
        <div id="backup-status" role="status"></div>
      </details>
    </div>
  `;

  const list = container.querySelector('#note-list');
  const searchInput = container.querySelector('#search');
  const toggleTrashButton = container.querySelector('#toggle-trash');
  let lastTrashedId = null;
  let viewingTrash = false;
  let activeId = null;

  container.querySelector('#theme-toggle').addEventListener('click', () => {
    if (onToggleTheme) onToggleTheme();
  });

  function updateToggleLabel() {
    toggleTrashButton.textContent = viewingTrash ? t('trash.backToNotes') : t('trash.viewTrash');
  }
  updateToggleLabel();

  toggleTrashButton.addEventListener('click', () => {
    viewingTrash = !viewingTrash;
    updateToggleLabel();
    refresh();
  });

  function emptyRow(message) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = message;
    return li;
  }

  function headingRow(label) {
    const li = document.createElement('li');
    li.className = 'list-heading';
    li.setAttribute('aria-hidden', 'true');
    li.textContent = label;
    return li;
  }

  function noteRow(note) {
    const li = document.createElement('li');
    li.className = 'note-item';
    if (note.pinned) li.classList.add('is-pinned');
    if (note.id === activeId) li.classList.add('is-active');

    const openButton = document.createElement('button');
    openButton.className = 'note-open';
    const title = document.createElement('span');
    title.className = 'note-title';
    title.textContent = note.title || t('note.untitled');
    const time = document.createElement('span');
    time.className = 'note-time';
    time.textContent = formatRelativeTime(note.updatedAt);
    openButton.append(title, time);
    openButton.addEventListener('click', () => onSelect(note.id));

    const actions = document.createElement('div');
    actions.className = 'note-actions';

    const pinButton = document.createElement('button');
    pinButton.className = 'icon-button action-pin';
    pinButton.textContent = note.pinned ? '★' : '☆';
    pinButton.setAttribute('aria-label', note.pinned ? t('notes.unpin') : t('notes.pin'));
    pinButton.title = note.pinned ? t('notes.unpin') : t('notes.pin');
    pinButton.addEventListener('click', async () => {
      await store.setPinned(note.id, !note.pinned);
      refresh();
    });

    const trashButton = document.createElement('button');
    trashButton.className = 'icon-button action-trash';
    trashButton.textContent = '🗑';
    trashButton.setAttribute('aria-label', t('trash.move'));
    trashButton.title = t('trash.move');
    trashButton.addEventListener('click', async () => {
      await store.trashNote(note.id);
      lastTrashedId = note.id;
      showUndo();
      refresh();
    });

    actions.append(pinButton, trashButton);
    li.append(openButton, actions);
    return li;
  }

  function trashRow(note) {
    const li = document.createElement('li');
    li.className = 'note-item trash-row';

    const label = document.createElement('span');
    label.className = 'note-title';
    label.textContent = note.title || t('note.untitled');

    const restoreButton = document.createElement('button');
    restoreButton.textContent = t('trash.restore');
    restoreButton.addEventListener('click', async () => {
      if (await runNoteAction(() => store.restoreNote(note.id))) refresh();
    });

    const purgeButton = document.createElement('button');
    purgeButton.className = 'trash-purge';
    purgeButton.textContent = t('trash.deletePermanently');
    purgeButton.addEventListener('click', async () => {
      if (!window.confirm(t('trash.deleteConfirm'))) return;
      if (!(await runNoteAction(() => store.purgeNote(note.id)))) return;
      if (onNoteDeleted) onNoteDeleted(note.id);
      refresh();
    });

    li.append(label, restoreButton, purgeButton);
    return li;
  }

  async function refresh() {
    const query = searchInput.value.trim() || undefined;
    const notes = await store.listNotes({ query, includeTrashed: viewingTrash });
    // listNotes({includeTrashed: true}) returns live AND trashed notes mixed
    // together (it only stops EXCLUDING trashed ones); the trash view still
    // has to filter down to trashed-only itself.
    const visible = viewingTrash ? notes.filter((note) => note.deletedAt != null) : notes;
    list.innerHTML = '';

    if (viewingTrash) {
      if (visible.length === 0) {
        list.appendChild(emptyRow(t('trash.empty')));
        return;
      }
      for (const note of visible) list.appendChild(trashRow(note));
      return;
    }

    if (visible.length === 0) {
      list.appendChild(emptyRow(query ? t('notes.noResults') : t('notes.empty')));
      return;
    }

    const pinned = visible.filter((note) => note.pinned);
    const rest = visible.filter((note) => !note.pinned);
    if (pinned.length > 0) {
      list.appendChild(headingRow(t('notes.pinned')));
      for (const note of pinned) list.appendChild(noteRow(note));
    }
    if (rest.length > 0) {
      if (pinned.length > 0) list.appendChild(headingRow(t('notes.recent')));
      for (const note of rest) list.appendChild(noteRow(note));
    }
  }

  function showUndo() {
    const banner = container.querySelector('#undo-banner');
    banner.hidden = false;
    banner.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = t('trash.undoLabel');
    const undoButton = document.createElement('button');
    undoButton.textContent = t('trash.undo');
    undoButton.addEventListener('click', async () => {
      if (lastTrashedId) await store.restoreNote(lastTrashedId);
      banner.hidden = true;
      refresh();
    });
    banner.append(label, undoButton);
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

  // --- Google Drive backup ---------------------------------------------
  //
  // Hidden entirely until constants.js sets GOOGLE_DRIVE_CLIENT_ID. The Drive
  // copy is a backup, never the source of truth: restore imports as copies
  // (the safe, additive mode) and can never destroy local notes.

  const driveSection = container.querySelector('#drive-section');
  if (driveSync.isConfigured()) {
    driveSection.hidden = false;
    const connectButton = container.querySelector('#drive-connect');
    const backupButton = container.querySelector('#drive-backup');
    const restoreButton = container.querySelector('#drive-restore');
    const disconnectButton = container.querySelector('#drive-disconnect');
    const driveStatus = container.querySelector('#drive-status');

    function driveErrorMessage(error) {
      const code = error && error.code;
      if (code === 'consent-denied') return t('drive.errorConsent');
      if (code === 'network') return t('drive.errorNetwork');
      if (code === 'invalid-import') return t('backup.importError');
      if (code === 'quota-exceeded') return t('backup.errorQuota');
      return t('drive.errorGeneric');
    }

    function renderDriveState(message) {
      const connected = driveSync.isConnected();
      connectButton.hidden = connected;
      backupButton.hidden = !connected;
      restoreButton.hidden = !connected;
      disconnectButton.hidden = !connected;
      if (message != null) {
        driveStatus.textContent = message;
      } else if (connected) {
        const at = driveSync.lastBackupAt();
        driveStatus.textContent = at
          ? `${t('drive.lastBackup')}: ${new Date(at).toLocaleString(getLanguage())}`
          : t('drive.noBackupYet');
      } else {
        driveStatus.textContent = t('drive.notConnected');
      }
    }

    async function runDriveAction(button, busyKey, work) {
      button.disabled = true;
      renderDriveState(t(busyKey));
      try {
        const message = await work();
        renderDriveState(message != null ? message : null);
      } catch (error) {
        console.error('heldnote: drive action failed', error);
        renderDriveState(driveErrorMessage(error));
      } finally {
        button.disabled = false;
      }
    }

    connectButton.addEventListener('click', () => {
      runDriveAction(connectButton, 'drive.connecting', async () => {
        await driveSync.connect();
      });
    });

    backupButton.addEventListener('click', () => {
      runDriveAction(backupButton, 'drive.backingUp', async () => {
        const blob = await store.exportAll();
        await driveSync.uploadBackup(blob);
      });
    });

    restoreButton.addEventListener('click', () => {
      runDriveAction(restoreButton, 'drive.restoring', async () => {
        const blob = await driveSync.downloadBackup();
        if (!blob) return t('drive.noBackupYet');
        await store.importAll(blob, { mode: 'copy' });
        viewingTrash = false;
        updateToggleLabel();
        await refresh();
        if (onImportComplete) onImportComplete('copy');
        return t('drive.restored');
      });
    });

    disconnectButton.addEventListener('click', () => {
      driveSync.disconnect();
      renderDriveState(null);
    });

    renderDriveState(null);
  }

  refresh();
  return {
    refresh,
    setActive(id) {
      activeId = id;
      refresh();
    },
  };
}
