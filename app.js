// app.js
import * as store from './store.js';
import { t, setLanguage, detectLanguage } from './i18n.js';
import { renderNotesPanel } from './notes-ui.js';

let currentNoteId = null;
let currentNoteRev = 0; // set by Task 18's editor via onRevChange; flush() target for lifecycle events

const STORAGE_REASON_KEYS = {
  blocked: 'error.storageBlocked',
  corrupt: 'error.storageCorrupt',
  unavailable: 'error.storageUnavailable',
};

function showAlert(message) {
  document.getElementById('editor-panel').insertAdjacentHTML('afterbegin', `<div role="alert">${message}</div>`);
}

function renderStatus(event) {
  const revisionEl = document.getElementById('status-revision');
  const retentionEl = document.getElementById('status-retention');
  const noticeEl = document.getElementById('status-notice');

  if (event.type === 'saved') {
    revisionEl.className = 'state-saved';
    revisionEl.textContent = `${t('status.saved')} · ${new Date(event.completedAt).toLocaleTimeString()}`;
  } else if (event.type === 'saving') {
    revisionEl.className = '';
    revisionEl.textContent = t('status.saving');
  } else if (event.type === 'memory-only') {
    revisionEl.className = 'state-failed';
    revisionEl.textContent = t('status.notSaved');
  } else if (event.type === 'save-failed') {
    // Either a real write failure or a write superseded by a restore; either
    // way "Saving…" must not be left on screen forever.
    revisionEl.className = 'state-failed';
    revisionEl.textContent = t('status.notSaved');
  } else if (event.type === 'retention-changed') {
    const key = { persistent: 'retention.persistent', 'best-effort': 'retention.bestEffort', 'session-only': 'retention.sessionOnly', unknown: 'retention.unknown' }[event.retention] || 'retention.unknown';
    retentionEl.className = event.retention === 'best-effort' || event.retention === 'session-only' ? 'state-warning' : 'state-info';
    retentionEl.textContent = `${t('retention.label')}: ${t(key)}`;
  } else if (event.type === 'quota-warning') {
    noticeEl.hidden = false;
    noticeEl.className = 'state-warning';
    noticeEl.textContent = t('status.quotaWarning');
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
    showAlert(t('error.versionMismatch'));
    return;
  }

  store.subscribe(renderStatus);

  if (!status.available) {
    showAlert(t(STORAGE_REASON_KEYS[status.reason] || 'error.storageUnavailable'));
  }

  renderNotesPanel(document.getElementById('notes-panel'), {
    onSelect: (id) => { currentNoteId = id; /* Task 18 wires the editor to this */ },
  });

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
