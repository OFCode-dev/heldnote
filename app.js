// app.js
import * as store from './store.js';
import { t, setLanguage, detectLanguage } from './i18n.js';
import { renderNotesPanel, BRAND_MARK } from './notes-ui.js';
import { renderEditor } from './editor.js';
import { renderHistoryPanel } from './history-ui.js';

let currentNoteId = null;
let currentNoteRev = 0; // set by Task 18's editor via onRevChange; flush() target for lifecycle events
let savedRefreshTimer = null; // debounce for the note-list refresh on 'saved' events

// Set once renderNotesPanel has run, so the note-changed subscriber below
// (registered before the panel exists) can reach its `refresh()`.
let notesPanelHandle = null;

const STORAGE_REASON_KEYS = {
  blocked: 'error.storageBlocked',
  corrupt: 'error.storageCorrupt',
  unavailable: 'error.storageUnavailable',
  'migration-failed': 'error.storageUnavailable',
  'version-change': 'error.storageVersionChange',
};

// A dedicated container the editor never owns (unlike the old showAlert,
// which wrote into #editor-panel and was wiped by the next renderEditor()
// call — see final-review Fix 8). Uses textContent, not innerHTML: every
// caller passes an already-translated i18n literal today, but this keeps it
// safe even if that ever changes.
//
// `tone` matters here for the same reason the brand brief keeps "durable
// save" and "browser retention" visually separate: coral is reserved for a
// save failure or a destructive action, and using it for a calm, standing
// informational notice (e.g. the Safari retention notice) would itself be
// the kind of conflation this product is built to avoid.
function addNotice(message, tone = 'error') {
  const container = document.getElementById('app-notices');
  if (!container) return;
  // Guards against the same notice stacking forever — e.g. a commitVersion
  // failure recurring on every idle-timer tick while the underlying problem
  // persists.
  const last = container.lastElementChild;
  if (last && last.textContent === message) return;
  const div = document.createElement('div');
  div.className = tone === 'info' ? 'app-notice tone-info' : 'app-notice';
  div.textContent = message;
  container.appendChild(div);
}

// Not Chrome/Chromium/Edge (which also contain "Safari" in their UA string).
// See design doc "Safari and retention": ordinary Safari is supported but
// declared non-durable, with a standing notice — this is what detects that
// case. Deliberately does NOT attempt to detect Private Browsing specifically:
// a successful storage write probe there is not proof of durability, and the
// design is explicit that such a probe must never be read as one.
function isSafari() {
  const ua = navigator.userAgent || '';
  if (!/Safari/.test(ua) || /Chrome|Chromium|Edg/.test(ua)) return false;
  // An installed Home Screen / Dock web app is the one documented exemption:
  // its storage is separate from ordinary Safari's, so the notice there would
  // be a false alarm rather than a missed warning. navigator.standalone is a
  // declarative property — reading it is not the write probe the design
  // forbids as proof of durability.
  if (navigator.standalone === true) return false;
  return true;
}

