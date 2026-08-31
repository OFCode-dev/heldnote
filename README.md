# Heldnote

A browser notepad whose defining promise is that nothing you type is ever lost.

Multiple notes, saved continuously to IndexedDB, with a version history you can
step back through. No account, no server, no build step — open the page and write.

Part of the OFCode "Quick" family, alongside
[Quick Web Notepad](https://github.com/OFCode-dev/quick-web-notepad) (its
single-pad predecessor) and the Quick screenshot-to-clipboard extensions.

## Status

Implemented and under active review. All planned v1 modules (`db.js`,
`store.js`, `i18n.js`, and the UI layer) are written; the codebase has been
through several review-and-fix passes.

Two-way Google Drive sync — the intended v2 feature — is implemented on the
`feature/drive-sync` branch (`sync-engine.js`, `sync.js`, and the v2 protocol
in `drive-sync.js`); see "Sync" below for the model. It is inert until
`constants.js` carries a `GOOGLE_DRIVE_CLIENT_ID`, and it has not yet been
exercised against real Drive on two real devices.

Genuinely outstanding, not yet done:

- **A Google OAuth client id for Drive sync**, and a two-device end-to-end run
  against real Drive: phone and desktop editing the same note, going offline,
  resolving a conflict. The merge engine is unit-tested and the store paths are
  tested, but no test talks to Drive itself.

- **DNS and hosting configuration for `heldnote.app`** — the A/AAAA and `www`
  CNAME records, the GitHub Pages custom-domain setting, "Enforce HTTPS", and
  a post-propagation smoke test all require registrar/hosting access this
  repository's automation does not have.
- **Real-browser latency measurement.** `constants.js`'s byte-budget values
  (`MAX_NOTE_SIZE_BYTES`, `PER_NOTE_HISTORY_BYTE_BUDGET`,
  `GLOBAL_HISTORY_BYTE_BUDGET`) are **provisional placeholders**, not measured
  numbers. `tests/measure-latency.html` exists to gather real p50/p95/p99/max
  draft-write timings and real `navigator.storage.estimate()` figures on
  actual hardware; that measurement has not been run, and the constants have
  not been updated from it yet.
- **Manual QA on real devices/browsers**, none of which is possible from an
  automated environment: killing the tab mid-sentence and confirming
  recovery; typing continuously for a minute without pausing; and the three
  distinct Safari modes (ordinary tab, installed Home Screen/Dock app,
  Private Browsing) the design document calls out separately.

This is tracked in more detail in a process ledger at
`.superpowers/sdd/2026-08-06-heldnote-v1-implementation/progress.md`, which
is implementation-history bookkeeping, not user-facing documentation — this
section is the place that status should actually be found.

- Canonical design spec: `docs/superpowers/specs/2026-08-05-quick-keep-notepad-design.md`
- Planning artifacts: `.claude/artifacts/`

## What works today

- Multiple notes with search (title and body), pinning, and a trash you can
  restore from or permanently delete
- Two-layer persistence: a per-keystroke draft, plus periodic committed
  snapshots you can preview and restore
- Version history per note, with timestamped restore
- JSON export (full backup, downloaded as a file) and import, either as
  copies with fresh ids or as a full destructive replace (with an explicit
  warning and an offered safety export first)
- Two-way Google Drive sync across devices, with per-field merging and the
  losing side of a conflict preserved in history (branch `feature/drive-sync`;
  see "Sync")
- Turkish and English UI, following the browser's language
- An honest status bar: the durable save state and the browser's storage
  retention state are always shown as two separate facts, never merged into
  one "Saved" light — including a standing notice on Safari, which this app
  cannot promise durability on

## Not yet built

The editor is a plain textarea by design, with find & replace, word wrap,
zoom, a light/dark theme toggle, copy, and .txt download built around it.
Syntax highlighting with line numbers is deliberately not implemented, and
is not a scope commitment.

## Sync

