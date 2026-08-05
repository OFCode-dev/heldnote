# PRD: Quick Keep Notepad

## Metadata
- Version: 0.1
- Date: 2026-08-05
- Owner: Omer Faruk Bayrak (OFCode-dev)

## Problem Statement
`quick-web-notepad` keeps nothing. Its source contains no storage call of any
kind, so a refresh, a closed tab, or a crash erases whatever was being written,
silently and permanently. The tool is used for fast unplanned capture, which is
exactly when the text exists nowhere else.

Its single pad makes this worse in a quieter way. One buffer holds everything, so
a new thought crowds out or overwrites an older one, and yesterday's contents are
unreachable even if the tab never closed.

Quick Keep Notepad replaces it with a notepad that is trustworthy without being
managed: many notes, saved continuously with no user action, each with a history
that makes overwriting recoverable.

## Goals
- Text survives any abrupt ending without the user having saved anything
- Earlier states of a note stay reachable, so overwriting is not final
- Separate thoughts live in separate notes
- The user can see that saving is happening, and therefore trust it
- Deletion is reversible
- All data can be exported to one file and imported back
- The app runs as static files with no server, no build step, and no dependencies

## Non-Goals
- Cross-device synchronisation, including Google Drive — planned as v2
- Writing notes directly to files on disk
- Tags, folders, or organisation beyond search and pinning
- Markdown preview, rich text, and syntax highlighting — the last deferred to v1.1
- Sharing, collaboration, or multi-user features
- Encryption, and the protect mode carried by the old project
- A native or installable mobile app

## Users
- Omer Faruk Bayrak (Primary) — captures text constantly and needs it to still be there later
- Visitors to the GitHub Pages demo (Secondary) — arrive with no account, no setup, and no instructions

## Scope
v1 is a single static page holding multiple notes in the browser, with two
layers of persistence: a draft written continuously as the user types, and
committed snapshots that form a per-note version history. It includes note
management (create, search, pin, soft delete with undo), version restore, JSON
export and import, and the editor features carried over from the predecessor.

Everything stays inside one browser profile. The data model carries the fields
synchronisation will later need, but no synchronisation code ships in v1.

## Functional Requirements

- Multiple notes
  - Description: The user can hold many notes at once, each independently addressable, listed with its title and last-modified time.
  - Priority: Must
  - Acceptance Criteria:
    - Creating a note leaves existing notes untouched and opens the new one focused for typing
    - The note list shows every note that is not in the trash
    - A note's title is derived from its first non-empty line, and updates as that line is edited
    - A note whose text is entirely empty still appears in the list, titled as untitled

- Continuous draft saving
  - Description: Every keystroke is persisted, without the user performing any save action.
  - Priority: Must
  - Acceptance Criteria:
    - Text is written to storage no later than 300 ms after the last keystroke
    - While typing continues without any pause, text is still written at least once per second, so that a fast typist is never left unprotected by a debounce that keeps resetting
    - Switching away from the tab or closing it forces an immediate write before the page unloads
    - No save button exists anywhere in the interface
    - The draft write path performs no computation beyond storing the text

- Recovery after an abrupt ending
  - Description: After a refresh, a crash, or a machine restart, the note reopens with its text intact.
  - Priority: Must
  - Acceptance Criteria:
    - Killing the tab mid-sentence and reopening the app restores the text, losing at most the last 300 ms of typing
    - The recovered text is read back verbatim, not reconstructed
    - When the draft and the newest version disagree, the newer of the two by timestamp is presented; the draft is not assumed to be ahead
    - The app reopens the note that was open when it ended

- Version history
  - Description: Each note accumulates timestamped snapshots of its earlier states.
  - Priority: Must
  - Acceptance Criteria:
    - A new version is committed roughly 2 s after the user stops typing
    - During continuous typing with no pause, a version is committed at least every 2 minutes
    - No version is committed when the text is unchanged since the previous one
    - The history panel lists versions newest first with their timestamps

- Restore a version
  - Description: The user can return a note to any state in its history.
  - Priority: Must
  - Acceptance Criteria:
    - Selecting a version shows its content before anything is changed
    - Restoring replaces the note's current text with the selected version's text exactly
    - The restore is itself committed as a new version, so it can be undone by restoring the state before it
    - No version is deleted by restoring

