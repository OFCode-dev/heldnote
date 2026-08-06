// notes-ui.js
import * as store from './store.js';
import { t } from './i18n.js';

export function renderNotesPanel(container, { onSelect }) {
  container.innerHTML = `
    <button id="new-note">${t('notes.new')}</button>
    <input id="search" type="search" aria-label="${t('notes.searchLabel')}">
    <ul id="note-list"></ul>
    <div id="undo-banner" hidden></div>
  `;

  const list = container.querySelector('#note-list');
  const searchInput = container.querySelector('#search');
  let lastTrashedId = null;

  async function refresh() {
    const query = searchInput.value.trim() || undefined;
    const notes = await store.listNotes({ query });
    list.innerHTML = '';
    for (const note of notes) {
      const li = document.createElement('li');
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
    const note = await store.createNote();
    await refresh();
    onSelect(note.id);
  });

  searchInput.addEventListener('input', () => refresh());

  refresh();
  return { refresh };
}
