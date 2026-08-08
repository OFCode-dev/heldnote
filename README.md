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

Genuinely outstanding, not yet done:

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
- Turkish and English UI, following the browser's language
- An honest status bar: the durable save state and the browser's storage
  retention state are always shown as two separate facts, never merged into
  one "Saved" light — including a standing notice on Safari, which this app
  cannot promise durability on

## Not yet built

The editor (`editor.js`) is currently a plain textarea. Find/replace, syntax
highlighting with line numbers, a dark-theme toggle, and zoom are not
implemented — none of these are v1 scope commitments, and this README will
be updated if and when they are picked up.

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

Google Drive sync, writing straight to disk, tags and folders, markdown preview,
sharing, and encryption. Sync is the intended v2; the data model already carries
the fields it will need.

## License

MIT
