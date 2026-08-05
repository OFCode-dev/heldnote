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
StoreStatus  { available, persistent, schemaVersion, reason? }
NoteSummary  { id, title, updatedAt, pinned, deletedAt }
Note         { id, title, text, createdAt, updatedAt, pinned, deletedAt, rev }
VersionInfo  { seq, at, size }          // no text — listings stay cheap
Version      { seq, at, text }
ImportResult { notesAdded, notesUpdated, versionsAdded, skipped }
StoreError   { code, message, cause? }
```

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
saveDraft(id, text) -> void          // returns immediately; never throws
flush()             -> Promise<void> // forces any pending write to complete
```

`saveDraft` is called on every keystroke. Debouncing lives inside the store, not
in the caller, so the 300 ms guarantee holds no matter who calls it or how often.
It is deliberately synchronous-looking and non-throwing: the path that must never
fail cannot be one that callers might forget to `await` or to catch. Failures
surface through the event stream instead.

`flush` exists for `pagehide` and `visibilitychange`, where there is no time for
a debounce to elapse.

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

`listVersions` pages backwards through time with a `before` timestamp cursor, and
returns no text. A note can hold up to 200 versions of arbitrary size; loading all
of them to render a list of timestamps would be the one place this app could
plausibly stall.

`restoreVersion` writes the old text as the note's current text *and* commits it
as a new version, so restoring is undoable by restoring the version before it. No
version is ever removed by a restore.

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
exportAll()               -> Promise<Blob>
importAll(file, { mode }) -> Promise<ImportResult>   // mode: 'merge' | 'replace'
```

`importAll` validates the file's `schemaVersion` and shape before touching
anything, and rejects with `invalid-import` on failure without a partial write.
`replace` runs as one transaction, so an interrupted import cannot leave the
database half-emptied.

## Events

```js
subscribe(handler) -> unsubscribe
```

Handler receives `{ type, ... }` where `type` is one of `saved`, `saving`,
`save-failed`, `note-changed`, `storage-unavailable`, `quota-warning`,
`lock-changed`. This is how the status bar learns what to display, and how the
draft path reports trouble without being able to throw at its caller.

## What is deliberately absent

- No `deleteNote` that actually deletes. Destruction is `trashNote` then `purgeNote`,
  two words apart, in a product about not losing things.
- No method returning a transaction, a cursor, or anything else the caller must close.
- No callback that runs inside a write, which would let UI code extend a transaction.
- No exposure of `seq` allocation. Callers pass a `seq` they were given; they never compute one.
