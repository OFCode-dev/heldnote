# Working on Heldnote

## Product and change rules

- Keep the Heldnote name and heldnote.app identity. This product does not need
  another product's brand, offer or backend.
- Preserve unknown working-tree edits. Inspect the branch, status and project
  instructions before changing files. Prefer the existing suitable checkout.
- Use the owner-confirmed public contact in [BRAND.md](BRAND.md) for current
  support/privacy/legal/site copy. Review each address's role before editing;
  never infer new mailboxes or replace authentication/account identity,
  credentials, Git authorship or historical evidence with a public contact.
- Protect writing first: never silently discard a draft, history, recoverable
  conflict or existing export. Saving, retention, sync and independent backup
  are different things; explain their limits accurately.
- Keep the current free notes, history, recovery, export and optional Drive
  sync free. Never block existing writing or recovery on billing/licensing.
- Production is GitHub Pages with plain HTML/CSS/ES modules. No build step and
  no new runtime dependency. Test tooling can use the existing Playwright setup.
- Production deploy, merging main, DNS and OAuth Console changes require
  explicit owner authorization. Main pushes trigger the deployment workflow.
  Do not perform real Google authentication/Drive tests without authorization.
- No sponsor outreach, ad/payment activation or public release is authorized
  by the current prototype work. Keep draft PRs unmerged.

## Architecture and trust boundaries

- `/` and `/tr/` are public static landing pages; `/app` is the notepad on the
  same origin. Preserve origin and installed-app identity to retain data.
- `db.js` and `store.js` manage IndexedDB drafts/history/import/export.
  `sync-engine.js`, `sync.js` and `drive-sync.js` handle merge, coordination and
  Google transport. Do not infer real-device acceptance from simulated tests.
- The production DB schema and Drive format are unchanged by Premium work.
  Before integrating new paid metadata, design and test old-client handling,
  migration, import/export, merging, recovery and unsupported-version behavior.
- `/preview/premium/` is an English, noindex, sample-only experiment. Its
  `model.js` owns memory per instance. It must not import production modules,
  open browser storage, read tokens or contact services. Reload discards samples.
- Preview JSON has its own `format` and `version`; it is not a production
  backup or Drive payload. Reject files in both directions without mutation.
- The separate organization snapshot codec is a pure, test-only compatibility
  experiment, not a UI feature or migration. Read
  [ORGANIZATION_COMPATIBILITY.md](ORGANIZATION_COMPATIBILITY.md) before changing
  metadata contracts. Preserve its embedded legacy backup string exactly.
  Old import/Drive paths discard unknown fields; arbitrary meta references are
  not remapped when notes are copied. Do not enable live sync from parse success.
- A different URL path does not provide a security boundary on the same
  origin. Isolation here depends on no storage/service access, no production
  imports and tested fixtures. Keep it out of public navigation and sitemap.
- Direct sponsorship comes first, with self-hosted assets and labelled links.
  AdSense would need a separate public-content origin; ad scripts must not run
  on the origin holding notes and Drive credentials. The editor is ad-free in
  every tier. No analytics or targeting from note content.

## Validation and handoff

- Run `node tests/public-pages.mjs`, `node tests/legal-links.mjs` and
  `git diff --check` for public route/disclosure changes.
- Browser unit tests live in `tests.html`; use the existing CI runner
  `.github/scripts/run-tests.mjs` with the site served locally at port 8080.
  Playwright is development tooling installed by CI, not a product dependency.
- Run `node tests/premium-preview-browser.mjs` for the preview. It serves a
  disposable local site and uses synthetic data in a new browser context.
  Optional `PLAYWRIGHT_MODULE` and `CHROME_PATH` select an existing local test
  runtime; neither is part of the shipped application.
- Preserve targeted evidence for collection deletion, template non-overwrite,
  denied storage, incompatible imports, exact text recovery and unrelated-note
  isolation. Check keyboard flow, JS-off content and phone/desktop widths.
- Update the existing relevant draft PR with accurate source/test evidence;
  keep OAuth #1 and its stacked brand/prototype #2 reviewable separately.
- Record what passed and what remains in MEMORY.md. Keep real installed-device
  and two-device Drive acceptance explicit. Never imply deployment or live
  billing from a local preview.

See [BRAND.md](BRAND.md) and [PREMIUM_PLAN.md](PREMIUM_PLAN.md) for positioning
and proposed commercial scope; [MEMORY.md](MEMORY.md) is the current status.
