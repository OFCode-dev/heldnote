# Risk & Assumption Review: Quick Keep Notepad

## Metadata
- Date: 2026-08-05
- Reviewed Artifacts:
  - .claude/artifacts/planning/problem-description.md
  - .claude/artifacts/planning/product-requirements.md
  - .claude/artifacts/planning/data-assessment.md
  - .claude/artifacts/planning/store-api.md
- Open Questions:
  - .claude/artifacts/decisions/open-questions.md

## Confirmed Truths
- The predecessor persists nothing at all
  - Evidence: A search of `quick-web-notepad/index.html` for `localStorage`, `sessionStorage`, `IndexedDB`, `beforeunload`, `setItem`, and `getItem` returns zero matches across 1628 lines
- The app can ship with no server and no hosting cost
  - Evidence: The predecessor is already published as static files on GitHub Pages, and every capability in the v1 scope is client-side
- Restoring a version cannot corrupt a note
  - Evidence: With snapshots, restore is a read of stored text followed by a normal write; no computation stands between the stored bytes and the restored text
- The storage strategy can be replaced without touching the UI
  - Evidence: The `store.js` contract exposes no storage type, and the snapshot/diff decision was reversed mid-design with no change outside that module

## Key Risks

- Safari evicts IndexedDB after roughly seven days without a visit
  - Category: Technical
  - Likelihood: High
  - Impact: High
  - Mitigation: **Corrected 2026-08-06.** The original mitigation here was wrong: `persist()` is not understood to grant an exemption from WebKit's seven-day cap, and the documented exemption is an installed Home Screen or Dock web app whose storage is separate from ordinary Safari's. Private Browsing is a further trap — a real write probe succeeds there while the storage is an ephemeral per-tab session. The decision taken is to declare ordinary Safari non-durable, keep calling `persist()` as one input to a reported retention state, and never treat a successful write probe as proof of durability
  - Owner: Developer

- A debounce that resets on every keystroke may never fire while typing continues
  - Category: Technical
  - Likelihood: High
  - Impact: High
  - Mitigation: The draft write needs a maximum wait as well as a quiet period — write at least every second regardless of ongoing typing. Without it, a fast typist who never pauses is protected by nothing, which is precisely the user this product exists for
  - Owner: Developer

- A crashed tab never releases its note lock
  - Category: Technical
  - Likelihood: Medium
  - Impact: Medium
  - Mitigation: The lock carries a heartbeat and expires; a lock whose holder has stopped announcing itself is treated as stale and reclaimed, rather than leaving a note read-only until storage is cleared
  - Owner: Developer

- The draft and the newest version can disagree after a partial failure
  - Category: Data
  - Likelihood: Low
  - Impact: High
  - Mitigation: On open, compare the draft's `savedAt` with the newest version's `at` and present whichever is newer; never assume the draft is ahead just because it usually is
  - Owner: Developer

- Export builds the entire database in memory as one Blob
  - Category: Technical
  - Likelihood: Medium
  - Impact: Medium
  - Mitigation: Report size before exporting, and stream the file rather than concatenating it if the total exceeds a threshold; the failure mode otherwise is a hung tab during the one operation the user reaches for when worried about their data
  - Owner: Developer

- Merge-on-import has no defined conflict rule
  - Category: Data
  - Likelihood: High
  - Impact: Medium
  - Mitigation: State the rule explicitly — the note with the newer `updatedAt` wins, version histories are combined by `seq`, and nothing is discarded silently. Until the rule is written down, two reasonable implementations disagree
  - Owner: Developer

- Requesting persistent storage interrupts the first typing session
  - Category: Product
  - Likelihood: Medium
  - Impact: Low
  - Mitigation: Ask after the first version is committed rather than at note creation, so the prompt lands in a pause instead of mid-sentence
  - Owner: Developer

- `rev` is written but never read in v1
  - Category: Data
  - Likelihood: Medium
  - Impact: Medium
  - Mitigation: A field nothing reads is a field nothing verifies; assert its invariants in the store tests so that v2 does not discover a year of malformed values
  - Owner: Developer

