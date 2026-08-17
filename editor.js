// editor.js
import * as store from './store.js';
import { t } from './i18n.js';

// Mirrors store.js's deriveTitle() for change-detection only: this value is
// never displayed as the canonical title in the note list (that always renders
// what store.js actually derived and persisted); here it also feeds the
// editor's own heading, where a small drift against store.js's algorithm is
// harmless — worst case a heading that lags one refresh behind the list.
function deriveTitle(text) {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0);
  return firstLine ? firstLine.trim().slice(0, 200) : 'Untitled';
}

function countWords(text) {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

export function renderEditor(container, noteId, { onRevChange, onTitleChange, onError, onToggleHistory, historyOpen = false } = {}) {
  container.innerHTML = `
    <div class="editor-header">
      <h1 class="note-heading"></h1>
      <button id="toggle-history" aria-pressed="${historyOpen}">${t('editor.history')}</button>
    </div>
    <textarea id="editor" aria-label="Note text"></textarea>
  `;
  const textarea = container.querySelector('#editor');
  const heading = container.querySelector('.note-heading');
  const historyButton = container.querySelector('#toggle-history');
  const countsEl = document.getElementById('status-counts');

  historyButton.addEventListener('click', () => {
    if (!onToggleHistory) return;
    const nowOpen = onToggleHistory();
    historyButton.setAttribute('aria-pressed', String(!!nowOpen));
  });

  let idleTimer = null;
  let maxWaitTimer = null;
  let destroyed = false;
  let lastReportedTitle = null;

  function renderHeading(text) {
    const title = deriveTitle(text);
    heading.textContent = title === 'Untitled' ? t('note.untitled') : title;
  }

  function renderCounts(text) {
    if (!countsEl) return;
    countsEl.textContent = `${countWords(text)} ${t('status.words')} · ${text.length} ${t('status.chars')}`;
  }

  function reportTitleIfChanged(text) {
    if (!onTitleChange) return;
    const title = deriveTitle(text);
    if (title === lastReportedTitle) return;
    lastReportedTitle = title;
    onTitleChange(title);
  }

  store.getNote(noteId).then((note) => {
    if (destroyed) return;
    textarea.value = note.text;
    renderHeading(note.text);
    renderCounts(note.text);
    textarea.focus();
    // Seeded, not reported: the note list already shows this title from the
    // selection that led here, so the first paint must not trigger a
    // redundant refresh — only a later, actual edit should.
    lastReportedTitle = deriveTitle(note.text);
    if (onRevChange) onRevChange(note.localRev);
  }).catch((error) => {
    if (destroyed) return;
    console.error('heldnote: could not load note', error);
    if (onError) onError(t('error.noteLoadFailed'));
  });

  function reportCommitFailure(error) {
    if (destroyed) return;
    console.error('heldnote: version commit failed', error);
    if (onError) onError(t('error.historyCommitFailed'));
  }

  function scheduleVersionCommit() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      store.commitVersion(noteId).catch(reportCommitFailure);
      idleTimer = null;
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }, 2000);

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        store.commitVersion(noteId).catch(reportCommitFailure);
        maxWaitTimer = null;
        // Also cancel the pending idle timer: if the last keystroke landed close
        // enough to the 2-minute mark, both timers could otherwise fire within
        // milliseconds of each other and call commitVersion concurrently for the
        // same note — commitVersion's seq allocation is not safe against that
        // (see Task 8's ledger note). Only one commit per typing episode.
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      }, 120000);
    }
  }

  function onInput() {
    const rev = store.saveDraft(noteId, textarea.value);
    if (onRevChange) onRevChange(rev);
    renderHeading(textarea.value);
    renderCounts(textarea.value);
    reportTitleIfChanged(textarea.value);
    scheduleVersionCommit();
  }

  textarea.addEventListener('input', onInput);

  return {
    destroy() {
      destroyed = true;
      textarea.removeEventListener('input', onInput);
      clearTimeout(idleTimer);
      clearTimeout(maxWaitTimer);
      if (countsEl) countsEl.textContent = '';
    },
    setHistoryOpen(open) {
      historyButton.setAttribute('aria-pressed', String(!!open));
    },
  };
}
