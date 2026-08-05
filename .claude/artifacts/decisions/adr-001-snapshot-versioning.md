# ADR 001: Version history stores full snapshots, not diffs

- Date: 2026-08-05
- Status: Accepted
- Deciders: Omer Faruk Bayrak

## Context

Quick Keep Notepad exists because its predecessor lost text. Its central promise
is that nothing typed is ever lost, and part of keeping that promise is a version
history: earlier states of a note must remain reachable, so that overwriting is
recoverable rather than final.

That history has to be stored somehow, and the choice is not cosmetic. It decides
what happens when a stored record is damaged, how long a restore takes, how much
disk a year of daily editing consumes, and how much machinery sits between the
user pressing restore and the text appearing.

Three options were considered.

**Full snapshots.** Each committed version stores the note's entire text.
Restoring reads one record.

**A diff log.** A base text plus an append-only chain of patches. Restoring
replays the chain from the base to the target revision.

**A hybrid.** Periodic snapshots with diffs between them.

## Decision

Version history stores full snapshots. A note's history is a list of records, each
holding the complete text at a moment in time, thinned as it ages by a pruning
policy: the newest 50 versions are all kept, older ones are thinned to one per day,
and a note holds at most 200 versions.

## Rationale

Restoring becomes a read rather than a computation. Nothing stands between the
stored bytes and the text the user gets back, so there is no mechanism by which
history can silently drift from what was actually written. In a product whose one
job is not losing text, the property worth optimising for is that the recovery
path cannot be wrong.

The cost is disk, and it is affordable. A 50 KB note with 200 retained versions is
roughly 10 MB against an IndexedDB quota measured in hundreds of megabytes or more.
The pruning ladder bounds it further.

The diff log saves that disk and charges for it in correctness surface. Restoring
requires replaying every patch in the chain, so a single damaged record invalidates
everything after it, and the damage is not obvious at the point it occurs — it
surfaces later as text that is subtly wrong. Making that safe requires a checksum
on every operation and periodic re-baselining, which means the simple option was
never really simple: it was a diff engine, an integrity chain, and a compaction
policy. A line-level diff implementation would also have had to be written and
property-tested, since the no-dependency constraint rules out a library, and the
correctness of the entire history would rest on it.

The hybrid inherits the diff engine's complexity and adds a second layer to
maintain, for a saving that only matters at a scale this application does not reach.

## Consequences

**Accepted:** History consumes more storage than a diff log would, and the pruning
policy is load-bearing rather than optional — without it, history grows unbounded.
Pruning deletes user data on a timer, so it must be restartable and must never
remove a note's newest version.

**Gained:** Restore is a single read. There is no diff module, no integrity chain,
and no replay path to test. The failure modes that remain are storage failures,
which the app must handle anyway.

**Reversible:** The decision lives entirely behind the `store.js` contract, which
exposes no storage mechanism to its callers. Switching to diffs later would change
one module and no UI code.

## Notes on how this decision was reached

Snapshots were recommended first, then reversed to the diff log mid-design, then
reversed back to snapshots. The reversal was cheap precisely because the `store.js`
boundary had been drawn to hide the choice, which is itself evidence that the
boundary is in the right place.

The intermediate design is worth recording rather than erasing: with diffs, the
mitigations that made the approach defensible — a hash on every operation so replay
fails loudly instead of silently, and re-baselining to bound chain length — were
substantial enough that they, more than the disk saving, decided the question.
