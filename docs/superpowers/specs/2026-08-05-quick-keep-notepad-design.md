# Quick Keep Notepad — Design

- Date: 2026-08-05, revised 2026-08-06 after external review
- Status: Approved, not yet implemented
- Owner: Omer Faruk Bayrak (OFCode-dev)

This is the canonical design document. The planning artifacts under
`.claude/artifacts/` elaborate on it. Where they disagree with this document, this
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
carries what it will need, but no sync code ships now.

Deferred deliberately: sync, writing to disk, tags and folders, markdown preview,
sharing, encryption, the old protect mode, syntax highlighting (v1.1), semantic
merge on import, and simultaneously writable tabs.

## What the promise actually covers

"Nothing is ever lost" is a claim about this application's behaviour, not about the
browser's. The browser can delete an origin's storage, and no web application can
prevent it. The honest form of the promise is therefore two separate statements,
and the interface must keep them separate:

- **Durability of the latest revision** — the text you see has been committed to a
  completed IndexedDB transaction. This the app controls and guarantees.
- **Retention by the browser** — whether that storage survives eviction. This the
  app can only request, report, and never promise.

One green "Saved" that conflates these would be the product's central lie. The
status bar shows the durable revision *and* a retention state of `persistent`,
`best-effort`, `session-only`, or `unknown`.

## The persistence engine

Two layers, doing two different jobs.

**The draft layer — never lose.** The note's full current text is written to a
single per-note record. Writes are serialized and coalescing: at most one
transaction per note is in flight, new input replaces the queued payload with the
latest full text, and when a transaction completes with newer text waiting the next
starts immediately. **No accepted revision waits more than 300 ms** from the input
event to transaction completion — measured to `complete`, not to calling `put()`,
because a transaction can still fail after an individual request succeeds.

This replaces the earlier "300 ms debounce with a 1 s maximum wait", which
contradicted the durability window it was meant to serve: continuous typing could
leave nearly a second unsaved. Sustained writes rise to roughly three or four per
second, costing battery and I/O. That is the price of the 300 ms figure, and the
figure is the product.

Lifecycle flushing on `visibilitychange` and `pagehide` is still done, but it is
not load-bearing: a hidden tab can be discarded without another event, and a
renderer can be killed with no callback at all. Cadence is the guarantee; lifecycle
events are opportunistic.

**The version layer — go back.** Roughly 2 s after typing stops, the note's full
text is committed as a snapshot. During unbroken typing a version is committed at
least every 2 minutes. Unchanged text commits nothing.

Snapshots rather than diffs: restoring is a read, not a replay. Rationale in ADR 001.

**Ordering is by revision, never by clock.** Each accepted editor state increments a
monotonic `localRev`. The draft stores its `localRev`; each version stores the
`sourceRev` it was made from. Reconciliation on open compares revisions, not
timestamps, because a timestamp can be stamped at enqueue time while the write
completes much later — under which a version committed in between would wrongly
appear newer and hide a successfully stored draft. Clocks also move backwards.

On open the **draft is authoritative**. A version whose `sourceRev` exceeds the
draft's revision is an invariant violation, and is presented to the user as a
recovery choice rather than silently selected. Timestamps are for display and
retention only.

**Restore is one fenced operation.** Restoring must not destroy text that was saved
as a draft but never became a version. In a single transaction across notes,
drafts, and versions: capture and flush the current revision, invalidate every
older queued write, read the current draft, insert it as a pre-restore checkpoint
if it differs from the newest snapshot, write the restored text as a new draft
revision, insert it as a new version, update metadata. The new durable revision is
published only after the transaction completes.

The same pre-change checkpoint rule applies to any bulk destructive edit, which is
what makes replace-all safe to keep.

## Data model

IndexedDB `quick-keep`, version 1, four stores. Timestamps are epoch milliseconds.

**Only indexable values may be indexed.** IndexedDB keys must be numbers, strings,
dates, binary values, or arrays of those. Booleans and `null` are not valid keys,
and a record whose indexed value is invalid is written to the store but *silently
omitted from the index*. Indexing a boolean `pinned` or a `deletedAt` that is
`null` while live would therefore produce a note list that returns nothing while
every note sits intact in the database. The stored shape uses indexable fields and
`store.js` normalizes them back to domain values at the boundary — which is exactly
what the boundary is for.

- `notes`, keyed by `id`
  `{ id, title, createdAt, updatedAt, localRev, pinned, pinKey: 0|1, isDeleted: 0|1, deletedAt? }`
  `deletedAt` is **omitted entirely** while the note is live, never `null`.
  Indexes: `[isDeleted, pinKey, updatedAt]` for the list, `[isDeleted, deletedAt]`
  for the trash.
