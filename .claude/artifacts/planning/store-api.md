# `store.js` Contract

- Date: 2026-08-05
- References: `product-requirements.md`, `data-assessment.md`

## Why this document exists

`store.js` is the only module that knows how notes are persisted. Everything above
it — the editor, the note list, the history panel — asks for text and receives
text. Whether history is kept as full snapshots or as diffs is not observable
through this surface, which is what made reversing that decision mid-design cost
nothing outside this file.

The rule that keeps it that way: **no type crossing this boundary may name a
storage mechanism.** No transaction, no cursor object, no `IDBRequest`, no store
name. If a caller ever needs to know one, the boundary has failed.

A note on provenance: the `ecc:api-design` skill was consulted here and is largely
about HTTP APIs — status codes, auth headers, rate limiting — none of which apply
to an in-process module. Three of its principles did transfer and are used below:
validate at the boundary, return typed error codes rather than generic failures,
and paginate any list that can grow without bound.

## Types

```js
StoreStatus  { available, retention, schemaVersion, reason? }
             // retention: 'persistent' | 'best-effort' | 'session-only' | 'unknown'
NoteSummary  { id, title, updatedAt, pinned, deletedAt }   // deletedAt: number | null
Note         { id, title, text, createdAt, updatedAt, pinned, deletedAt, localRev }
VersionInfo  { seq, at, sourceRev, size }   // no text — listings stay cheap
Version      { seq, at, sourceRev, text }
SaveReceipt  { noteId, requestedRev, durableRev, completedAt, error? }
ImportResult { notesAdded, notesCopied, versionsAdded, skipped }
StoreError   { code, message, cause? }
```

`retention` replaces a boolean `persistent` because durability of the latest
revision and retention by the browser are different claims, and a single flag
invites the interface to merge them into one green light. Ordinary Safari reports
`best-effort` at most; Private Browsing reports `session-only` even though a write
probe there succeeds.

The stored shape uses indexable fields — `isDeleted`, `pinKey`, and no `deletedAt`
key at all while live — because booleans and null are not valid IndexedDB keys.
Normalizing them back into the domain values above is this boundary's job.

`StoreError.code` is one of: `storage-unavailable`, `quota-exceeded`,
`version-mismatch`, `invalid-import`, `not-found`, `locked-by-other-tab`.
Callers branch on `code`; they never parse a message. `version-mismatch` is the
stale-page-shell case from the data assessment and is the one error the UI must
translate into "reload this page", not "something went wrong".

## Lifecycle

```js
open() -> Promise<StoreStatus>
```

Resolves even when storage is unusable — with `available: false` and a `reason` —
because the app stays usable in that state and must simply stop claiming to save.
It rejects only on `version-mismatch`, where continuing would be dishonest.

```js
close() -> Promise<void>
```

## Notes

```js
listNotes({ query, includeTrashed, limit, before }) -> Promise<NoteSummary[]>
getNote(id)        -> Promise<Note>        // text read from the draft layer
createNote()       -> Promise<Note>
setPinned(id, on)  -> Promise<void>
trashNote(id)      -> Promise<void>        // sets deletedAt; history untouched
restoreNote(id)    -> Promise<void>        // clears deletedAt
purgeNote(id)      -> Promise<void>        // permanent, note and history
```

`listNotes` returns summaries, never bodies. Search is the store's job rather than
the UI's, so that the note list never has to hold every note's text in memory to
filter it.

## The two persistence layers

```js
saveDraft(id, text)          -> number          // returns the assigned localRev
flush(noteId, throughRev)    -> Promise<SaveReceipt>
```

`saveDraft` is called on every keystroke, returns immediately, and never throws:
the path that must never fail cannot be one a caller might forget to `await` or to
catch. Failures surface through the event stream. It returns the revision it
assigned, which is what lets the interface tell "the text on screen is durable"
apart from "some earlier text is durable".

