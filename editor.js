// editor.js
import * as store from './store.js';
import { t } from './i18n.js';
import { ICONS } from './icons.js';

function countWords(text) {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

// The macOS-HUD confirmation toast Quick Web Notepad ships: blooms in at
// 150ms, dissolves out over 2s, pointer-events none so it can never block
// anything. One shared element, lazily created.
let hudTimer = null;
function showHud(label) {
  let hud = document.getElementById('hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML = `<div class="hud-mark">${ICONS.check}</div><div class="hud-label"></div>`;
    document.body.appendChild(hud);
  }
  hud.querySelector('.hud-label').textContent = label;
  hud.classList.remove('out');
  // force a restart of the transition when fired twice quickly
  void hud.offsetWidth;
  hud.classList.add('show');
  if (hudTimer) clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    hud.classList.remove('show');
    hud.classList.add('out');
  }, 900);
}

const ZOOM_KEY = 'heldnote-zoom';
const WRAP_KEY = 'heldnote-wrap';
// 18px Source Serif 4 at line-height 1.7 — the reading rhythm from
// redesign-plan §3 (serif faces set slightly larger than the old monospace).
const BASE_FONT_PX = 18;

function loadZoom() {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isFinite(value) && value >= 60 && value <= 200 ? value : 100;
  } catch (e) { return 100; }
}