Drive sync is two-way, not a backup: every device pulls, merges, and pushes one
file (`heldnote-sync.json`) in Drive's app-private `appDataFolder`. There is no
server, and no account beyond the user's own Google sign-in. The rules that
matter:

- **Ordering never trusts the wall clock.** Every synchronized mutation carries
  a hybrid logical clock stamp `{w, c, d}` — non-decreasing wall time, a
  per-device counter, and the device id. Two devices comparing stamps reach the
  same answer, with no ties, and a device with a wrong clock cannot win
  permanently.
- **Notes merge field by field**, not as whole records. Text, title, pinned and
  lifecycle (trashed or live) each carry their own stamp, compared against a
  stored merge base. Renaming a note on the phone while editing its body on the
  desktop merges cleanly instead of one edit erasing the other.
- **A real text conflict never loses text.** The higher stamp becomes the live
  text; the losing text is written into that note's version history as a
  `sync-conflict` version, protected from pruning for seven days. Conflicts
  resolve silently — there is no dialog to answer.
- **Deletion travels as a tombstone**, written in the same IndexedDB
  transaction that purges the note, so a purge propagates instead of the note
  resurrecting from the other device. A purge that races an edit does not
  destroy it: the note lands in Trash carrying the edited text. Absence of a
  note is never read as deletion.
- **Typing during a sync is safe.** Each note carries a fence — its draft
  revision plus a mutation counter — and a note touched between
  merge-computation and merge-apply is skipped that round and merged on the
  next one.
- **The upload is guarded by Drive's `headRevisionId`.** If another device
  wrote in the meantime, the cycle restarts from download and re-merges. A
  fresh or empty device pulls before it is ever allowed to upload, and a sync
  file written by a newer app version aborts the cycle rather than being
  overwritten by an older client.
- A pre-existing one-way `heldnote-backup.json` is read once as the initial
  remote baseline and then left alone. Manual JSON export and import are
  unchanged, and never carry sync metadata between devices.

Sync runs on load, on returning to the tab, after edits (30s debounce, at most
once per five minutes), on "Sync now", and when the network comes back. In
memory-fallback mode, when IndexedDB is unavailable, sync is disabled and says
so rather than reporting a false success.

## Tests

`tests.html` is the browser test runner; open it directly to watch the suite in
a real browser. For a headless run:

```sh
npm install --no-save playwright-core@1.49.1   # Node 18; drop the pin on Node 20+
node scripts/run-tests.mjs
```

It serves the repository over localhost, runs `tests.html` in system Chromium,
prints the harness summary, and exits non-zero on any failure.
`tests/measure-latency.html` is separate and manual: it exists to gather the
real-hardware numbers the byte budgets still need.

## Repository layout

Working material is deliberately not shipped. `docs/` (the design spec, the
sync contract, and the review records behind it), `.claude/`, `.superpowers/`
and `logs/` are gitignored and live only on the development machine. The
product is the files at the repository root, plus `tests/` and `scripts/`.

## Deployment

**Canonical production origin:** `https://heldnote.app`

The code side of this (CNAME file, `manifest.webmanifest`, this section) is
in place. The DNS and hosting configuration itself — pointing the domain at
GitHub Pages, enabling HTTPS, and verifying it — is a pending manual step;
see "Status" above.

- `www.heldnote.app` redirects to the apex domain (once DNS is configured).
- All user data is persisted locally via IndexedDB; no data migration is
  required if the origin changes, but any such change is an explicit
  export/import migration decision, never a silent move.
- **Release smoke test:** Before each production deploy, open
  `https://heldnote.app` in a private/incognito window to verify the app loads
  and can access the local database (this confirms no silent breakage in storage
  access or IndexedDB permission changes).

## Not in v1

Writing straight to disk, tags and folders, markdown preview, sharing, and
encryption. Google Drive sync was the intended v2 and is now implemented on
`feature/drive-sync` — see "Sync".

## License

All rights reserved — see `LICENSE`. The source is published to be read and
reviewed, not relicensed.