function renderStatus(event) {
  const revisionEl = document.getElementById('status-revision');
  const retentionEl = document.getElementById('status-retention');
  const noticeEl = document.getElementById('status-notice');

  if (event.type === 'saved') {
    revisionEl.className = 'state-saved';
    revisionEl.textContent = `${t('status.saved')} · ${new Date(event.completedAt).toLocaleTimeString()}`;
    // The sidebar derives titles from what is persisted, so it can lag the
    // editor mid-typing (QA: "the sidebar shows only the first letter").
    // A durable save is the exact moment the persisted title catches up —
    // refresh the list then, debounced so a burst of flushes is one repaint.
    if (notesPanelHandle) {
      if (savedRefreshTimer) clearTimeout(savedRefreshTimer);
      savedRefreshTimer = setTimeout(() => {
        savedRefreshTimer = null;
        notesPanelHandle.refresh();
      }, 400);
    }
  } else if (event.type === 'saving') {
    revisionEl.className = '';
    revisionEl.textContent = t('status.saving');
  } else if (event.type === 'memory-only') {
    revisionEl.className = 'state-failed';
    revisionEl.textContent = t('status.notSaved');
  } else if (event.type === 'save-failed') {
    // An ordinary transient failure: the visible text is unchanged and no
    // rescue buffer was populated (that is what 'memory-only' is for), so
    // this must not borrow that event's wording — see final-review Fix 4.
    revisionEl.className = 'state-failed';
    revisionEl.textContent = t('status.saveFailed');
  } else if (event.type === 'retention-changed') {
    const key = { persistent: 'retention.persistent', 'best-effort': 'retention.bestEffort', 'session-only': 'retention.sessionOnly', unknown: 'retention.unknown' }[event.retention] || 'retention.unknown';
    retentionEl.className = event.retention === 'best-effort' || event.retention === 'session-only' ? 'state-warning' : 'state-info';
    retentionEl.textContent = `${t('retention.label')}: ${t(key)}`;
  } else if (event.type === 'quota-warning') {
    noticeEl.hidden = false;
    noticeEl.className = 'state-warning';
    noticeEl.textContent = t('status.quotaWarning');
  } else if (event.type === 'storage-unavailable') {
    // Post-boot occurrence (e.g. another tab's upgrade force-closed this
    // connection) — the initial boot-time case is handled directly in boot()
    // before this subscriber even exists.
    addNotice(t(STORAGE_REASON_KEYS[event.reason] || 'error.storageUnavailable'));
  } else if (event.type === 'note-changed') {
    // Emitted by setPinned/trashNote/restoreNote/purgeNote/restoreVersion.
    // None of those carry enough information here to update the list in
    // place, and none of them fire anywhere near per-keystroke frequency, so
    // a full list refresh on each is cheap and correct.
    if (notesPanelHandle) notesPanelHandle.refresh();
  }
}

