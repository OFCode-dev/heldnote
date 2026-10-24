# Heldnote Premium proposal

Planning draft, 24 October 2026. This is a proposed product direction, not a
customer offer, release commitment or implemented payment system. Heldnote
currently has no paid tier. Public pricing and legal copy remain unchanged.

## Recommendation

Keep the dependable notepad free. Sell additional tools for people who return
to Heldnote for recurring writing and want to organize that work. Start with
one paid package, **Heldnote Premium**, purchased once. Consider a subscription
only when there is an optional service with continuing delivery and costs.

The proposed positioning is: **a quieter place for your everyday writing,
with tools to make it your own**. Privacy, recovery and access to your own
writing must never depend on a purchase or a successful license check.

## Free and Premium

| Capability | Free | Proposed Premium v1 |
| --- | --- | --- |
| Local notes, autosave and existing storage protections | Keep | Same protections |
| Existing version history, restore and trash | Keep | Same recovery access |
| Search, pinning and current writing controls | Keep | Add reusable filtered views |
| JSON backup/import and individual TXT export | Keep | Add convenient batch TXT/Markdown export |
| Current optional Google Drive sync | Keep | No extra sync guarantee |
| English/Turkish UI and current light/dark themes | Keep | Add optional writing presets |
| Organizing recurring work | Current note list | Named collections and saved views |
| Starting similar notes repeatedly | Blank note | Personal reusable templates |
| Advertising in the editor | None | None |

Do not introduce artificial note limits, shorten existing history, remove
current themes or charge to recover/export writing. Browser quota and bounded
history still apply; neither tier can promise unlimited durable storage.

## First paid release scope

Build the smallest useful workflow: **collect, reuse, take with you**.

1. **Collections and saved views.** Group notes without changing their text;
   provide an always-available All notes view and persist useful filters.
   Start with collections rather than both folders and tags. Deleting a
   collection must never delete its notes.
2. **Personal templates.** Save reusable starting text for meeting notes,
   daily writing or project logs. Applying a template creates a new note;
   it must not overwrite the active draft. Existing notes remain ordinary,
   editable notes after a license problem.
3. **Batch export.** Export selected notes as TXT/Markdown with safe filenames
   and a manifest. Keep full JSON recovery free. Plain-text content remains
   plain text; exporting .md does not imply a rich-text editor. Do not add a
   ZIP dependency just for packaging; evaluate native multi-file download
   behavior and consent in supported browsers before settling the format.

Writing presets are a later enhancement if users ask for them. Do not block
the first paid release on custom themes, collaboration, rich text or AI.
Do not sell permanent Google authorization, automatic background backup or
end-to-end encryption: those are not capabilities of the current design.

## Price to validate

**US$19 once** is a starting hypothesis for the first completed Premium bundle,
not a published price or evidence of willingness to pay. Show the proposed
scope and price together in a prototype before building a checkout. Confirm
the seller's currency, taxes, fees and net proceeds before setting a final
customer price; do not invent a TRY conversion or a discounted reference price.

Sell a defined Premium v1 feature license. Explain update and support terms
before purchase. Avoid an undefined “lifetime” promise covering every future
service. Do not accept payment for roadmap items that are not ready.

