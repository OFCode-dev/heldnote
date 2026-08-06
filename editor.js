// editor.js
import * as store from './store.js';

export function renderEditor(container, noteId, { onRevChange } = {}) {
  container.innerHTML = `<textarea id="editor" aria-label="Note text"></textarea>`;
  const textarea = container.querySelector('#editor');

  let idleTimer = null;
  let maxWaitTimer = null;
  let destroyed = false;

  store.getNote(noteId).then((note) => {
    if (destroyed) return;
    textarea.value = note.text;
    if (onRevChange) onRevChange(note.localRev);
  });

  function scheduleVersionCommit() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      store.commitVersion(noteId);
      idleTimer = null;
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }, 2000);

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        store.commitVersion(noteId);
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
    scheduleVersionCommit();
  }

  textarea.addEventListener('input', onInput);

  return {
    destroy() {
      destroyed = true;
      textarea.removeEventListener('input', onInput);
      clearTimeout(idleTimer);
      clearTimeout(maxWaitTimer);
    },
  };
}