- The product succeeds at being trusted, and the user stops keeping copies
  - Category: Product
  - Likelihood: High
  - Impact: High
  - Mitigation: This is the goal, not a defect, but it removes the safety net that currently absorbs bugs. It is the reason recovery paths are Must rather than Should, and the reason export exists in v1 despite sync being deferred
  - Owner: Owner

## Dangerous Assumptions

- Persistent storage will be granted where it matters
  - Why dangerous: The core promise is delegated to a browser decision the app does not control and cannot appeal
  - How to validate: Request it on each target browser and record what is actually granted, particularly on Safari and in Firefox's stricter modes
  - If false, what breaks: The app can lose everything through eviction while displaying a saved state — the exact failure it was built to prevent

- IndexedDB is available wherever the page loads
  - Why dangerous: Private windows and hardened privacy settings can block it, and the app looks identical right up until nothing is stored
  - How to validate: Probe at startup with a real write, not a feature check
  - If false, what breaks: Nothing is saved while the interface implies otherwise

- A timestamp list is enough to find a wanted version
  - Why dangerous: History that cannot be navigated is storage rather than a feature
  - How to validate: Try to recover a specific earlier state a week after writing it
  - If false, what breaks: The version history exists but does not solve the problem it was built for

- 300 ms and 2 s are the right intervals
  - Why dangerous: They were chosen by intuition, and the first governs the product's central guarantee
  - How to validate: Measure real write latency with a realistic database, then set the numbers from data
  - If false, what breaks: Either more is lost than promised, or writes pile up faster than they complete

- One user per browser profile
  - Why dangerous: A shared machine exposes every note to whoever opens the page, with no lock of any kind
  - How to validate: Confirm the intended usage, and whether the demo page will be used on shared machines
  - If false, what breaks: Notes are readable by anyone with access to the browser, which encryption was explicitly deferred from addressing

## Scope Creep Watchlist
- Searching within version history, once the timestamp list proves hard to navigate
- Adding Drive sync early because the fields are already there and it feels close
- Tags and folders arriving as "just a filter"
- Markdown preview, which is one small step from the syntax highlighter already being built
- Carrying the old protect mode over because it exists, without deciding what it is for
- Conflict resolution creeping in ahead of the sync that would need it

## Over-Engineering Traps

- The four-tier pruning ladder
  - Simplest safe alternative: Keep the newest N versions and one per day beyond that. Two rules instead of four, with a nearly identical result for realistic usage, and far less to reason about when it misbehaves

- Cursor pagination on version listings
  - Simplest safe alternative: A per-note cap of 200 with no text in the listing makes a single read cheap enough. Keep the cursor in the contract's shape, but do not build paging UI until a note actually has enough history to need it

- Syntax highlighting in v1
  - Simplest safe alternative: It is the most expensive carried-over feature, it introduces the app's only markup-injection surface, and it serves a use this product is not primarily for. Deferring it would remove a whole class of risk from v1

- A separate lock protocol between tabs
  - Simplest safe alternative: Compare a last-write timestamp on focus and warn when the note changed underneath. Weaker, but a fraction of the moving parts

## Recommended Simplifications

- Collapse the pruning ladder to two tiers
  - Tradeoff: Slightly coarser history between one day and one month old
  - Why acceptable: No user has ever asked for the version from 14:00 versus 15:00 three weeks ago, and the tier that matters — recent history — is untouched

- Defer syntax highlighting to v1.1
  - Tradeoff: The editor feels less capable next to its predecessor at launch
  - Why acceptable: It removes the injection surface entirely from the first release, and it is the feature least connected to the reason this project exists

- Make accessibility a Must rather than a Should
  - Tradeoff: Slightly more work before shipping
  - Why acceptable: The product is a text editor; keyboard operation and labelled controls are its basic surface, not an enhancement

- Drop `rev` from v1 and introduce it with sync
  - Tradeoff: v2 must backfill it for notes created before sync
  - Why acceptable: The backfill is trivial and local, while an unread field is guaranteed to be wrong by the time anything depends on it. Keep it only if its invariants are tested
