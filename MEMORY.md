# Heldnote current decisions and gates

Updated 26 October 2026. Engineering handoff; no customer data belongs here.

## Review state

- Working branch: `feature/brand-landing`. Clean at the start of the Premium
  prototype slice; prior head `e4a2c67`. No unknown edits were present.
- The standalone compatibility slice began clean at accepted prototype commit
  `ad652cb`. Prototype usability remains an owner checkpoint; existing preview
  browser QA was accepted and was not rerun for this pure codec work.
- [Draft PR #1](https://github.com/OFCode-dev/heldnote/pull/1) contains OAuth
  lifecycle fixes. [Draft PR #2](https://github.com/OFCode-dev/heldnote/pull/2)
  is stacked on its branch and contains landing/brand/sponsor preparation,
  the Premium proposal and the isolated prototype. Neither is merged.
- Repository visibility was checked: it is public. Draft PR status does not
  make source private; no visibility or access setting was changed.
- Production was unchanged during the prototype and compatibility slices.
  On 26 October the owner approved only the public-contact publication; see
  the separate release record below. OAuth/brand/Premium drafts stay unmerged.
  No DNS, Cloud console, real Google login, sponsor outreach, payment or ad
  activation is included in the contact release.

## Durable decisions

- The owner deferred product discussion. The latest authorized slice is only
  the public-contact correction; it does not reopen Premium development/sales.
- The public contact is recorded in [BRAND.md](BRAND.md). Current general,
  privacy, legal/licensing and sponsorship contact copy uses that confirmed
  address. Login, account identity and mailbox/security setup are separate.
- Current free notes/history/recovery/export/Drive remain free. The editor
  remains ad-free for everyone. Existing storage limits are still real.
- Premium v1 proposal: collections, personal templates and later convenient
  batch export. US$19 once is only a provisional research hypothesis; no price
  is published in the prototype, no paid tier exists and no checkout is active.
- Direct sponsors precede AdSense. Future programmatic ads need a separate
  public-content origin. Keep the editor's current origin stable.
- The reported Google symptom is account selection/consent after returning
  later, not a failure to connect on every immediate reload. Static GIS access
  tokens expire; the current architecture does not provide permanent login.
- The owner reports Search Console ownership verified. Cloud branding review
  status and production audience still need account-side confirmation.

## Prototype boundary

- Local review route: `/preview/premium/`; UI is English. It is not linked from
  customer pages or included in sitemap; robots metadata is noindex/nofollow.
- Memory-only sample library. No IndexedDB, local/session storage, production
  store imports or service requests. CSP denies connections. Refresh restores
  original fixtures; the page visibly warns to use sample text only.
- Collection deletion removes membership, never notes. Template application
  creates a distinct note. Text is not normalized by the model.
- Download/import use `heldnote-premium-preview` version 1, distinct from real
  backups. Imports validate before replacement and require UI confirmation.
  Invalid files and cancellation preserve the current samples.
- Production DB, autosave, recovery, import/export and Drive code are unchanged.
  There is no production migration or entitlement implementation to enable.
- This same-origin route is code-isolated, not an origin sandbox or an access
  control mechanism. Do not add third-party scripts or real-note access.

## Validation

- Baseline before this slice: 167 browser tests, public-page checks and legal
  links passed.
- Accepted prototype unit suite: 179 browser tests passed, including 12 targeted prototype
  tests. Synthetic production backup checks confirm mutual file rejection and
  preserve exact note/draft/history text; existing backup import still works.
- The preview browser check covers denied storage, collection retention,
  template non-overwrite, import/download/cancel, text-only rendering, memory
  reset, synthetic note/history isolation, keyboard/Escape, blank-title draft
  handling, five widths, JS-off and no remote requests. The browser check passes.
- Static route checks enforce noindex, sitemap/navigation exclusion and no
  production imports/storage calls from preview modules. Legal links pass.

## Organization compatibility experiment

- [Decision record](ORGANIZATION_COMPATIBILITY.md) documents the actual backup,
  import/copy/merge and Drive validate/signature/merge/upload contracts.
- `preview/premium/organization-codec.js` is standalone and pure, imported by
  tests only. It wraps original schema-1 backup JSON text with version-1
  collections/templates/membership metadata. No storage/network or UI access,
  production schema migration, metadata upload, entitlement or activation.
- Strict new-format fields/version checks reject unsupported semantics,
  duplicate IDs/history keys, duplicate memberships and orphan references.
  Exact-target binding refuses a different backup even when note IDs match.
- Updated suite: 208 browser tests pass, including 29 compatibility checks and
  executable synthetic refusal fixtures. Tests preserve embedded backup bytes,
  note/history/template strings and actual legacy import/export content. The
  current importer rejects the new envelope/future backups before overwriting
  a synthetic existing note and history.
- Evidence explicitly shows old backup round trips stripping unknown fields;
  copy mode leaves arbitrary meta note references stale; Drive validation and
  upload discard metadata; current signatures ignore organization-only edits.
  Higher Drive schemaVersion alone does not gate old clients; syncFormat does.
- This proves an incompatibility boundary, not mixed-version live sync. The
  existing preview/UI/production paths and localized routes remain unchanged.

## Remaining gates

1. The prototype browser check and desktop/mobile screenshots are reviewed.
   Next product checkpoint: observe collection/template tasks using sample notes
   and record whether they solve a recurring writing problem. This prototype
   has no saved views, batch export or production persistence.
2. Before release: real phone/desktop Drive round trip, offline/conflict and
   fresh-browser recovery; installed Safari/Chrome behavior; real draft
   recovery and latency/quota measurements. Simulated tests do not close these.
3. Owner approval is still required for OAuth/brand/Premium publication. Review
   #1, then retarget #2 to main after #1 merges; merging main triggers deploy.
   The separate contact-only PR #3 was approved; that approval does not cover
   merging draft #1 or #2. Reconcile their legal revision dates with current
   main before a future release rather than reverting the contact release date.
4. Before real collections/templates: decide live-library binding, copy-ID
   remapping, merge/deletion/concurrent metadata semantics and a transport
   transition. The offline snapshot codec does not solve those. Approve and
   test atomic migration/restore, old tabs/clients, rollback constraints,
   independent backup and Drive compatibility. Never gate existing notes.
5. Before sales: validate useful scope/price, choose seller entity/country,
   verify provider onboarding/payouts, approve license/support/refund terms and
   separate trusted fulfillment infrastructure. No browser-shipped secrets.
6. Before sponsorship: owner selects/agrees partner, placement and reporting.
   Before AdSense: approve separate origin, actual provider configuration,
   content eligibility and applicable disclosures/consent. No outreach yet.

Localization beyond English, pricing research and real-device acceptance are
explicit follow-up work. The current English prototype is for review only.

## Public-contact correction — 24 October 2026

- Began clean at `0a02180`. Five current public files had product-domain
  contact/privacy addresses: LICENSE, privacy.html, terms.html, about.html and
  sponsorship.html. No personal Gmail was found in the current source/draft
  scan; this correction aligns those public roles with the confirmed contact.
- Provenance: `ec3bcb7` introduced the LICENSE request address; `0ffb81e`
  introduced separate general/privacy addresses; `fb4ddda` copied general
  contact into Terms. `a21fa59` carried it into About and Sponsorship. The
  checked-in pages were maintained independently, without a shared contact
  record or generator; existing checks did not compare mailto destinations.
- BRAND.md now records the confirmed public contact and all five static
  locations to maintain together. No runtime config/build/generator was added.
  /en/privacy and /en/terms remain redirects to the corrected canonical pages.
- Existing commits, logs, screenshots and synced reference files remain
  historical evidence. Authentication/Google configuration, credentials,
  account identity and Git authorship were not changed. No mailbox, domain,
  provider or security setup was performed; no email was sent.
- Current local sources and active draft PRs are the correction targets.
  Main and live pages remain unchanged until separately approved publication.
- Limited verification: 11 current mailto targets/visible contacts align, the
  sponsorship subject is preserved, both /en/ legal redirects still point to
  canonical pages, and public-page/legal-link checks pass. A temporary copy of
  the OAuth draft's three contact files also passes its 4-page legal checker
  and 8 mailto checks. No app/storage/auth code changed; browser suites were
  not rerun for this content-only correction.

## Contact-only publication — 26 October 2026

- The owner approved publication after the contact-correction report. Interpret
  that approval narrowly: current production contacts only, not OAuth fixes,
  the landing redesign, sponsorship placement or Premium development.
- [PR #3](https://github.com/OFCode-dev/heldnote/pull/3) starts from production
  `9c71112` and changes only LICENSE, privacy.html and terms.html. Eight mailto
  recipients/visible contacts use the confirmed address; the two legal revision
  dates are 26 October 2026. Runtime, storage, Google and workflow files match
  the previous production revision.
- PR #3 was merged at `a6c2f8e`; the existing
  [test-and-deploy run](https://github.com/OFCode-dev/heldnote/actions/runs/40240397899)
  completed successfully, including its browser test and GitHub Pages deploy
  jobs. Draft #1/#2 remain open, unmerged and stacked. About and
  Sponsorship contact copy remains in draft #2 until its separate approval.
- Targeted legal-link checks passed on the exact production snapshot (4 legal
  routes, 8 mailto recipients). No email was sent and no mailbox/domain/account
  configuration or DNS/OAuth Console setting was changed.
- Post-release source verification confirms main tree `aeb09eb` differs from
  prior production only in the three approved contact/legal files. The live
  /privacy and /terms read attempts returned the web tool's Internal Error /
  “not accessible via this tool” (with and without a cache-busting query).
  Stop that access check; no alternate access path was used. Deployment is
  confirmed by GitHub, but an independent live HTML read remains unverified.