- Version pruning
  - Description: History is thinned as it ages so that storage stays bounded.
  - Priority: Must
  - Acceptance Criteria:
    - The newest 50 versions of a note are all retained
    - Beyond those, at most one version per day is kept
    - A note retains at most 200 versions; beyond that the oldest daily versions are dropped first
    - The newest version of a note is never pruned

- Trash and undo
  - Description: Deleting a note is reversible.
  - Priority: Must
  - Acceptance Criteria:
    - Deleting removes the note from the main list and places it in the trash, keeping its version history
    - An undo affordance appears immediately after deletion and restores the note fully
    - Notes in the trash are purged permanently 30 days after deletion
    - The trash is viewable, and a note can be restored from it at any time before purge

- Search across notes
  - Description: The user can find a note by its content or title.
  - Priority: Must
  - Acceptance Criteria:
    - Typing in the search field filters the note list as the user types
    - Matching is case-insensitive and covers title and body text
    - Clearing the search restores the full list
    - Notes in the trash are excluded from search results

- Pin a note
  - Description: Important notes stay at the top of the list.
  - Priority: Should
  - Acceptance Criteria:
    - Pinning moves a note above all unpinned notes and survives reload
    - Pinned notes sort among themselves by last-modified time

- Visible save state
  - Description: The interface continuously shows whether the current text is stored.
  - Priority: Must
  - Acceptance Criteria:
    - The status bar shows a saved state with the time of the last write, or a saving state while a write is pending
    - When storage is failing or unavailable, the indicator shows that plainly rather than showing saved
    - The indicator is visible without scrolling or interaction

- Export and import
  - Description: All data can leave and re-enter the app as one file.
  - Priority: Must
  - Acceptance Criteria:
    - Export produces a single JSON file containing every note, its version history, trashed notes, and settings
    - Import restores from such a file, and the user chooses between merging with existing notes and replacing them
    - The file carries its own schema version, and a file whose version is not understood is refused rather than guessed at
    - On merge, a note present in both wins by the newer `updatedAt`, version histories are combined, and nothing is discarded silently
    - Importing a file that is not valid JSON, or lacks the expected shape, fails with a message and changes nothing
    - An export followed by a wipe and an import returns the app to its previous state

- Storage availability and persistence
  - Description: The app knows whether it can actually store data, and asks the browser not to evict it.
  - Priority: Must
  - Acceptance Criteria:
    - Storage is probed at startup; if unavailable, a persistent banner states that nothing is being saved and offers export
    - When storage is unavailable the app remains usable, and never displays a saved state
    - Persistent storage is requested from the browser after the first version is committed, so the prompt lands in a pause rather than mid-sentence
    - When persistent storage is not granted, a standing notice states that the browser may remove this data, in every browser and with no browser-specific exception
    - Refusal of persistent storage does not interrupt the user or block any feature

- Quota exhaustion handling
  - Description: Running out of space degrades in a defined order rather than failing silently.
  - Priority: Must
  - Acceptance Criteria:
    - A failed write due to quota triggers pruning of the oldest versions, then one retry
    - If space is still unavailable, version commits stop while draft writes continue
    - The user is told that history is no longer being kept, and export is offered
    - Draft writes are the last thing to be sacrificed

- Multi-tab guard
  - Description: The same note open twice cannot silently lose one tab's work.
  - Priority: Must
  - Acceptance Criteria:
    - Opening a note already open in another tab opens it read-only with an explanation
    - The user can override and edit anyway from that message
    - Closing the first tab releases the note for editing in the second
    - A lock whose holder has stopped announcing itself expires and is reclaimed, so a crashed tab cannot leave a note read-only
    - Two tabs editing different notes are unaffected

- Editor features carried over
  - Description: The editing experience matches the predecessor where it was good.
  - Priority: Should
  - Acceptance Criteria:
    - Find and replace supports next, previous, replace, and replace all within the open note
    - Line numbers can be toggled; syntax highlighting is deferred to v1.1
    - A dark theme toggle and font zoom controls persist across reloads
    - Word and character counts are shown for the open note

- Turkish and English interface
  - Description: The interface language follows the browser, and can be changed.
  - Priority: Should
  - Acceptance Criteria:
    - The initial language is chosen from the browser's preferred language, defaulting to English
    - The user can switch language, and the choice persists across reloads
    - No user-visible string is left untranslated in either language