Scheduling lives inside the store: writes are serialized and coalescing, one
transaction in flight per note, the queued payload always replaced by the latest
text, and no accepted revision waiting more than 300 ms measured to transaction
completion. Not `put()` success — a transaction can still fail after an individual
request resolves.

`flush` resolves only when the given revision's transaction has completed, and
rejects if it failed. It is used on `pagehide` and `visibilitychange`, and before
any fenced operation.

Current-text transactions request `durability: "strict"`. Version commits do the
same. Whether the 300 ms draft cadence can afford strict durability on every write
is a measurement, not an assumption, and the default may be revisited with numbers.

```js
commitVersion(id) -> Promise<VersionInfo | null>
```

Returns `null` when the text is unchanged since the last version, which is how
"do not store duplicates" is enforced in one place rather than at every call site.

## History

```js
listVersions(id, { before, limit }) -> Promise<VersionInfo[]>
getVersion(id, seq)                 -> Promise<Version>
restoreVersion(id, seq)             -> Promise<VersionInfo>
```

`listVersions` pages backwards with a `[at, seq]` tuple cursor, not a bare
timestamp: two versions can share a millisecond, and a timestamp-only cursor skips
records between pages. It returns no text.

`restoreVersion` is one fenced operation, not a write followed by a commit. It
flushes the current revision, invalidates older queued writes, and then in a single
transaction: reads the current draft, inserts it as a pre-restore checkpoint if it
differs from the newest snapshot, writes the restored text as a new draft revision,
inserts it as a new version, and updates metadata.

The checkpoint is the point. Without it, restoring while the current text has been
saved as a draft but not yet versioned destroys that text permanently — and the
ordinary duplicate check would then suppress the commit that was supposed to make
the restore undoable. No version is ever removed by a restore.

## Maintenance

```js
runMaintenance() -> Promise<{ pruned, purged }>
```

Runs the pruning ladder and the trash purge. Called at startup and safe to call
at any time: it commits per note, so an interrupted pass leaves consistent state,
and re-running it changes nothing that has already been done. It never removes a
note's newest version.

## Backup

```js
exportAll()               -> Promise<Blob | ReadableStream>
importAll(file, { mode }) -> Promise<ImportResult>   // mode: 'replace' | 'copy'
```

`exportAll` streams once the total exceeds a size threshold rather than
materializing everything in memory — hanging the tab during the one operation a
worried user reaches for would be a poor way to keep this product's promise.

`importAll` validates the file's `schemaVersion` and shape before touching
anything, and rejects with `invalid-import` on failure without a partial write.
`replace` runs as one transaction. `copy` assigns fresh note IDs and keeps every
incoming draft and version.

There is no `merge`. With versions keyed `[noteId, seq]`, two profiles importing
one backup both produce `seq` 11 with different text, and one record can hold only
one of them — so a merge cannot honour "nothing is discarded silently" without
globally unique version identity and branch-aware conflict handling. That is sync
work and ships with sync.

## Events

```js
subscribe(handler) -> unsubscribe
```

Handler receives `{ type, ... }` where `type` is one of `saved`, `saving`,
`save-failed`, `note-changed`, `storage-unavailable`, `retention-changed`,
`quota-warning`, `memory-only`, `lock-changed`. This is how the status bar learns
what to display, and how the draft path reports trouble without being able to
throw at its caller.

Every save event carries a `SaveReceipt`. Without the revision, an event stream
lies in both directions: revision 10's completion renders "Saved" beside revision
11's visible text, and a failure for an older request arriving after a newer
success leaves the interface stuck in a failed state. The status is saved only
when `editorRev === durableRev`, and retention is displayed as its own separate
fact.

## What is deliberately absent

- No `deleteNote` that actually deletes. Destruction is `trashNote` then `purgeNote`,
  two words apart, in a product about not losing things.
- No method returning a transaction, a cursor, or anything else the caller must close.
- No callback that runs inside a write, which would let UI code extend a transaction.
- No exposure of `seq` allocation. Callers pass a `seq` they were given; they never compute one.
