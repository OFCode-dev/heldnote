// history-ui.js
import * as store from './store.js';
import { t } from './i18n.js';

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

export function renderHistoryPanel(container, noteId, { onRestore } = {}) {
  container.hidden = false;
  container.innerHTML = `<h2>${t('history.title')}</h2><ul id="version-list"></ul><div id="version-preview"></div>`;
  const list = container.querySelector('#version-list');
  const preview = container.querySelector('#version-preview');

  async function refresh() {
    const versions = await store.listVersions(noteId, {});
    list.innerHTML = '';
    for (const info of versions) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = new Date(info.at).toLocaleString();
      button.setAttribute('aria-label', t('history.preview'));
      button.addEventListener('click', async () => {
        const full = await store.getVersion(noteId, info.seq);
        preview.innerHTML = '';
        const pre = document.createElement('pre');
        pre.textContent = full.text;
        const restoreButton = document.createElement('button');
        restoreButton.textContent = t('history.restoreConfirm');
        restoreButton.addEventListener('click', async () => {
          restoreButton.disabled = true;
          try {
            await restoreWithRetry(noteId, info.seq);
            preview.innerHTML = `<p>${t('history.restored')}</p>`;
            await refresh();
            if (onRestore) onRestore();
          } catch (error) {
            preview.innerHTML = `<p role="alert">${t('history.restoreFailed')}</p>`;
          }
        });
        preview.append(pre, restoreButton);
      });
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  refresh();
  return { refresh };
}
