// app.js
import * as store from './store.js';
import { t, setLanguage, detectLanguage } from './i18n.js';

let currentNoteId = null;
let currentNoteRev = 0; // set by Task 18's editor via onRevChange; flush() target for lifecycle events

function renderStatus(event) {
  const revisionEl = document.getElementById('status-revision');
  const retentionEl = document.getElementById('status-retention');

  if (event.type === 'saved') {
    revisionEl.className = 'state-saved';
    revisionEl.textContent = `${t('status.saved')} · ${new Date(event.completedAt).toLocaleTimeString()}`;
  } else if (event.type === 'saving') {
    revisionEl.className = '';
    revisionEl.textContent = t('status.saving');
  } else if (event.type === 'memory-only') {
    revisionEl.className = 'state-failed';
    revisionEl.textContent = t('status.notSaved');
  } else if (event.type === 'retention-changed') {
    const key = { persistent: 'retention.persistent', 'best-effort': 'retention.bestEffort', 'session-only': 'retention.sessionOnly', unknown: 'retention.unknown' }[event.retention] || 'retention.unknown';
    retentionEl.className = event.retention === 'best-effort' || event.retention === 'session-only' ? 'state-warning' : 'state-info';
    retentionEl.textContent = `${t('retention.label')}: ${t(key)}`;
  }
}

async function boot() {
  setLanguage(detectLanguage());

  const status = await store.open({});
  store.subscribe(renderStatus);

  if (!status.available) {
    document.getElementById('editor-panel').insertAdjacentHTML('afterbegin', `<div role="alert">${status.reason}</div>`);
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

boot();

export { currentNoteId, currentNoteRev };
