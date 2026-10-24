# Heldnote

A local-first browser notepad designed to prevent accidental text loss.

Multiple notes, saved continuously to IndexedDB, with a version history you can
step back through. No account, no server, no build step — open the page and write.

Part of the OFCode "Quick" family, alongside
[Quick Web Notepad](https://github.com/OFCode-dev/quick-web-notepad) (its
single-pad predecessor) and the Quick screenshot-to-clipboard extensions.

## Public site and brand

The public experience is static HTML with self-hosted assets. The English
landing page is at /, the Turkish equivalent at /tr/, and the notepad at /app.
About and two practical guides explain storage, history, sync and independent
backups. The public sponsor invitation links to /sponsorship; no paid sponsor
is active. See BRAND.md for the identity, copy principles and commercial boundary.

Moving from / to /app changes only the path, so the existing IndexedDB
database, preferences and cached Drive token stay on the same origin. There is
no data migration. Existing installed apps keep the same manifest start URL
and identity; the public script opens /app when launched in standalone mode.
Real installed-app behavior still needs device QA.

Public copy, navigation and FAQs work without JavaScript. The small history
demo uses sample text and never opens IndexedDB or the token cache. /app is
marked noindex and excluded from the sitemap. Public pages have unique
metadata, linked product entities and reciprocal English/Turkish alternates.
These are discovery foundations, not a guarantee of rankings or AI citations.

No advertising or analytics integration has been activated. A first-party
static sponsorship is the lowest-complexity option; programmatic advertising
requires the separate-origin and consent work described in BRAND.md.

## Status

Implemented and under active review. All planned v1 modules (`db.js`,
`store.js`, `i18n.js`, and the UI layer) are written; the codebase has been
through several review-and-fix passes.

Two-way Google Drive sync is present on `main` (`sync-engine.js`, `sync.js`,
and `drive-sync.js`) with a configured OAuth client id. The old one-way backup
is read for migration. Automated tests cover storage, merging, coordination,
and the OAuth lifecycle with a simulated Google client; real Google accounts
and two physical devices still need an end-to-end run.

Genuinely outstanding, not yet done:

- **A two-device end-to-end run against real Drive** — phone and desktop
  editing the same note, going offline, resolving a conflict, and a fresh
  browser pulling an existing library. The merge engine is unit-tested and the
  store paths are tested, but no test talks to Drive itself, so this is the one
  gap between "the tests pass" and "sync works".
- **Google Cloud configuration and brand verification** — these are separate
  from deployment and must be checked in the Cloud and Search Console accounts;
  see "Google OAuth" below.
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
  losing side of a conflict preserved in history (see "Sync")
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

## Google OAuth

The browser uses Google Identity Services' token model and requests only
`https://www.googleapis.com/auth/drive.appdata`. There is no callback server,
client secret, or refresh token. The short-lived access token is cached in
localStorage with Google's expiry time and reused across reloads. When it
expires, background sync pauses; "Sync now" requests a new token from a click.
An account chooser at that point does not mean the previous consent was lost.

Token requests use `prompt: ''` so Google decides whether consent is needed.
The app does not force consent based on a browser-local marker. This reduces
repeat permission screens, but cannot guarantee no account chooser: the token
model requires user interaction after expiry. Google's supported automatic
refresh alternative is the authorization code model with a backend, which is
outside this static application's architecture.

Operational checks, without changing application code:

- Search Console must show verified ownership of `heldnote.app` for an account
  associated with the Cloud project as Owner or Editor. A public verification
  TXT record alone does not prove that the console's verification succeeded.
- Branding should use `https://heldnote.app/`, `https://heldnote.app/privacy`,
  and `https://heldnote.app/terms`, with `heldnote.app` as an authorized domain.
  After ownership is verified, resolve the previous Branding issue and request
  re-verification if the issue remains open.
- Audience should be External / In production for general public use. In
  Testing, access is limited to listed test users and their consent expires
  after seven days; check this if full permission screens recur.
- The web client's JavaScript origin must include `https://heldnote.app`, and
  Google Drive API must be enabled in the same project as the configured client.
  The GIS token flow does not need a new redirect callback route.

References: [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[GIS migration and token expiry](https://developers.google.com/identity/oauth2/web/guides/migration-to-gis),
[Audience](https://support.google.com/cloud/answer/15549945),
[brand verification](https://developers.google.com/identity/verification/authentication-verification).

## Advertising boundary

Advertising is planned; no ad integration is enabled. A third-party script
included on any `heldnote.app` page executes with that origin's access to
localStorage and IndexedDB, including the cached Drive token and notes. Moving
the script from the editor to `/about` on the same origin does not isolate it.
Keep ad scripts off the note-storage origin; a separate public-content origin
is the proposed boundary, subject to the provider's supported placement rules.
Keep the existing editor origin to avoid stranding users' local notes.

Before enabling AdSense, assess the public content and placement against
[publisher-content requirements](https://support.google.com/publisherpolicies/answer/11112688),
choose the applicable
[consent setup](https://support.google.com/adsense/answer/13554116), and update
the privacy disclosures to describe the actual provider and data use. Private
note text must not be passed to advertising or used as ad targeting data.

## Tests

Static public-page and legal-link checks need only Node:

    node tests/public-pages.mjs
    node tests/legal-links.mjs

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

The custom domain is configured in CNAME and `manifest.webmanifest`. A public
check on 24 October 2026 returned HTTP 200 for the home page, privacy and terms,
and a redirect from `www` to the apex domain. A Google verification TXT record
was also present; Cloud verification status is a separate account-side check.
Pushes to `main` trigger the test-and-deploy workflow. Review changes on a
separate branch; merging or pushing to `main` is a production deployment.

- `www.heldnote.app` redirects to the apex domain.
- IndexedDB belongs to its exact origin. Changing the editor's origin does
  not carry notes across; it requires an explicit export/import migration.
- **Release smoke test:** Before each production deploy, open
  `https://heldnote.app` in a private/incognito window to verify the app loads
  and can access the local database (this confirms no silent breakage in storage
  access or IndexedDB permission changes).

## Not in v1

Writing straight to disk, tags and folders, markdown preview, sharing, and
encryption. Google Drive sync is implemented on `main` — see "Sync".

## License

All rights reserved — see `LICENSE`. The source is published to be read and
reviewed, not relicensed.
