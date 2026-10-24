// notes-ui.js
import * as store from './store.js';

import * as driveSync from './drive-sync.js';
import * as sync from './sync.js';
import { t, getLanguage, SUPPORTED } from './i18n.js';
import { ICONS } from './icons.js';

// The product mark: the sage notepad-on-a-monitor from the favicon/app icon
// (Quick Web Notepad's composition in the heldnote palette). One drawing
// everywhere — tab, home screen, and in-page brand — is the identity.
// Colors are fixed on purpose so the mark reads the same in both themes.
export const BRAND_MARK = `<svg width="22" height="22" viewBox="0 0 36 36" aria-hidden="true">
  <rect x="2" y="3" width="32" height="22" rx="2" fill="#4E7A62" stroke="#78A98D" stroke-width="1.5"/>
  <rect x="4" y="5" width="28" height="18" rx="1" fill="#0E1116"/>
  <line x1="7" y1="10" x2="24" y2="10" stroke="#9FC7AE" stroke-width="1.2" stroke-linecap="round"/>
  <line x1="7" y1="13.5" x2="22" y2="13.5" stroke="#9FC7AE" stroke-width="1.2" stroke-linecap="round"/>
  <line x1="7" y1="17" x2="19" y2="17" stroke="#9FC7AE" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="19.5" y="15.5" width="1.2" height="3" fill="#78A98D"/>
  <rect x="15" y="25" width="6" height="4" fill="#4E7A62"/>
  <rect x="11" y="29" width="14" height="2.5" rx="1" fill="#4E7A62"/>
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

// Endonyms — a language is named in itself, never translated. Someone stuck in
// a UI they cannot read still recognises "English". Filtered against SUPPORTED
// at render time, so an entry here without a string table is simply not offered.
const LANGUAGE_NAMES = [
  { code: 'en', name: 'English' },
  { code: 'tr', name: 'Türkçe' },
];

export function renderNotesPanel(container, { onSelect, onImportComplete, onNoteDeleted, onToggleTheme, onChangeLanguage }) {
  container.innerHTML = `
    <header id="brand">
      ${BRAND_MARK}
      <span class="wordmark">heldnote</span>
      <span class="brand-spacer"></span>
      <button id="theme-toggle" aria-label="${t('theme.toggle')}" title="${t('theme.toggle')}">${ICONS.theme}</button>
      <!-- A native <select>, deliberately: self-labelling, and keyboard- and
           screen-reader-complete for free, with no popover machinery. This is a
           temporary home — it belongs in Settings > General once that surface
           exists (product-maturity-plan.md §3.1). Names are endonyms, so
           someone who cannot read the current UI can still find their own. -->
      <select id="language-select" aria-label="${t('language.label')}" title="${t('language.label')}">
        ${LANGUAGE_NAMES.filter((entry) => SUPPORTED.includes(entry.code))
          .map((entry) => `<option value="${entry.code}">${entry.name}</option>`).join('')}
      </select>
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
        <summary><span class="summary-chevron">${ICONS.chevronRight}</span>${t('backup.title')}</summary>
        <div class="backup-actions">
          <button id="export-backup">${t('backup.export')}</button>
          <button id="import-copy">${t('backup.importCopy')}</button>
          <button id="import-replace">${t('backup.importReplace')}</button>
        </div>
        <input id="import-file" type="file" accept="application/json" hidden>
        <div id="backup-status" role="status"></div>
      </details>
      <div id="drive-section" hidden>
        <div class="backup-actions">

          <button id="drive-connect" class="drive-primary" hidden>
            <svg width="15" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.6 2.5h6.8L23 15.3l-3.4 6.2-7.6-13.2zM7.5 4.4 1 15.9l3.4 5.8 6.5-11.4zM6 22h12.4l3-5.3H9z"/></svg>
            ${t('drive.connectSync')}
          </button>
          <button id="drive-sync-now" hidden>${t('drive.syncNow')}</button>
          <button id="drive-disconnect" hidden>${t('drive.disconnect')}</button>
        </div>
        <div id="drive-status" class="drive-status"></div>
      </div>
    </div>
  `;

  const list = container.querySelector('#note-list');
  const searchInput = container.querySelector('#search');
  const toggleTrashButton = container.querySelector('#toggle-trash');
  let lastTrashedId = null;
  let viewingTrash = false;
  let activeId = null;
  let refreshToken = 0;
  let undoTimer = null;

  container.querySelector('#theme-toggle').addEventListener('click', () => {
    if (onToggleTheme) onToggleTheme();
  });

  const languageSelect = container.querySelector('#language-select');
  languageSelect.value = getLanguage();
  languageSelect.addEventListener('change', () => {
    if (onChangeLanguage) onChangeLanguage(languageSelect.value);
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

  // Empty states carry an action, not just a message (redesign-plan §6).
  // `query` echoes the search text back (textContent — never markup) so
  // "no results" names what produced it; `action` is a way out.
  function emptyRow(message, { query, action } = {}) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    const text = document.createElement('span');
    text.textContent = message;
    li.appendChild(text);
    if (query) {
      const q = document.createElement('span');
      q.className = 'empty-query';
      q.textContent = `“${query}”`;
      li.appendChild(q);
    }
    if (action) {
      const button = document.createElement('button');
      button.className = 'empty-action';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      li.appendChild(button);
    }
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
    pinButton.innerHTML = note.pinned ? ICONS.pinFilled : ICONS.pin;
    pinButton.setAttribute('aria-label', note.pinned ? t('notes.unpin') : t('notes.pin'));
    pinButton.setAttribute('aria-pressed', String(!!note.pinned));
    pinButton.title = note.pinned ? t('notes.unpin') : t('notes.pin');
    pinButton.addEventListener('click', async () => {
      await store.setPinned(note.id, !note.pinned);
      refresh();
    });

    const duplicateButton = document.createElement('button');
    duplicateButton.className = 'icon-button action-duplicate';
    duplicateButton.innerHTML = ICONS.duplicate;
    duplicateButton.setAttribute('aria-label', t('notes.duplicate'));
    duplicateButton.title = t('notes.duplicate');
    duplicateButton.addEventListener('click', async () => {
      // Composed entirely from existing store APIs: a duplicate is a fresh
      // note (own id, fresh history — versions are not copied) with the same
      // text and the name plus " copy" before the extension. Pinned state is
      // deliberately not copied. The filename literal is language-invariant,
      // like the "Untitled.txt" default.
      duplicateButton.disabled = true;
      try {
        const success = await runNoteAction(async () => {
          const source = await store.getNote(note.id);
          const dup = await store.createNote();
          const rev = store.saveDraft(dup.id, source.text);
          await store.flush(dup.id, rev);
          const baseName = source.title || t('note.untitled');
          const dot = baseName.lastIndexOf('.');
          const dupName = dot > 0
            ? `${baseName.slice(0, dot)} copy${baseName.slice(dot)}`
            : `${baseName} copy`;
          await store.renameNote(dup.id, dupName.slice(0, 200));
          onSelect(dup.id);
        });
        if (success) refresh();
      } finally {
        duplicateButton.disabled = false;
      }
    });

    const trashButton = document.createElement('button');
    trashButton.className = 'icon-button action-trash';
    trashButton.innerHTML = ICONS.trash;
    trashButton.setAttribute('aria-label', t('trash.move'));
    trashButton.title = t('trash.move');
    trashButton.addEventListener('click', async () => {
      await store.trashNote(note.id);
      lastTrashedId = note.id;
      showUndo();
      refresh();
    });

    actions.append(pinButton, duplicateButton, trashButton);
    li.append(openButton, actions);
    return li;
  }

  // "Empty trash" is one confirm away from destroying many notes at once, so
  // the confirmation names the count rather than asking a generic question.
  function emptyTrashRow(count) {
    const li = document.createElement('li');
    li.className = 'note-item trash-empty-all';
    const button = document.createElement('button');
    button.className = 'trash-purge';
    button.textContent = t('trash.emptyAll');
    button.addEventListener('click', async () => {
      const question = count === 1
        ? t('trash.emptyAllConfirmOne')
        : t('trash.emptyAllConfirm').replace('{count}', String(count));
      if (!window.confirm(question)) return;
      button.disabled = true;
      hideUndo(); // any pending undo points at a note this may have just purged
      try {
        const result = await store.emptyTrash();
        if (onNoteDeleted) for (const id of result.purged) onNoteDeleted(id);
        if (result.failed.length) {
          showBackupStatus(t('trash.emptyAllPartial').replace('{count}', String(result.failed.length)));
        }
      } catch (error) {
        showBackupStatus(backupErrorMessage(error, 'trash.emptyAllFailed'));
      } finally {
        button.disabled = false;
        refresh();
      }
    });
    li.appendChild(button);
    return li;
  }

  function trashRow(note) {
    const li = document.createElement('li');
    li.className = 'note-item trash-row';

    // The title is a disclosure button, not a label. Without it the only way
    // to find out what a trashed note contains is to restore it, read it and
    // re-trash it — and "Delete permanently" asks you to confirm destroying
    // something you were never allowed to look at.
    //
    // Read-only on purpose, and structurally so: the text lands in a <pre>,
    // which cannot be typed into, so this can never become an accidental
    // "resurrect and modify" path that points autosave at a trashed note.
    const label = document.createElement('button');
    label.className = 'note-title trash-title';
    label.textContent = note.title || t('note.untitled');
    label.setAttribute('aria-expanded', 'false');
    label.title = t('trash.preview');

    const preview = document.createElement('div');
    preview.className = 'trash-preview';
    preview.hidden = true;

    let loaded = false;
    label.addEventListener('click', async () => {
      const opening = preview.hidden;
      preview.hidden = !opening;
      label.setAttribute('aria-expanded', String(opening));
      label.title = opening ? t('trash.previewHide') : t('trash.preview');
      if (!opening || loaded) return;
      loaded = true;
      // getNote() does not filter on trashed state, so the record is readable
      // as-is with deletedAt populated — no store change was needed for this.
      try {
        const full = await store.getNote(note.id);
        const body = document.createElement('pre');
        body.className = 'trash-preview-text';
        body.textContent = full.text || t('trash.previewEmpty');
        if (!full.text) body.classList.add('is-empty');
        const meta = document.createElement('p');
        meta.className = 'trash-preview-meta';
        meta.textContent = full.deletedAt
          ? `${t('trash.trashedAt')}: ${new Date(full.deletedAt).toLocaleString(getLanguage())}`
          : '';
        preview.append(body, meta);
      } catch (error) {
        loaded = false; // let a later expand retry rather than caching failure
        const failed = document.createElement('p');
        failed.className = 'trash-preview-meta';
        failed.textContent = t('trash.previewFailed');
        preview.append(failed);
      }
    });

    const restoreButton = document.createElement('button');
    restoreButton.textContent = t('trash.restore');
    restoreButton.addEventListener('click', async () => {
      hideUndo(); // the pending undo (if any) is stale once trash state changes here
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

    li.append(label, restoreButton, purgeButton, preview);
    return li;
  }

  async function refresh() {
    // Guard against out-of-order completions: refresh() is still called from
    // a per-keystroke path (search), and an older listNotes() resolving after
    // a newer one would paint stale rows. (Titles are user-set now, so the
    // original per-keystroke title race is gone — search keeps this guard
    // load-bearing.)
    const token = ++refreshToken;
    const query = searchInput.value.trim() || undefined;
    const notes = await store.listNotes({ query, includeTrashed: viewingTrash });
    if (token !== refreshToken) return;
    // listNotes({includeTrashed: true}) returns live AND trashed notes mixed
    // together (it only stops EXCLUDING trashed ones); the trash view still
    // has to filter down to trashed-only itself.
    const visible = viewingTrash ? notes.filter((note) => note.deletedAt != null) : notes;
    list.innerHTML = '';

    if (viewingTrash) {
      if (visible.length === 0) {
        list.appendChild(emptyRow(t('trash.empty'), {
          action: {
            label: t('trash.backToNotes'),
            run: () => { viewingTrash = false; updateToggleLabel(); refresh(); },
          },
        }));
        return;
      }
      list.appendChild(emptyTrashRow(visible.length));
      for (const note of visible) list.appendChild(trashRow(note));
      return;
    }

    if (visible.length === 0) {
      if (query) {
        list.appendChild(emptyRow(t('notes.noResults'), {
          query,
          action: {
            label: t('notes.clearSearch'),
            run: () => { searchInput.value = ''; refresh(); searchInput.focus(); },
          },
        }));
      } else {
        list.appendChild(emptyRow(t('notes.empty'), {
          action: {
            label: t('empty.cta'),
            // The New note button owns the careful create flow (focus, early
            // typing capture); reuse it instead of a second code path.
            run: () => container.querySelector('#new-note').click(),
          },
        }));
      }
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

  function hideUndo() {
    const banner = container.querySelector('#undo-banner');
    banner.hidden = true;
    lastTrashedId = null;
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
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
      const id = lastTrashedId;
      hideUndo();
      if (id) await store.restoreNote(id);
      refresh();
    });
    banner.append(label, undoButton);
    // An undo offer is only meaningful in the moment: QA found the banner
    // still clickable minutes later — after the note had already been
    // restored from the Trash — where "Undo" would act on stale state, and
    // its in-flow height was clipping real notes out of the list.
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 8000);
  }

  const newNoteButton = container.querySelector('#new-note');
  newNoteButton.addEventListener('click', async () => {
    // Drop focus synchronously: while createNote() is in flight, a focused
    // button turns every Space/Enter the user types into another click —
    // QA created four junk notes with three spacebar presses this way.
    newNoteButton.blur();
    newNoteButton.disabled = true;
    // Even with the editor focusing the moment it renders, createNote()'s
    // round-trip leaves a few-millisecond gap where a fast typist's first
    // character lands nowhere (QA: "Grocery list" arrived as "rocery list").
    // Capture printable keys during exactly that gap and replay them into
    // the editor once it exists; preventDefault doubles as the guarantee
    // that Space/Enter cannot re-activate anything else meanwhile.
    const typedEarly = [];
    const captureEarlyTyping = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter') { typedEarly.push('\n'); event.preventDefault(); }
      else if (event.key.length === 1) { typedEarly.push(event.key); event.preventDefault(); }
    };
    document.addEventListener('keydown', captureEarlyTyping, true);
    try {
      viewingTrash = false;
      updateToggleLabel();
      const note = await store.createNote();
      // Select first, refresh after: the editor (and its focus) must not
      // wait for the full list repaint.
      onSelect(note.id);
      document.removeEventListener('keydown', captureEarlyTyping, true);
      if (typedEarly.length > 0) {
        const editorEl = document.getElementById('editor');
        if (editorEl) {
          editorEl.value += typedEarly.join('');
          editorEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      refresh();
    } finally {
      document.removeEventListener('keydown', captureEarlyTyping, true);
      newNoteButton.disabled = false;
    }
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
    // Local date, not UTC: the filename should agree with every date the
    // user sees in the UI, which are all local.
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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
      // Visible confirmation: QA clicked Export and saw nothing change at
      // all, and reasonably assumed the button was broken.
      showBackupStatus(`${t('backup.exportSuccess')} (${a.download})`);
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


  // --- Google Drive sync ------------------------------------------------
  //
  // Authentication remains a deliberate user action. Once connected, the
  // coordinator owns every automatic trigger and this panel only reflects its
  // state; keeping a second scheduler here would create competing uploads.

  const driveSection = container.querySelector('#drive-section');
  if (driveSync.isConfigured()) {
    driveSection.hidden = false;
    const connectButton = container.querySelector('#drive-connect');
    const syncButton = container.querySelector('#drive-sync-now');
    const disconnectButton = container.querySelector('#drive-disconnect');
    const driveStatus = container.querySelector('#drive-status');

    function showConnectionError(error) {
      const key = {
        'popup-blocked': 'drive.errorPopup',
        timeout: 'drive.errorTimeout',
        'consent-denied': 'drive.errorConsent',
        network: 'drive.errorNetwork',
        'auth-retry': 'drive.errorRetrySignIn',
        'auth-needed': 'drive.syncAuthNeeded',
      }[error && error.code] || 'drive.errorSignIn';
      driveStatus.textContent = t(key);
    }

    function renderConnectionControls() {
      const connected = driveSync.isConnected();
      connectButton.hidden = connected;

      const memoryMode = store.isMemoryFallback();
      syncButton.hidden = !connected || memoryMode;
      syncButton.disabled = memoryMode;
      disconnectButton.hidden = !connected;
    }

    function renderSyncStatus(status) {
      renderConnectionControls();
      if (!driveSync.isConnected()) {
        driveStatus.textContent = t('drive.syncNotConnected');
        return;
      }
      if (status.state === 'disabled') driveStatus.textContent = t('drive.syncUnavailable');
      else if (status.state === 'syncing') {
        driveStatus.textContent = status.clockWarning
          ? `${t('drive.syncing')} ${t('drive.clockWarning')}`
          : t('drive.syncing');

      } else if (status.state === 'synced') {
        const warnings = [];
        if (status.clockWarning) warnings.push(t('drive.clockWarning'));
        if (status.skippedNotes) warnings.push(t('drive.syncSkippedNotes').replace('{count}', status.skippedNotes));
        if (status.invalidLegacyRecords) warnings.push(t('drive.syncInvalidLegacy').replace('{count}', status.invalidLegacyRecords));
        if (status.rejectedFiles) warnings.push(t('drive.syncRejectedFiles').replace('{count}', status.rejectedFiles));
        driveStatus.textContent = `${t('drive.synced')} ${new Date(status.at).toLocaleString(getLanguage())}${warnings.length ? ` · ${warnings.join(' ')}` : ''}`;
      } else if (status.state === 'auth-needed' || (status.state === 'idle' && !driveSync.hasFreshToken())) driveStatus.textContent = t('drive.syncAuthNeeded');
      else if (status.state === 'retry-pending') driveStatus.textContent = t('drive.syncRetry');
      else if (status.state === 'error' && status.reason === 'memory-pending') driveStatus.textContent = t('drive.syncMemoryPending');
      else if (status.state === 'error' && status.reason === 'update-required') driveStatus.textContent = t('drive.syncUpdateRequired');
      else if (status.state === 'error' && status.reason === 'payload-too-large') driveStatus.textContent = t('drive.syncTooLarge');
      else driveStatus.textContent = t('drive.syncReady');
    }

    connectButton.addEventListener('click', async () => {
      connectButton.disabled = true;
      driveStatus.textContent = t('drive.connecting');
      try {

        await driveSync.connect();
        sync.initSync();
        renderConnectionControls();
        await sync.syncNow({ silent: true });
      } catch (error) {
        console.error('heldnote: Drive connection failed', error);
        showConnectionError(error);
      } finally {
        connectButton.disabled = false;
      }
    });

    syncButton.addEventListener('click', async () => {
      syncButton.disabled = true;
      try {
        // Authorize in this click, before the coordinator awaits IndexedDB.
        // The subsequent cycle must never open a popup after network/storage IO.
        await driveSync.withToken(() => {});
        await sync.syncNow({ silent: true });
      } catch (error) {
        console.error('heldnote: Drive sign-in failed', error);
        showConnectionError(error);
      } finally {
        syncButton.disabled = false;
      }
    });


    disconnectButton.addEventListener('click', () => {
      sync.destroySync();
      driveSync.disconnect();
      renderSyncStatus({ state: 'idle' });
    });

    sync.onSyncStatus(renderSyncStatus);
    renderSyncStatus(sync.getSyncStatus());
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
