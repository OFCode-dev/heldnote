# Problem Description: Quick Keep Notepad

## Metadata
- Date: 2026-08-05
- Owner: Omer Faruk Bayrak (OFCode-dev)
- Project Meta: .claude/artifacts/project/project-meta.md

## Summary
- `quick-web-notepad` has no persistence of any kind: a search of its source for `localStorage`, `IndexedDB`, or `beforeunload` returns nothing.
- Closing the tab, refreshing, or a crash destroys whatever was being written, with no warning and no recovery.
- The notepad is used for quick capture, which is exactly the context where the user has not yet saved anything anywhere else.
- A single pad also forces unrelated thoughts into one buffer, so keeping one note means not writing another.
- The goal is a notepad that is trustworthy by default: text survives without the user doing anything, and earlier states remain reachable.
- Success is measured by recovery, not by features: after any abrupt ending, the text comes back.
- v1 is local to one browser. Cross-device sync is desirable and planned, but is not what makes the app trustworthy.

## Problem
Today the user opens the notepad, types, and is the only safety mechanism in the
system. Nothing is written down anywhere until they manually download a file.
A refresh, an accidental tab close, a browser crash, or a machine restart erases
everything typed since the page was opened. The failure is silent: there is no
prompt, no draft, and no trace afterward. Because the tool is used precisely for
fast, unplanned capture, the material lost this way is material that existed
nowhere else.

The single-pad shape compounds this. All content shares one buffer, so starting
a new thought means overwriting or crowding an old one, and there is no way to
return to what the pad held yesterday. Even without a crash, content is lost by
being typed over.

## Desired Outcomes
- Typing is enough. The user never performs a save action to be safe.
- Any abrupt ending — refresh, close, crash, power loss — costs no more than a moment's typing.
- Earlier states of a note are reachable, so overwriting is recoverable rather than final.
- Separate thoughts live in separate notes instead of competing for one buffer.
- Deleting is reversible; nothing leaves the system on a single click.
- The user can take their data out in one file and put it back.

## Stakeholders
- Omer Faruk Bayrak
  - Type: Customer
  - Goals: Capture text instantly without ceremony, and trust that it will still be there later
  - Responsibilities: Owns the product direction and the code
- Visitors to the GitHub Pages demo
  - Type: Customer
  - Goals: Use a notepad that works immediately, with no account and no setup
  - Responsibilities: None; they arrive with no context and no instructions

## Current Workflows
- Capture a quick note in `quick-web-notepad`
  - Trigger: The user needs to write something down immediately
  - Steps:
    1. Open the notepad page
    2. Type into the single textarea
    3. Optionally download the text as a file
  - Success End State: The text was downloaded before the tab was closed
  - Failure States:
    - The tab is closed or refreshed before any download, and all text is gone with no warning
    - The browser or machine crashes, with the same result
    - New content is typed over old content, and the old content cannot be recovered
    - The user leaves the tab open indefinitely to avoid losing it, turning the browser into unreliable storage

## In Scope
- Multiple notes, each independently addressable, with search and pinning
- Continuous automatic saving with no user action
- Recovery of in-progress text after an abrupt ending
- Per-note version history with restore
- Reversible deletion via a trash
- Visible save state, so the user can see that the promise is being kept
- Full export and import as a single JSON file
- Find and replace, syntax highlighting with line numbers, dark theme, zoom, Turkish and English UI

## Out of Scope
- Cross-device synchronisation, including Google Drive (planned as v2)
- Writing notes directly to files on disk
- Tags, folders, or any organisation beyond search and pinning
- Markdown preview or rich text
- Sharing, collaboration, and multi-user anything
- Encryption and the protect mode carried by the old project
- A native or installable mobile app; the page is responsive but not app-shaped

## Constraints
- No backend and no hosting cost
  - Source: Budget
  - Notes: Published as static files on GitHub Pages, so all storage must be client-side
- No build step and no runtime dependencies
  - Source: Operational
  - Notes: Matches the rest of the "Quick" family; the page must run by opening it
- Storage is governed by the browser, not by the app
  - Source: Operational
  - Notes: Quota and eviction policy are the browser's to decide; the app can request persistence but cannot guarantee it
- Data stays in one browser profile in v1
  - Source: Org
  - Notes: A deliberate scope decision, not a technical limit

## Risks
- The browser evicts stored data when disk pressure is high
  - Likelihood: Low
  - Impact: High
  - Mitigation: Request persistent storage at first use, and make export easy enough to be a habit
- Storage is unavailable, as in a private window or with strict privacy settings
  - Likelihood: Medium
  - Impact: High
  - Mitigation: Detect at startup and say plainly that nothing is being saved, rather than appearing to save
- The storage quota fills, and writes begin to fail
  - Likelihood: Low
  - Impact: Medium
  - Mitigation: Prune old versions first, keep the draft layer writing, and surface the condition
- The same note is open in two tabs, and one silently overwrites the other
  - Likelihood: Medium
  - Impact: High
  - Mitigation: Tabs announce which note they hold; the second opens read-only with an explicit override
- Version history grows without bound and crowds out the notes themselves
  - Likelihood: Medium
  - Impact: Medium
  - Mitigation: A pruning ladder that thins older versions, plus a per-note cap
- The user trusts the app and stops keeping copies, making any later failure worse
  - Likelihood: Medium
  - Impact: High
  - Mitigation: This is the point of the product; it raises the bar for the recovery paths above rather than arguing against them

## Unknowns
- How much history a real month of use actually accumulates
  - Why it matters: Determines whether the pruning ladder and the cap are tuned correctly
  - Suggested question: After a month of daily use, how many versions and how many megabytes does a typical note hold?
- Whether a timestamp list is enough to find an old version
  - Why it matters: If the user cannot find the state they want, the history exists but does not solve the problem
  - Suggested question: When looking for an earlier state, does the user recall roughly when it was, or only what it said?
- How large a note can get before snapshot history becomes wasteful
  - Why it matters: Snapshots scale with note size, so a very large note is the case where the chosen approach costs most
  - Suggested question: What is the largest note the user realistically keeps here rather than in a file?

## Simplification Opportunities
- Derive the note title from its first line instead of adding a title field
  - Why it helps: Removes a field, a form control, and the empty-title case entirely
- Treat deletion as a flag rather than a removal
  - Why it helps: The trash, undo, and the future sync tombstone all fall out of one field
- Let restoring a version be an ordinary edit
  - Why it helps: No separate undo mechanism is needed, because restoring is itself recorded like any other change
- Keep the draft layer free of any computation
  - Why it helps: The path that must never fail stays a plain write, with nothing in it that can go wrong

## References
- .claude/artifacts/project/project-meta.md
- .claude/artifacts/decisions/open-questions.md