For context, [Obsidian's official pricing](https://obsidian.md/pricing) combines
a free core with paid services and a US$25 one-time Catalyst support license;
Sync is US$4/month billed annually or US$5 monthly. This shows one packaging
approach, not a direct feature comparison or proof of Heldnote demand.
Prices checked 24 October 2026.

## Technical boundary

The editor stays static, on its existing origin, without a build step or new
runtime packages. Current IndexedDB notes, history and free Drive sync must
continue working without a payment provider. Paid organization metadata needs
a separate design review for local schema, export/import and Drive merging:
older clients must not silently strip it, and unsupported formats must fail
without overwriting existing data. Do not assume new fields synchronize today.

Payment and license issuance are **new infrastructure**, even if a provider
hosts the checkout. Choose the seller's legal entity/country and verify current
onboarding eligibility first; provider selection is still open. For example,
[Stripe publishes country availability](https://stripe.com/global), which
must be checked for the actual seller rather than inferred from customers'
ability to pay. No provider account, tax treatment or payout is assumed here.

The smallest candidate architecture is a provider-hosted checkout plus a
trusted license issuer outside GitHub Pages. An issuer could deliver a signed,
portable license; the static editor verifies it using only a public key.
Automated issuance, payment verification, refunds and key recovery need a
provider capability or a separately approved small service. Neither a checkout
return URL nor a localStorage flag proves payment. Never ship a payment API
secret, webhook secret or signing key to the browser.

A signed offline license is a convenience and entitlement mechanism, not
unbreakable copy protection for public client code. Accept that limitation
rather than adding intrusive DRM. Define device portability and refund/revocation
behavior before launch; offline clients cannot instantly learn of revocation.

Verification outages, lost licenses and downgrades must not block writing,
opening notes, history restore or export. Preserve existing organization and
keep it visible; any gating of new Premium actions needs a clear recovery path.
Purchase identity stays separate from note content and Google Drive tokens.
Do not request new Drive permissions to sell a license.

## Revenue and advertising

The first advertising step remains a direct sponsor on public pages using
self-hosted assets and a clearly labelled link. No sponsor is active and no
audience size is promised. Sponsors do not receive note content or Drive data.
The editor stays free of ads for everyone; “ad-free” is not a Premium benefit.

AdSense remains a later project on a separate public-content origin. A path
such as /guides on heldnote.app does not isolate ad scripts from that origin's
notes and credentials. Keep the editor origin stable; review content,
provider approval, disclosures and consent before any programmatic launch.
See [BRAND.md](BRAND.md) for the commercial boundary.

## Delivery order and release gates

| Order | Work | Evidence needed to move on |
| --- | --- | --- |
| 1 | Finish release QA for the current OAuth and brand PRs | Real phone/desktop Drive round trip, conflict/offline recovery, installed Safari/Chrome checks and draft recovery; resolve failures before release |
| 2 | Review the release and launch with owner approval | Review OAuth PR #1 first, then retarget brand PR #2 to main; merging main currently triggers production deployment |
| 3 | Establish discovery and sponsor baseline | After release: Search Console indexing/canonical checks, real mobile performance, first agreed sponsor placement; report measured figures only |
| 4 | Validate Premium with a local prototype | Invite roughly 10–15 current users; learn their recurring workflow, observe collection/template tasks, record reactions to the proposed price and reasons to decline |
| 5 | Build the proven bundle and licensing | Stable migration/old-client behavior, independent export recovery, localized flows, offline license recovery and tested payment failure/refund paths |
| 6 | Publish an actual paid offer | Ready features, confirmed provider/payout, agreed license/support terms, accurate pricing/privacy/terms and explicit owner approval for production |

Interview counts are proposed research scope, not existing usage. Do not
collect note text for research or quietly add analytics. If measurement is
needed, first design minimal aggregate events and explain consent and retention.

No calendar date or revenue forecast is committed. Premium prototyping can
run alongside sponsor preparation, but it must not delay data-safety fixes.
An optional managed backup subscription can be evaluated later, after demand,
operating costs, recovery behavior and a new service architecture are known.

## Next concrete increment

An English sample-only prototype is available at `/preview/premium/` on the
review branch. Collections and personal templates use session memory only;
refresh discards the examples. Preview JSON is deliberately incompatible with
real backups, and import requires confirmation. No paid activation, price,
production schema change or Drive integration is included.

Review these tasks at phone and desktop widths before building real storage or
a pricing page. Turkish prototype localization, saved views and batch export
remain later work. Keep release QA and owner approval as independent gates.
See [MEMORY.md](MEMORY.md) for validation and exact remaining decisions.
