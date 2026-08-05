# Quick Keep Notepad — Design

- Date: 2026-08-05
- Status: Approved, not yet implemented
- Owner: Omer Faruk Bayrak (OFCode-dev)

This is the canonical design document. The planning artifacts under
`.claude/artifacts/` elaborate on it — requirements, data assessment, store
contract, risk review, and ADR 001. Where they disagree with this document, this
document wins.

## Why this project exists

`quick-web-notepad` keeps nothing. Searching its 1628 lines for `localStorage`,
`IndexedDB`, or `beforeunload` returns no matches. A refresh, a closed tab, or a
crash erases everything typed since the page opened, silently. Because the tool is
used for fast unplanned capture, what it loses is text that existed nowhere else.

Its single pad loses text a second way, without any crash: one buffer holds
everything, so a new thought overwrites an old one and yesterday's contents are
unreachable.

Quick Keep Notepad is the replacement. Many notes, saved continuously with no user
action, each with a history that makes overwriting recoverable.

## Scope

v1 is a static page, no server and no build step, holding notes in IndexedDB
inside one browser profile. Google Drive sync is the intended v2; the data model
carries the fields it will need, but no sync code ships now.

Deferred deliberately: sync, writing to disk, tags and folders, markdown preview,
sharing, encryption, the old protect mode, and syntax highlighting (v1.1).

## The persistence engine

Two layers, doing two different jobs. Conflating them is the mistake this design
is built to avoid.

**The draft layer — never lose.** Every keystroke writes the note's full text to a
single per-note record. No diffing, no history, no computation of any kind: just
the latest text. It is debounced by 300 ms, *and capped at one write per second
regardless of ongoing typing*. That cap matters more than it looks: a plain
debounce resets on every keystroke, so someone typing steadily without pause would
never trigger a write at all — exactly the user this product exists for. On
`visibilitychange` and `pagehide` the pending write is flushed immediately.
Worst case loss is the last moment of typing, and what comes back is read verbatim,
never reconstructed.

**The version layer — go back.** Roughly 2 s after typing stops, the note's full
text is committed as a snapshot. During unbroken typing a version is committed at
least every 2 minutes. Unchanged text commits nothing.

Snapshots rather than diffs: restoring is a read, not a replay, so history cannot
silently drift from what was written. Full rationale, including the diff design
that was adopted mid-design and then reversed, is in ADR 001.

**Pruning.** The newest 50 versions are kept in full; older ones are thinned to one
per day; a note holds at most 200 versions, oldest daily entries dropped first. The
newest version is never pruned. Pruning and trash purge run at startup, commit per
note, and are safe to interrupt and to re-run.

**Reconciliation on open.** The draft is normally newer than the newest version,
but after a partial failure it may not be. On open, the two timestamps are compared
and the newer text is presented. Assuming the draft is ahead would lose data in
exactly the case where care matters most.

## Data model

IndexedDB `quick-keep`, version 1, four stores. All timestamps are epoch
milliseconds.

- `notes`, keyed by `id` — `{ id, title, createdAt, updatedAt, deletedAt, pinned, rev }`,
  indexed by `updatedAt`, `deletedAt`, `pinned`. `title` is derived from the first
  non-empty line; there is no title field in the UI. `deletedAt` is the trash flag
  and the future sync tombstone. `rev` is written for v2 and unread in v1, so its
  invariants are asserted in tests — an unread field is an unverified one.
- `drafts`, keyed by `noteId` — `{ noteId, text, savedAt }`. One row per note.
- `versions`, keyed by `[noteId, seq]` — `{ noteId, seq, text, at }`, indexed by
  `[noteId, at]`. `seq` is per-note monotonic and never reused after pruning;
  reuse would let a restore collide with a pruned key.
- `meta`, keyed by `key` — theme, zoom, language, last opened note, schema version.

**There is no down migration.** IndexedDB versions only increase; opening an older
schema against a newer store throws `VersionError`. Because the app is served from
a CDN cache, a stale page shell can meet a newer database — and unhandled, that
looks exactly like total data loss. It must be caught and shown as "this browser
holds newer data than this page, reload to update". Future schema changes must be
additive and tolerant of unknown fields.