## Non-Functional Requirements

- Draft durability window
  - Target: At most 300 ms of typing is lost in any abrupt ending
  - Priority: Must

- Startup time
  - Target: The last open note is visible and editable within 500 ms of page load on a mid-range laptop, with 100 notes stored
  - Priority: Should

- Typing responsiveness
  - Target: No input latency perceptible to the user while saving; storage writes never block typing
  - Priority: Must

- History storage footprint
  - Target: A note edited daily for a year stays under roughly 5 MB of history after pruning
  - Priority: Should

- No dependencies, no build
  - Target: The app runs from static files opened directly; zero runtime dependencies and zero build steps
  - Priority: Must

- Browser support
  - Target: Current Chrome, Firefox, Edge, and Safari, on desktop and mobile browsers
  - Priority: Must

- Accessibility
  - Target: All controls reachable and operable by keyboard, with visible focus and labelled controls
  - Priority: Must

- Data safety on failure
  - Target: No failure path results in stored text being overwritten with worse text or removed without the user asking
  - Priority: Must

## Workflows

- Capture a new note
  - Trigger: The user opens the app or presses the new-note control
  - Steps:
    1. A new empty note is created and focused
    2. The user types
    3. The draft is written continuously as they type
    4. Versions are committed as the user pauses
  - Success End State: The note appears in the list, titled from its first line, and its text is stored
  - Failure States:
    - Storage is unavailable, and the user is told plainly that nothing is being saved
    - Quota is exhausted, and version commits stop while draft writes continue

- Recover after an abrupt ending
  - Trigger: The user reopens the app after a crash, a refresh, or a closed tab
  - Steps:
    1. The app opens the note that was last active
    2. Its draft text is read back and displayed
  - Success End State: The text is as it was, minus at most the last moment of typing
  - Failure States:
    - The database will not open, and the user is offered export of whatever is readable
    - The browser evicted the data, and the app says so rather than presenting an empty note as normal

- Return to an earlier version
  - Trigger: The user opens the history panel for a note
  - Steps:
    1. Versions are listed newest first with timestamps
    2. The user selects one and previews it
    3. The user confirms the restore
  - Success End State: The note holds the earlier text, and the restore is recorded as a new version
  - Failure States:
    - The wanted state was pruned, and the user sees the surviving neighbours instead
    - The user restores by mistake, and undoes it by restoring the version made just before

- Delete and undo
  - Trigger: The user deletes a note
  - Steps:
    1. The note leaves the list and enters the trash
    2. An undo affordance appears
  - Success End State: The note is out of the way but fully recoverable for 30 days
  - Failure States:
    - The user misses the undo affordance and recovers the note from the trash instead

- Export and import
  - Trigger: The user asks to export, or to import a file
  - Steps:
    1. Export writes all notes, history, trash, and settings to one JSON file
    2. Import reads such a file and asks whether to merge or replace
    3. The chosen action is applied
  - Success End State: The data is outside the browser, or restored back into it
  - Failure States:
    - The file is malformed, and nothing is changed
    - Import would exceed the quota, and the user is told before anything is written

## Success Criteria
- Killing the tab mid-sentence and reopening never costs more than the last moment of typing, across all supported browsers
- A note overwritten by accident can be returned to its earlier state through the history panel
- A deleted note can be brought back
- Exporting, clearing storage, and importing returns the app to its exact prior state
- With storage unavailable, the app never once displays a saved state
- The user stops keeping a second copy of quick notes elsewhere, because this one is trusted

## Assumptions
- Pruning thresholds (all versions for an hour, hourly for a day, daily for 30 days, weekly beyond, capped at 200 per note) are a starting point chosen without usage data, and are expected to be tuned. Recorded as an open question.
- Trash retention of 30 days is assumed rather than established. Recorded as an open question.
- Notes are text of ordinary size; no upper bound is enforced in v1, and very large notes are accepted as the worst case for snapshot history. Recorded as an open question.
- A timestamp list is assumed sufficient for finding a version; searching across versions is not in v1. Recorded as an open question.
- IndexedDB is available and grants enough quota in the browsers being targeted, absent private-browsing or hardened privacy settings.
- One user per browser profile; no account, no identity, and no access control in v1.
- The user is willing to export occasionally as a backup habit while sync does not exist.