function loadWrap() {
  try { return localStorage.getItem(WRAP_KEY) !== 'off'; } catch (e) { return true; }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renderEditor(container, noteId, { onRevChange, onTitleChange, onError, onToggleHistory, onBack, historyOpen = false } = {}) {
  container.innerHTML = `
    <div class="editor-sheet">
      <div class="editor-header">
        <button id="editor-back" aria-label="${t('nav.backToNotes')}">${ICONS.chevronLeft}<span>${t('nav.backToNotes')}</span></button>
        <h1 class="note-heading"><input id="note-name" aria-label="${t('editor.rename')}" title="${t('editor.rename')}" maxlength="200" spellcheck="false" autocomplete="off"></h1>
        <div class="editor-tools" role="toolbar" aria-label="${t('editor.toolsLabel')}">
          <button id="tool-copy" title="${t('editor.copy')}" aria-label="${t('editor.copy')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>
          <button id="tool-download" title="${t('editor.download')}" aria-label="${t('editor.download')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"/></svg></button>
          <button id="tool-find" title="${t('find.open')} (Ctrl+F)" aria-label="${t('find.open')}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/></svg></button>
          <button id="tool-wrap" title="${t('editor.wrap')}" aria-label="${t('editor.wrap')}" aria-pressed="true">${ICONS.wrap}</button>
          <button id="tool-zoom-out" title="A−">A−</button>
          <button id="tool-zoom-in" title="A+">A+</button>
          <button id="toggle-history" aria-pressed="${historyOpen}" aria-expanded="${historyOpen}">${t('editor.history')}</button>
        </div>
      </div>
      <div id="find-bar" hidden>
        <input id="find-input" type="text" placeholder="${t('find.placeholder')}" aria-label="${t('find.placeholder')}">
        <span id="find-count" aria-live="polite"></span>
        <button id="find-prev" title="${t('find.prev')}" aria-label="${t('find.prev')}">${ICONS.chevronUp}</button>
        <button id="find-next" title="${t('find.next')}" aria-label="${t('find.next')}">${ICONS.chevronDown}</button>
        <label class="find-flag"><input id="find-case" type="checkbox">Aa</label>
        <label class="find-flag"><input id="find-regex" type="checkbox">.*</label>
        <input id="replace-input" type="text" placeholder="${t('find.replacePlaceholder')}" aria-label="${t('find.replacePlaceholder')}">
        <button id="replace-one">${t('find.replace')}</button>
        <button id="replace-all">${t('find.replaceAll')}</button>
        <button id="find-close" title="Esc" aria-label="Esc">${ICONS.close}</button>
      </div>
      <textarea id="editor" aria-label="Note text" spellcheck="false"></textarea>
    </div>
  `;
  const textarea = container.querySelector('#editor');
  const nameInput = container.querySelector('#note-name');
  const historyButton = container.querySelector('#toggle-history');
  const countsEl = document.getElementById('status-counts');
  const findBar = container.querySelector('#find-bar');
  const findInput = container.querySelector('#find-input');
  const findCount = container.querySelector('#find-count');
  const replaceInput = container.querySelector('#replace-input');
  const caseBox = container.querySelector('#find-case');
  const regexBox = container.querySelector('#find-regex');

  let zoom = loadZoom();
  let wrapOn = loadWrap();

  function applyZoom() {
    textarea.style.fontSize = `${Math.round(BASE_FONT_PX * zoom / 100)}px`;
    renderPosition();
  }
  function applyWrap() {
    textarea.style.whiteSpace = wrapOn ? 'pre-wrap' : 'pre';
    textarea.style.overflowX = wrapOn ? 'hidden' : 'auto';
    container.querySelector('#tool-wrap').setAttribute('aria-pressed', String(wrapOn));
  }
  applyZoom();
  applyWrap();

  // Focus synchronously, before the note text loads. QA proved that any
  // async gap here turns immediate typing into disaster: with focus still
  // on the New note button, Space/Enter re-clicked it (junk notes) and
  // every other character vanished. An empty focused textarea accepts those
  // first keystrokes instead; the load below is careful not to clobber them.
  textarea.focus();

  historyButton.addEventListener('click', () => {
    if (!onToggleHistory) return;
    const nowOpen = onToggleHistory();
    historyButton.setAttribute('aria-pressed', String(!!nowOpen));
    historyButton.setAttribute('aria-expanded', String(!!nowOpen));
  });

  // Mobile single-pane shell: the back control returns to the notes list.
  // CSS hides it from 768px up, where the list is always on screen.
  container.querySelector('#editor-back').addEventListener('click', () => {
    if (onBack) onBack();
  });

  let idleTimer = null;
  let maxWaitTimer = null;
  let destroyed = false;

  // --- The filename control (docs/filename-plan.md §1.2) -----------------
  // The name is user-set and independent of the text; renameNote is its only
  // writer. committedName is the last value the store confirmed (or loaded) —
  // Escape and empty-commit revert to it, and downloads read it.
  let committedName = '';

  function commitName() {
    const next = nameInput.value.replace(/[/\\]/g, '').trim().slice(0, 200);
    if (!next) {
      nameInput.value = committedName;
      return;
    }
    if (next === committedName) {
      nameInput.value = next;
      return;
    }
    nameInput.value = next;
    store.renameNote(noteId, next).then(() => {
      committedName = next;
      // The tab title (and anything else watching) reflects only a rename
      // the store confirmed.
      if (onTitleChange) onTitleChange(next);
    }).catch((error) => {
      console.error('heldnote: rename failed', error);
      nameInput.value = committedName;
      if (onError) onError(t('error.renameFailed'));
    });
  }

  nameInput.addEventListener('focus', () => {
    // QWN's affordance: select the basename, keep the extension, so typing
    // replaces the name without clobbering ".md". setTimeout(0) defeats the
    // browser's own select-all-on-focus. If the user has already started
    // typing by the time this fires, their edit wins — re-selecting under a
    // fast typist would swallow keystrokes.
    const value = nameInput.value;
    const dot = value.lastIndexOf('.');
    setTimeout(() => {
      if (nameInput.value !== value || document.activeElement !== nameInput) return;
      nameInput.setSelectionRange(0, dot > 0 ? dot : value.length);
    }, 0);
  });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      nameInput.blur(); // blur commits; then hand focus back to the text
      textarea.focus();
    } else if (event.key === 'Escape') {
      event.stopPropagation(); // must not reach the global Escape (find bar)
      nameInput.value = committedName;
      nameInput.blur();
      textarea.focus();
    }
  });
  nameInput.addEventListener('blur', commitName);

  function renderCounts(text) {
    if (!countsEl) return;
    const upTo = textarea.value.slice(0, textarea.selectionStart || 0);
    const line = (upTo.match(/\n/g) || []).length + 1;
    const col = upTo.length - upTo.lastIndexOf('\n');
    const zoomPart = zoom !== 100 ? ` · ${zoom}%` : '';
    countsEl.textContent = `${t('status.line')} ${line}:${col} · ${countWords(text)} ${t('status.words')} · ${text.length} ${t('status.chars')}${zoomPart}`;
  }

  function renderPosition() {
    renderCounts(textarea.value);
  }

  store.getNote(noteId).then((note) => {
    if (destroyed) return;
    // Seed the filename control. The || fallback is display-only, for
    // legacy/corrupt records whose title was deleted — it is never
    // auto-committed as a rename.
    const name = note.title || 'Untitled.txt';
    committedName = name;
    // Never clobber an in-progress rename: the user may already be typing in
    // the name input while this async load resolves.
    if (document.activeElement !== nameInput) nameInput.value = name;
    if (onTitleChange) onTitleChange(name);
    // Anything typed during the load already went through onInput and is
    // saved as this note's draft, so for a brand-new (empty) note the typed
    // text IS the newer truth — overwriting it with the stored '' would
    // throw away the user's first sentence. Only an actually non-empty
    // stored note replaces what is on screen.
    const typedDuringLoad = textarea.value;
    if (note.text || !typedDuringLoad) {
      textarea.value = note.text;
      renderCounts(note.text);
      if (onRevChange) onRevChange(note.localRev);
    }
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

  // Typing touches the text only — never the name. This is the visible proof
  // that the filename is independent of the first line.
  function onInput() {
    const rev = store.saveDraft(noteId, textarea.value);
    if (onRevChange) onRevChange(rev);
    renderCounts(textarea.value);
    scheduleVersionCommit();
  }

  textarea.addEventListener('input', onInput);

  // Ln:Col tracks the caret, not just typing.
  const onSelectionMove = () => renderPosition();
  textarea.addEventListener('keyup', onSelectionMove);
  textarea.addEventListener('click', onSelectionMove);

  // --- Tools: copy, download, wrap, zoom -------------------------------

  container.querySelector('#tool-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(textarea.value);
      showHud(t('toast.copied'));
    } catch (e) {
      textarea.select();
      document.execCommand('copy');
      showHud(t('toast.copied'));
    }
  });

  container.querySelector('#tool-download').addEventListener('click', () => {
    // Commit any in-progress name edit first: Ctrl+S straight after typing a
    // new name must download under that name, not the stale one.
    commitName();
    // The filename is used verbatim — "Untitled.json goes as-is". No .txt
    // appending, no character mangling beyond the separators commitName and
    // the store already strip. Blob type stays text/plain regardless of
    // extension (MIME-from-extension is out of scope).
    const blob = new Blob([textarea.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nameInput.value || committedName || 'Untitled.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showHud(t('toast.downloaded'));
  });

  container.querySelector('#tool-wrap').addEventListener('click', () => {
    wrapOn = !wrapOn;
    try { localStorage.setItem(WRAP_KEY, wrapOn ? 'on' : 'off'); } catch (e) { /* cosmetic */ }
    applyWrap();
  });

  function setZoom(next) {
    zoom = Math.min(200, Math.max(60, next));
    try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch (e) { /* cosmetic */ }
    applyZoom();
  }
  container.querySelector('#tool-zoom-out').addEventListener('click', () => setZoom(zoom - 10));
  container.querySelector('#tool-zoom-in').addEventListener('click', () => setZoom(zoom + 10));

  // --- Find & replace ---------------------------------------------------
  //
  // Selection-based like a plain editor: matches are counted with a regex,
  // navigation selects the match in the textarea and scrolls it into view.
  // Replacements go through the exact same input path as typing, so drafts
  // and version history see them like any other edit.

  function buildPattern() {
    const raw = findInput.value;
    if (!raw) return null;
    const flags = caseBox.checked ? 'g' : 'gi';
    try {
      return new RegExp(regexBox.checked ? raw : escapeRegExp(raw), flags);
    } catch (e) {
      return 'invalid';
    }
  }

  function allMatches() {
    const pattern = buildPattern();
    if (!pattern || pattern === 'invalid') return { pattern, matches: [] };
    const matches = [];
    let m;
    while ((m = pattern.exec(textarea.value)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) pattern.lastIndex += 1; // zero-width safety
      if (matches.length > 9999) break;
    }
    return { pattern, matches };
  }

  function updateFindCount(current) {
    const { pattern, matches } = allMatches();
    if (pattern === 'invalid') { findCount.textContent = t('find.invalid'); return matches; }
    if (!pattern) { findCount.textContent = ''; return matches; }
    findCount.textContent = current != null && matches.length > 0
      ? `${current + 1}/${matches.length}`
      : String(matches.length);
    return matches;
  }

  function jump(direction) {
    const matches = updateFindCount();
    if (matches.length === 0) return;
    const from = direction > 0 ? textarea.selectionEnd : textarea.selectionStart;
    let index = direction > 0
      ? matches.findIndex((m) => m.start >= from)
      : (() => { let last = -1; matches.forEach((m, i) => { if (m.end <= from) last = i; }); return last; })();
    if (index === -1) index = direction > 0 ? 0 : matches.length - 1;
    const match = matches[index];
    textarea.setSelectionRange(match.start, match.end);
    // Scroll the selection into view: a hidden trick — blur/focus recenters
    // the caret in most engines; cheaper than mirror-div measurement.
    textarea.blur();
    textarea.focus();
    updateFindCount(index);
  }

  function replaceCurrent() {
    const matches = updateFindCount();
    const { selectionStart, selectionEnd } = textarea;
    const hit = matches.find((m) => m.start === selectionStart && m.end === selectionEnd);
    if (!hit) { jump(1); return; }
    textarea.setRangeText(replaceInput.value, hit.start, hit.end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    jump(1);
  }

  function replaceAll() {
    const { pattern, matches } = allMatches();
    if (!pattern || pattern === 'invalid' || matches.length === 0) return;
    const replacement = replaceInput.value;
    textarea.value = regexBox.checked
      ? textarea.value.replace(pattern, replacement)
      : textarea.value.replace(pattern, () => replacement);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    updateFindCount();
    showHud(`${matches.length} ${t('find.replaced')}`);
  }

  function openFind() {
    findBar.hidden = false;
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (selected && selected.length < 80 && !selected.includes('\n')) findInput.value = selected;
    findInput.focus();
    findInput.select();
    updateFindCount();
  }

  function closeFind() {
    findBar.hidden = true;
    findCount.textContent = '';
    textarea.focus();
  }

  container.querySelector('#tool-find').addEventListener('click', () => {
    if (findBar.hidden) openFind(); else closeFind();
  });
  container.querySelector('#find-next').addEventListener('click', () => jump(1));
  container.querySelector('#find-prev').addEventListener('click', () => jump(-1));
  container.querySelector('#replace-one').addEventListener('click', replaceCurrent);
  container.querySelector('#replace-all').addEventListener('click', replaceAll);
  container.querySelector('#find-close').addEventListener('click', closeFind);
  findInput.addEventListener('input', () => updateFindCount());
  caseBox.addEventListener('change', () => updateFindCount());
  regexBox.addEventListener('change', () => updateFindCount());
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); jump(event.shiftKey ? -1 : 1); }
  });

  const onGlobalKeydown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openFind();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      container.querySelector('#tool-download').click();
    } else if (event.key === 'Escape' && !findBar.hidden) {
      closeFind();
    }
  };
  document.addEventListener('keydown', onGlobalKeydown);

  return {
    destroy() {
      destroyed = true;
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('keyup', onSelectionMove);
      textarea.removeEventListener('click', onSelectionMove);
      document.removeEventListener('keydown', onGlobalKeydown);
      clearTimeout(idleTimer);
      clearTimeout(maxWaitTimer);
      if (countsEl) countsEl.textContent = '';
    },
    setHistoryOpen(open) {
      historyButton.setAttribute('aria-pressed', String(!!open));
      historyButton.setAttribute('aria-expanded', String(!!open));
    },
  };
}