## Modules

One job per file. `store.js` is the only module that knows how anything is stored.

- `db.js` — IndexedDB open, schema, upgrade, a thin promise wrapper. The only file
  that names IndexedDB.
- `store.js` — the app's data API: notes, drafts, versions, maintenance, backup.
  No DOM.
- `editor.js` — textarea, line numbers, zoom, find and replace.
- `notes-ui.js` — list, search, pin, delete and undo.
- `history-ui.js` — version list, preview, restore.
- `i18n.js` — Turkish and English, following the browser.
- `app.js` — wiring, shortcuts, lifecycle events.

The boundary rule: **no type crossing `store.js` may name a storage mechanism.**
No transaction, no cursor, no `IDBRequest`. Callers ask for text and receive text.
This is what made reversing the snapshot/diff decision cost nothing outside one
file. The full contract is in `.claude/artifacts/planning/store-api.md`.

## Interface

Left: note list with search, new note, pinned first, each row showing title and
last-modified time. Centre: the editor. Right: the version panel, closed by
default — timestamps, preview on selection, restore on confirm. Restoring is
itself committed as a new version, so it can be undone by restoring the state
before it, and no version is ever destroyed by a restore.

The status bar is not decoration. It shows saved-at time or saving-in-progress,
plus counts, zoom, and language. The user does not trust what they cannot see, and
being trusted is the product.

Deleting sets a flag. The note leaves the list, an undo appears immediately, the
trash holds it for 30 days with its history intact.

Every control is keyboard-reachable with visible focus and a label. This is a text
editor; that is its basic surface, not an enhancement.

## Failure behaviour

The rule throughout: never lose silently, and never claim to have saved when
nothing was saved.

**Storage unavailable** — probed at startup with a real write, not a feature
check. A standing banner states that nothing is being saved and offers export.
The app stays usable and never shows a saved state.

**Persistence not granted** — requested after the first version commits, so the
prompt lands in a pause. If refused, a standing notice says the browser may remove
this data — in every browser, no exceptions. Safari's roughly seven-day eviction
of non-persistent storage is the sharpest case and remains an open question to
verify on a real device before release.

**Quota exhausted** — prune oldest versions, retry once. Still failing: version
commits stop, draft writes continue, the user is told history is no longer being
kept and offered export. Draft writes are the last thing sacrificed.

**Two tabs on one note** — tabs announce which note they hold over
`BroadcastChannel`. The second opens read-only with an explanation and an override.
Locks carry a heartbeat and expire, so a crashed tab cannot leave a note
permanently read-only.

**Database will not open** — offer export of whatever is readable, and rebuilding
from drafts.

## Backup

Export writes every note, its history, the trash, and settings to one JSON file
carrying its own `schemaVersion`. Import reads that version first and refuses a
file it does not understand rather than guessing. On merge, the newer `updatedAt`
wins and histories are combined; nothing is discarded silently. Replace runs as one
transaction, so an interrupted import cannot half-empty the database.

With no sync in v1, export is the only way out. It is a durability mechanism, not a
convenience.

## Testing

`store.js` is tested against real IndexedDB from a `tests.html` page in the repo —
a fake would be both a dependency and false confidence. The scenarios that matter:
write past the pruning thresholds and confirm the right versions survived and the
newest never went; restore an arbitrary version and confirm byte-identical text;
interrupt maintenance and re-run it; delete, undo, and confirm history survived;
export, wipe, import, and compare; assert `rev` invariants.

Pruning is the highest-risk logic in the system, because it is the only code that
deletes user data without being asked.

Manual checks, cheap to eyeball and expensive to automate: kill the tab
mid-sentence and reopen; type continuously for a minute and kill it without ever
pausing; fill the quota; open one note in two tabs; load in a private window.

## Open questions

Tracked in `.claude/artifacts/decisions/open-questions.md`. The blocking one:
whether Safari actually grants persistent storage for this origin. If it does not,
the product's central promise is false on a browser listed as must-support, and
that must be known before release rather than discovered by a user.