- `drafts`, keyed by `noteId` — `{ noteId, text, localRev, savedAt, byteLength }`.
- `versions`, keyed by `[noteId, seq]` — `{ noteId, seq, at, sourceRev, text, byteLength }`.
  Index `[noteId, at, seq]`; `at` alone is not a unique cursor. `seq` is per-note
  monotonic and never reused after pruning, or a restore could collide with a
  pruned key.
- `meta`, keyed by `key` — theme, zoom, language, last opened note, schema version.

`byteLength` is stored because it is what bounds storage and what `VersionInfo.size`
reports; it cannot be derived cheaply at listing time.

Title derivation and `updatedAt` happen inside the same current-save transaction.
The draft path performs no diffing, history reconstruction, or expensive
transformation — that is the rule, not "no computation at all".

**There is no down migration.** IndexedDB versions only increase. The full set of
open outcomes is specified under failure behaviour.

## Deployment origin

IndexedDB is scoped to an origin — scheme, host, port — and not to a path. Two
consequences decide where this app may be published:

Every project under `owner.github.io` shares one storage authority. Any script
served from that host, from any repository of that account, can open, read, and
delete `quick-keep`. And moving the app to a custom domain or another account gives
it a different storage key, so existing notes become unreachable and the app looks
empty — indistinguishable from total loss.

The app therefore gets a dedicated, immutable origin chosen before the first real
note is written, serving nothing else. Deployment invariants: no unrelated
application or third-party script on that origin; the production scheme and host
never change silently; any origin change is an explicit export/import migration;
and a release smoke test opens the existing production database before shipping.

## Modules

One job per file. `store.js` is the only module that knows how anything is stored.

- `db.js` — IndexedDB open, schema, upgrade, connection lifecycle, and the fault
  injection seam used by tests. The only file that names IndexedDB.
- `store.js` — the app's data API: notes, drafts, versions, maintenance, backup.
  No DOM.
- `editor.js` — textarea, line numbers, zoom, find and replace.
- `notes-ui.js` — list, search, pin, delete and undo.
- `history-ui.js` — version list, preview, restore.
- `i18n.js` — Turkish and English, following the browser.
- `app.js` — wiring, shortcuts, lifecycle events.

The boundary rule: **no type crossing `store.js` may name a storage mechanism.** No
transaction, no cursor, no store name, no `IDBRequest`. Domain concepts may cross —
`localRev`, save receipts, retention state, lock ownership. Callers ask for text and
receive text. This is what made reversing the snapshot/diff decision cost nothing
outside one file. Contract in `.claude/artifacts/planning/store-api.md`.

## Concurrency between tabs

`BroadcastChannel` is a message bus, not a lock, and a heartbeat lease has races a
lock does not: two tabs can open before either hears the other, a frozen tab stops
announcing without having stopped editing, and an unconditional "edit anyway"
override is a licence to lose updates. IndexedDB serializes the individual writes
but does not resolve the logical conflict — the later transaction simply erases the
earlier tab's text while both tabs believe they saved.

v1 uses the Web Locks API, which exists for exactly this and which a crashed tab's
context releases automatically:

- Editing a note holds a named lock, `quick-keep-note-<id>`. A tab that cannot
  acquire it opens that note read-only and says which tab holds it.
- Maintenance, import, and purge hold a single global lock, because those touch
  every store.
- `BroadcastChannel` carries only explanation and cooperative handoff requests. A
  handoff completes when the holder flushes, goes read-only, releases, and the
  other tab actually acquires.
- No time-based expiry, and no unconditional override.

Per-note locks rather than one global writer lock: the lock is scoped by name, so
two tabs editing two different notes have no conflict to resolve, and forbidding it
would cost concurrency without buying correctness.

## Interface

Left: note list with search, new note, pinned first, each row showing title and
last-modified time. Centre: the editor. Right: the version panel, closed by
default — timestamps, preview on selection, restore on confirm. Restoring is itself
committed as a new version, and the pre-restore checkpoint means the text being
replaced is preserved even if it had never been versioned.

The status bar carries the two separate truths from the promise section: the
durable revision, and the retention state. Never one merged green light.

Deleting sets `isDeleted` and stamps `deletedAt`. The note leaves the list, an undo
appears immediately, and the trash keeps it **indefinitely** with its history. There
is no automatic purge — see failure behaviour.

Every control is keyboard-reachable with visible focus and a label. This is a text
editor; that is its basic surface, not an enhancement.

## Failure behaviour

Never lose silently, and never claim to have saved what was not saved.

**Storage unavailable or blocked** — the app runs against an explicit in-memory
store for the session, says plainly that nothing is being stored, and includes that
session's notes in export.

