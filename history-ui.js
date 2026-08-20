// history-ui.js
import * as store from './store.js';
import { t } from './i18n.js';
import { ICONS } from './icons.js';

// A restore can legitimately reject with code 'restore-in-progress' when it
// collides with either another restore or (far more commonly) the editor's
// routine 2s-idle-timer commitVersion() landing at the same instant (see
// store.js Task 9/10 ledger notes). That is not a real failure, so a user
// clicking "restore" must never see it as one: retry silently a handful of
// times before surfacing anything.
const RESTORE_RETRY_ATTEMPTS = 5;
const RESTORE_RETRY_DELAY_MS = 300;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function restoreWithRetry(noteId, seq) {
  for (let attempt = 1; attempt <= RESTORE_RETRY_ATTEMPTS; attempt++) {
    try {
      return await store.restoreVersion(noteId, seq);
    } catch (error) {
      const isRetriable = error && error.code === 'restore-in-progress';
      if (!isRetriable || attempt === RESTORE_RETRY_ATTEMPTS) throw error;
      await delay(RESTORE_RETRY_DELAY_MS);
    }
  }
}

export function renderHistoryPanel(container, noteId, { onRestore, onClose } = {}) {
  container.hidden = false;
  // The close control matters most on small screens, where this panel is a
  // full-height sheet covering the History toggle that opened it. At the
  // >=1024px third-column layout CSS hides it (the toggle is visible there).
  container.innerHTML = `
    <div class="history-head">
      <h2>${t('history.title')}</h2>
      <button id="history-close" aria-label="${t('history.close')}" title="${t('history.close')}">${ICONS.close}</button>
    </div>
    <ul id="version-list"></ul><div id="version-preview"></div><div id="history-notice" role="alert" hidden></div>`;
  container.querySelector('#history-close').addEventListener('click', () => {
    if (onClose) onClose();
  });
  const list = container.querySelector('#version-list');
  const preview = container.querySelector('#version-preview');
  // Separate from `preview`, and deliberately NOT gated by previewToken below:
  // a restore failure is a real, user-actionable event that must surface even
  // if the user has since clicked away to preview a different version. The
  // preview pane itself is fine to lose a stale update (nothing incorrect is
  // shown), but silently dropping a genuine failure would leave a stuck
  // restore with no visible sign anything went wrong.
  const notice = container.querySelector('#history-notice');
  function showNotice(message) {
    notice.hidden = false;
    notice.textContent = message;
  }
  function hideNotice() {
    notice.hidden = true;
    notice.textContent = '';
  }
  // Bumped on every preview click so a slow restore retry loop from an older
  // click (still awaiting store.restoreVersion) can tell, once it finally
  // settles, that the user has since previewed something else — and skip
  // writing into a preview pane that has moved on. Same shape as editor.js's
  // `destroyed` flag guarding its own late-arriving async callback. This only
  // gates the preview pane's own text, never the failure notice above.
  let previewToken = 0;

  async function refresh() {
    const versions = await store.listVersions(noteId, {});
    list.innerHTML = '';
    if (versions.length === 0) {
      const li = document.createElement('li');
      li.className = 'version-empty';
      li.textContent = t('history.empty');
      list.appendChild(li);
      return;
    }
    const newestSeq = versions.reduce((max, v) => Math.max(max, v.seq), -Infinity);
    for (const info of versions) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      const when = document.createElement('span');
      when.className = 'version-when';
      when.textContent = info.seq === newestSeq
        ? `${new Date(info.at).toLocaleString()} · ${t('history.latest')}`
        : new Date(info.at).toLocaleString();
      button.appendChild(when);
      // A bare timestamp says nothing about WHAT a version contains; a first
      // line makes the list scannable. One extra read per row, bounded by
      // the per-note history cap.
      store.getVersion(noteId, info.seq).then((full) => {
        const firstLine = (full.text.split('\n').find((line) => line.trim()) || '').slice(0, 48);
        if (!firstLine) return;
        const snippet = document.createElement('span');
        snippet.className = 'version-snippet';
        snippet.textContent = firstLine;
        button.appendChild(snippet);
      }).catch(() => { /* the row still works as a timestamp */ });
      button.setAttribute('aria-label', t('history.preview'));
      button.addEventListener('click', async () => {
        const token = ++previewToken;
        const full = await store.getVersion(noteId, info.seq);
        if (token !== previewToken) return;
        preview.innerHTML = '';
        const pre = document.createElement('pre');
        pre.textContent = full.text;
        // A verb-first button plus a separate reassurance caption: QA read
        // the old full-sentence button label as an explanatory paragraph and
        // could not find the control at all.
        const restoreButton = document.createElement('button');
        restoreButton.className = 'restore-version';
        restoreButton.textContent = t('history.restore');
        const caption = document.createElement('p');
        caption.className = 'restore-caption';
        caption.textContent = t('history.restoreCaption');
        restoreButton.addEventListener('click', async () => {
          restoreButton.disabled = true;
          hideNotice();
          try {
            await restoreWithRetry(noteId, info.seq);
            // refresh() and onRestore() reflect a real, already-committed change
            // to the note and its history, so both run unconditionally even if
            // the user has since moved on to preview something else. Only the
            // preview pane's own text is gated by the token, so a late result
            // does not overwrite whatever the user is now looking at.
            if (token === previewToken) preview.innerHTML = `<p>${t('history.restored')}</p>`;
            await refresh();
            if (onRestore) onRestore();
          } catch (error) {
            // Unlike the preview text above, this must never be silently
            // dropped just because the user looked at a different version in
            // the meantime — a genuinely stuck restore (retries exhausted, or
            // a non-retriable error) has to surface somehow. console.error is
            // for diagnostics; showNotice is the user-visible signal, and it
            // deliberately ignores the previewToken check.
            console.error('heldnote: restore failed', error);
            showNotice(t('history.restoreFailed'));
          }
        });
        preview.append(pre, restoreButton, caption);
      });
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  refresh();
  return { refresh };
}
