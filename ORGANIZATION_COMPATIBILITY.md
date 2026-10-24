# Organization snapshot compatibility decision

24 October 2026 — experimental, not an approved production schema.

## Decision

Keep collections/templates out of real note records, production backups and
the current Drive file. Add a small, pure snapshot codec for review and
synthetic tests only. It wraps an unchanged legacy backup string together with
versioned organization metadata. It neither stores nor applies anything.

The module is `preview/premium/organization-codec.js`. No editor or prototype
UI imports it. Existing preview downloads retain their separate format. No
production schema, Drive format, free feature or payment behavior changes.

## Contracts actually inspected

| Current path | Observed behavior | Compatibility implication |
| --- | --- | --- |
| `store.js`: `exportAll`, `getNote`, `getVersion` | Backup schema 1 contains notes, versions and optional meta. Export constructs known note/history fields. | Unknown organization fields cannot be assumed to survive a backup round trip. |
| `store.js`: `parseImportFile`, `noteRecordFrom`, `importAll` | Validates before writing; newer backup schemas, duplicate note/history keys and orphan history reject. Import reconstructs known note/draft/history records. | Adding fields to schema 1 does not make old clients retain them. |
| `store.js`: copy/merge modes | Copy generates new note IDs and returns counts, not a mapping. Arbitrary non-internal meta can survive copy without reference remapping; merge retains local settings. | An organization object in meta is not a safe attachment strategy. |
| `sync-engine.js`: `validateSyncFile`, `unionSyncFiles` | Sync format 2 selects known root fields. Unknown note fields can survive validation temporarily. `schemaVersion` alone does not gate newer Drive data. | Parsing success does not establish metadata compatibility. |
| `sync-engine.js`: `computeMergePlan`, `buildUploadPayload` | Per-field merge stamps cover text/title/pinned/lifecycle. Upload explicitly selects known note/version fields and no organization root. | An old client's next core edit/upload can erase embedded metadata. |
| `sync-engine.js`: `syncStateSignature` | Organization-only changes do not alter the signature. | Current “synced” status cannot attest to organization data. |
| `sync.js`: download and upload decision | `syncFormat > 2` produces update-required; canonical core signatures govern quiet-cycle uploads. | Bumping only `schemaVersion` is insufficient; bumping syncFormat blocks old clients' whole sync and is not authorized here. |

Tests use these actual functions with synthetic files and explicitly named
test databases. No Google account, network transport or real note library is
used. Fixtures live in `tests/fixtures/organization-cases.js`; executable
evidence lives in `tests/organization-compatibility.test.js`.

## Draft format and rules

```json
{
  "format": "heldnote-organization-snapshot",
  "version": 1,
  "backupJson": "<original schema-1 backup JSON string, unchanged>",
  "organization": {
    "collections": [{ "id": "collection-a", "name": "Work" }],
    "templates": [{ "id": "template-a", "name": "Routine", "text": "Starting text" }],
    "memberships": [{ "noteId": "existing-note-id", "collectionId": "collection-a" }]
  }
}
```

- `encodeOrganizationSnapshot(backupJson, metadata)` and
  `decodeOrganizationSnapshot(source)` accept plain JSON values/text. The
  decoder returns new values or throws a coded error; it never updates an
  existing library. A caller must finish validation before replacing state.
- `backupJson` is an opaque retained string after structural validation of the
  known schema-1 backup requirements. Preserve whitespace, unknown legacy
  fields, note text and history exactly. Do not reserialize the embedded file,
  filter meta, normalize newlines or turn templates into existing notes.
  Preservation by this codec does not imply preservation by an old importer.
- This experiment accepts exactly backup schema 1, more conservatively than
  the current importer's numeric-version check. Missing/future schemas and
  Drive/preview documents refuse. Old backups without meta are accepted.
- Envelope and organization records use strict field allowlists. Unknown
  fields/versions refuse instead of being silently dropped. New semantics
  need a new format version and an explicit conversion design.
- Collection/template IDs are unique within their typed namespace. Note IDs
  must be unique in the embedded backup; history keys are `(noteId, seq)`.
  No automatic deduplication, ID generation or collision resolution occurs.
- One collection membership per note in this draft. Unassigned notes have no
  membership row. Missing note/collection references and orphan history
  refuse; nothing is silently deleted. Removing a collection must also remove
  its membership rows while retaining all original notes/history.
- Collection/template names are nonblank, at most 120 characters; templates
  hold at most 50,000 UTF-16 code units, with text otherwise unchanged. These
  are experimental format constraints, not new limits on free note content.
- `assertSnapshotForBackup(source, targetBackupJson)` refuses any difference
  from the embedded backup string, including formatting/export-time changes.
  Reusing the same note ID with different content is not permission to attach
  metadata. This conservative binding is for offline snapshots, not a stable
  live-library identity or a merge algorithm.

## Old-client and Drive behavior is deliberately not hidden

The new envelope lacks `schemaVersion`/`syncFormat` and is rejected by the
current note importer and Drive validator. Never place it in the live
`heldnote-sync.json` file: a validation failure is not a safe live transport
protocol. No upload API is provided by the codec.

Synthetic tests demonstrate actual old backup round trips dropping extra
root/note/history fields, copy imports retaining stale arbitrary meta
references, and Drive validate/union/merge/upload dropping embedded metadata
while preserving the fixture's core text/history. Changing only organization
fields leaves the current signature unchanged. A higher syncFormat gates an
old client; a higher schemaVersion in a format-2 Drive file does not.

These tests expose incompatibility; they do not certify mixed-version live
sync. Nothing here supplies conflict clocks, deletion tombstones, copy-ID
remapping, multi-file atomicity, rollback or a live target identity.

## Gates before real integration

1. Decide metadata lifetime and a live-library/backup binding strategy. Define
   copy-ID remapping and what happens when merge meets an existing note ID,
   note deletion, collection deletion or concurrent template edits.
2. Choose a transport/version transition deliberately. Separate organization
   files might avoid old serialization, but need their own compatibility,
   reconciliation and failure design. A syncFormat upgrade needs an old-client
   transition plan that respects the existing free Drive service. Neither
   option is selected or activated by this experiment.
3. Design atomic local upgrade and restore, unsupported-version refusal,
   recoverable conflicts, old-tab behavior and export recovery. Reuse of
   unknown meta fields is not a migration plan. Establish file-size/resource
   limits before attaching any file-reading UI to this in-memory codec.
4. Obtain owner review of prototype usefulness and production integration
   scope. Physical-device/Drive acceptance and production approval remain
   separate gates. No payment or advertising activation follows from this doc.