**Safari and retention.** In an ordinary Safari tab, script-writable storage is
subject to WebKit's seven-day cap without qualifying user interaction, and
`persist()` is not understood to grant an exemption; the documented exemption is an
installed Home Screen or Dock web app, whose storage is separate from ordinary
Safari storage. Safari Private Browsing is worse for our purposes: a real write
probe succeeds, but the storage is an ephemeral per-tab session that disappears when
the tab closes — so a write probe alone must never be read as proof of durability.

Decision: ordinary Safari is supported but declared **non-durable**, outside the
"never lost" guarantee, with a standing notice. `persist()` is still called, and its
result is one input to the retention state rather than a verdict. This is the same
rule everywhere, with no browser-specific exception. The exact eviction moment is
not testable from inside the app and is not claimed.

**Quota exhausted** — the failing write may itself be the draft, in which case
stopping version commits frees nothing after the retry has already failed. So:
identify which operation failed. If a version failed, prune and retry, then stop
committing history and say so. If the draft itself still fails after pruning and
retry, enter an explicit **"Not saved — memory only"** state, keep the visible
buffer, include it in emergency export, and stop emitting ordinary saved events.

Count limits do not bound bytes. A tested maximum note size, per-note and global
history byte budgets, and proactive pruning before the origin is near full replace
the earlier "no size limit" position, which was incompatible with both bounded
snapshot history and a Blob export. `estimate()` is advisory only; the real
guarantee is that a transaction commits fully or aborts without change.

**Database will not open** — four distinct outcomes, not one:
`VersionError` means this page is older than the stored data: disable editing and
tell the user to reload for newer application files. `blocked` means another
connection must close first: every connection listens for `versionchange`, flushes
what it safely can, goes read-only, and closes. Corruption or `NotReadableError`
means only in-memory buffers can be preserved and exported — **not** "rebuild from
drafts", which was incoherent because drafts live inside the database that will not
open. An empty database says "no local data found — this may be first use, cleared
site data, private browsing, or browser eviction", because those are locally
indistinguishable without a server, and claiming to know which occurred would be a
guess presented as fact.

## Backup

Export writes every note, its history, the trash, and settings to one file carrying
its own `schemaVersion`, streamed rather than concatenated once it exceeds a size
threshold. Import reads that version first and refuses a file it does not understand
rather than guessing.

Two import modes, and no semantic merge:

- **Replace**, transactional, preceded by an explicit warning and an offered safety
  export.
- **Import as copies**, assigning fresh note IDs and keeping every incoming draft
  and version.

Merge by `updatedAt` cannot honour "nothing is discarded silently" while versions
are keyed `[noteId, seq]`: two profiles importing the same backup both produce
`seq` 11 with different text, and one record can hold only one of them. Duplicate
notes are safer than invented conflict resolution. Real merging needs globally
unique version identity and branch-aware conflict handling — that is sync work, and
it ships with sync.

With no sync in v1, export is the only way out. It is a durability mechanism.

## Pruning and trash

Recent history is protected by age, not only by count. Fifty versions at two-minute
checkpoints can cover under two hours, so a count alone can delete the version a
user wants a few hours after it was written.

- The newest 50 versions are always protected.
- Every version from the last 24 hours is protected from routine pruning.
- Older versions are thinned to the last version per UTC day, ties broken by `seq`.
- A **byte budget**, not the record count, is the real bound.
- If the protected recent set alone exceeds its budget, history pauses with a
  warning rather than silently deleting protected recovery points.

There is no automatic trash purge in v1. A timed background deletion of the only
copy is the wrong default for this product: a user who deletes a note by accident
and returns after a month finds nothing, and a forward clock jump can trigger it
early. Trash is emptied only when the user explicitly asks and confirms. Under quota
pressure the app offers purging selected trash as a choice. The cost is unbounded
trash growth until the user acts, which this product should accept.

## Testing

`store.js` is tested against real IndexedDB from a `tests.html` page. Real IndexedDB
alone cannot reach the dangerous branches, so `db.js` exposes a fault-injection seam
for deterministic quota errors, delayed completion, and aborted transactions.

The cases that must have tests, each drawn from a way this design was already wrong:
restore while an uncommitted draft exists; a stale draft callback completing after a
restore; revision 10 completing while revision 11 is on screen; two tabs contending
for a lock, and a frozen holder; import/replace while another tab has pending text;
quota failure on the draft itself; same-millisecond versions and a clock rollback;
`blocked`, `versionchange`, and `VersionError`; export immediately after typing;
transaction abort after an individual request succeeds; pruning across the protected
window; `localRev` invariants.

Manual, on real devices: kill the tab mid-sentence; type continuously for a minute
and kill it without pausing; ordinary Safari, installed Safari web app, and Safari
Private Browsing as three separate modes.

## Open questions

Tracked in `.claude/artifacts/decisions/open-questions.md`. Safari retention is no
longer blocking — the product now states its limits rather than depending on an
unverified exemption — but the three Safari modes still need measuring on a real
device before release.