async function boot() {
  const lang = detectLanguage();
  setLanguage(lang);
  document.documentElement.lang = lang;

  let status;
  try {
    status = await store.open({});
  } catch (error) {
    // store.open() throws (rather than resolving with available:false) only
    // for a version-mismatch: this page is older than the database on disk.
    // That must never be silent — an unhandled rejection here would leave the
    // status bar blank forever with no explanation.
    addNotice(t('error.versionMismatch'));
    return;
  }

  store.subscribe(renderStatus);

  // Only render retention at boot when it is a definitive answer. Painting
  // "Browser retention: Unknown" on every load — for a product whose whole
  // pitch is that notes stay put — reads as an alarm, then flickers to
  // "Persistent" a moment later. The '—' placeholder is quieter than a
  // scary word, and the real state arrives via retention-changed shortly.
  if (status.retention && status.retention !== 'unknown') {
    renderStatus({ type: 'retention-changed', retention: status.retention });
  }

  if (!status.available) {
    addNotice(t(STORAGE_REASON_KEYS[status.reason] || 'error.storageUnavailable'));
  } else if (isSafari()) {
    // Standing notice, not a transient one: shown once at boot and left
    // visible for the session, regardless of what retention-changed later
    // reports (persist() granting 'persistent' on Safari is not understood
    // to be an exemption from its storage caps — see design doc). 'info'
    // tone: this is retention information, not a failure.
    addNotice(t('notice.safariNonDurable'), 'info');
  }

  let activeEditor = null;
  // History is closed by default (brand brief §6: "Version panel: closed by
  // default"); the preference persists for the session, so switching notes
  // keeps whichever state the user last chose.
  let historyOpen = false;

  function toggleTheme() {
    const root = document.documentElement;
    const systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    const current = root.dataset.theme || (systemPrefersLight ? 'light' : 'dark');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('heldnote-theme', next); } catch (e) { /* non-fatal */ }
  }

  function renderHistoryForCurrent() {
    const panel = document.getElementById('history-panel');
    if (!historyOpen || !currentNoteId) {
      panel.hidden = true;
      return;
    }
    const id = currentNoteId;
    // A restore changes the note's draft text underneath the editor, so the
    // editor must reload from store rather than keep showing the pre-restore
    // text; re-opening it (same as a fresh selection) is the simplest way to
    // pick up what restoreVersion just wrote.
    //
    // But history-ui.js's restore-in-progress retry loop can take up to
    // ~1.2s to settle, and the user may have selected a different note by
    // then. onRestore fires against whatever note it was created for (`id`,
    // captured here), so it must check that note is still the one on screen
    // before touching the editor — otherwise a slow retry for note A that
    // resolves after the user has already switched to note B would yank B's
    // editor out from under them and silently swap in A's.
    renderHistoryPanel(panel, id, {
      onRestore: () => { if (id === currentNoteId) openEditor(id); },
    });
  }

  function openEditor(id) {
    currentNoteId = id;
    currentNoteRev = 0;
    if (activeEditor) activeEditor.destroy();
    activeEditor = renderEditor(document.getElementById('editor-panel'), id, {
      onRevChange: (rev) => { currentNoteRev = rev; },
      onTitleChange: () => { if (notesPanelHandle) notesPanelHandle.refresh(); },
      onError: addNotice,
      historyOpen,
      onToggleHistory: () => {
        historyOpen = !historyOpen;
        renderHistoryForCurrent();
        return historyOpen;
      },
    });
    renderHistoryForCurrent();
  }

  function renderEmptyState() {
    const panel = document.getElementById('editor-panel');
    panel.innerHTML = `
      <div class="editor-empty">
        ${BRAND_MARK.replace('width="22" height="22"', 'width="44" height="44"')}
        <h2>${t('empty.title')}</h2>
        <p>${t('empty.body')}</p>
        <button id="empty-new-note">${t('empty.cta')}</button>
      </div>
    `;
    panel.querySelector('#empty-new-note').addEventListener('click', async () => {
      const note = await store.createNote();
      if (notesPanelHandle) notesPanelHandle.refresh();
      selectNote(note.id);
    });
  }

  function closeEditor() {
    currentNoteId = null;
    currentNoteRev = 0;
    if (activeEditor) { activeEditor.destroy(); activeEditor = null; }
    renderEmptyState();
    document.getElementById('history-panel').hidden = true;
    if (notesPanelHandle) notesPanelHandle.setActive(null);
  }

  function selectNote(id) {
    openEditor(id);
    if (notesPanelHandle) notesPanelHandle.setActive(id);
  }

  // Called after any import completes. 'replace' wipes the database
  // wholesale, so the note open in the editor (if any) very likely no longer
  // exists; 'copy' never removes the original, but reloading is still cheap
  // and correct either way, in case the id happened to collide.
  async function handleImportComplete() {
    if (!currentNoteId) return;
    const id = currentNoteId;
    try {
      await store.getNote(id);
      selectNote(id);
    } catch (error) {
      closeEditor();
    }
  }

  // Called after a trash purge. Unlike the other four note-changed sources,
  // a purge can remove the very note the editor has open, and that is not
  // something a plain list refresh fixes.
  function handleNoteDeleted(id) {
    if (id === currentNoteId) closeEditor();
  }

  notesPanelHandle = renderNotesPanel(document.getElementById('notes-panel'), {
    onSelect: selectNote,
    onImportComplete: handleImportComplete,
    onNoteDeleted: handleNoteDeleted,
    onToggleTheme: toggleTheme,
  });

  // First paint: an invitation to act, never a blank pane. If notes already
  // exist, open the most recent one so returning users land back in their
  // writing; on a truly first visit, show the empty state.
  try {
    const existing = await store.listNotes({});
    if (existing.length > 0) {
      // "Return anytime" means returning to where you left off: open the
      // most recently edited note, not whichever pinned note sorts first.
      const mostRecent = existing.reduce((best, note) => (note.updatedAt > best.updatedAt ? note : best));
      selectNote(mostRecent.id);
    } else {
      renderEmptyState();
    }
  } catch (error) {
    renderEmptyState();
  }

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentNoteId) {
      store.flush(currentNoteId, currentNoteRev).catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => {
    if (currentNoteId) store.flush(currentNoteId, currentNoteRev).catch(() => {});
  });
}

boot().catch((error) => {
  console.error('heldnote: boot failed', error);
});

export { currentNoteId, currentNoteRev };
