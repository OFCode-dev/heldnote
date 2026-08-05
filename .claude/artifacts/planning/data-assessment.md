# Data Assessment: Quick Keep Notepad v1

- Date: 2026-08-05
- Store: IndexedDB (`quick-keep`), browser-local, no server
- References: `product-requirements.md`, `problem-description.md`

```yaml
data:
  applicability: Required
  migration_type: schema_only
  applicability_detail: >
    v1 creates the entire store set from nothing. There is no prior data anywhere:
    the predecessor `quick-web-notepad` persisted nothing at all, so there is no
    legacy corpus to read, convert, or backfill. Every later change to this schema,
    however, runs against real user data that exists only on the user's machine and
    has no server-side copy to restore from — which is what makes the upgrade path
    worth designing now rather than at v2.

  up_migration:
    required: true
    description: |
      Database `quick-keep`, version 1, created in a single `onupgradeneeded`:

      notes     keyPath id
                { id, title, createdAt, updatedAt, deletedAt, pinned, rev }
                index by_updatedAt   on updatedAt
                index by_deletedAt   on deletedAt   (drives the trash view and purge)
                index by_pinned      on pinned

      drafts    keyPath noteId
                { noteId, text, savedAt }
                no index; always fetched by primary key

      versions  keyPath [noteId, seq]
                { noteId, seq, text, at }
                index by_note_at     on [noteId, at]  (history listing and pruning)

      meta      keyPath key
                { key, value }
                holds theme, zoom, language, lastOpenedNoteId, schemaVersion, appVersion

      All timestamps are epoch milliseconds. `deletedAt` is null for live notes.
      `seq` is a per-note monotonic counter, never reused after pruning.
    breaking_changes: none — nothing exists before this

  down_migration:
    preferred: false
    description: >
      There is no down migration, and this is a property of IndexedDB rather than a
      choice. A database version can only ever increase. Opening version 1 against a
      store already at version 2 does not downgrade it — it rejects with VersionError.
    fragile_reason: >
      This matters more here than in a server database because the app is served as
      static files from GitHub Pages. A user can hold a cached older page shell while
      their browser profile already carries a newer database, and the old shell will
      simply fail to open it. That failure must be caught and explained ("this browser
      holds newer data than this page — reload to update"), never surfaced as a blank
      notepad, which would look exactly like data loss to the person it happens to.
      Rollback of the app is therefore a reload, never a schema reversal.

  backfill_plan: null

  rollback_considerations: |
    - Schema creation is all-or-nothing: if `onupgradeneeded` throws, the database is
      not created, and the app must fall into its storage-unavailable state rather
      than presenting an editable but unsaved surface.
    - Reverting a deployed app version cannot revert the database. Any future schema
      change must therefore be additive and tolerant of fields it does not know, so
      that an older shell meeting a newer store degrades rather than breaks.
    - The only true rollback path available to a user is export, clear, import. This
      makes the export format a durability mechanism, not a convenience feature.

  safety_notes: |
    - The export file carries its own `schemaVersion`. Import reads it first and
      refuses a file it does not understand, rather than guessing at its shape.
      Without this, a future format change silently corrupts imports.
    - `meta.schemaVersion` is written alongside the browser's own database version so
      that a mismatch is diagnosable after the fact.
    - Pruning and trash purge both delete user data on a timer, so both are treated as
      restartable maintenance jobs: they run at startup, operate note by note, commit
      per note, and are safe to interrupt by a closed tab and safe to re-run. Neither
      ever removes the newest version of a note.
    - Import with the replace option deletes every store's contents before writing.
      It runs inside one transaction so an interrupted import cannot leave a half-
      replaced database, and it is refused outright if the incoming file fails
      validation.
    - The draft and version layers hold the same text at the same moment by design.
      Reads always prefer the draft, which is the newest by construction; versions are
      only ever read deliberately through the history panel.
```

## Findings that change the design

1. **The export format needs its own version number.** Nothing in the requirements
   said so. Without a `schemaVersion` in the JSON, a file exported today and imported
   after a future format change is read with the wrong expectations and quietly
   mangled — in a product whose entire premise is not losing text.

2. **IndexedDB cannot roll back, and this app is served from a CDN cache.** The
   combination is specific and easy to miss: a stale page shell plus a newer database
   produces a VersionError on open. Unhandled, it looks identical to total data loss.
   It needs an explicit message telling the user to reload.

3. **Pruning and purge are data-deleting background jobs and must be restartable.**
   They can be interrupted at any moment by a closed tab. Per-note commits and
   idempotent re-runs keep an interrupted pass from leaving history half-thinned.

4. **`seq` must never be reused after pruning.** If it were, a restored version could
   collide with a pruned one's key and overwrite unrelated history.
