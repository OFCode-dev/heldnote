# Open Questions

## Open

- [ ] [Affects: product-requirements.md] What are the exact pruning thresholds and the per-note version cap? The ladder is agreed in shape (every version for the last hour, hourly for the last day, daily beyond that) but the numbers and the cap are not fixed. (Answer: TBD)
- [ ] [Affects: product-requirements.md] How long does a deleted note stay in the trash before it is purged for real? Working assumption is 30 days. (Answer: TBD)
- [ ] [Affects: product-requirements.md] Is there an upper bound on note size, and what happens past it? Snapshot versioning makes a very large note expensive to keep history for. (Answer: TBD)
- [ ] [Affects: product-requirements.md] Does the version history panel need a text search across versions, or is a timestamp list enough for v1? (Answer: TBD)
- [ ] [Affects: 2026-08-05-quick-keep-notepad-design.md] Syntax highlighting renders user text into HTML, which is a real XSS surface. The old project had an `esc()` helper; confirm the escaping approach before that module is written. (Answer: TBD)
- [ ] [Affects: product-requirements.md] What are the maximum note size and the per-note and global history byte budgets? They must come from measurement, and they replace the earlier record-count bound. (Answer: TBD)
- [ ] [Affects: product-requirements.md] Which origin does this ship on? IndexedDB is scoped by origin, so a shared `owner.github.io` host lets every other repository of that account read and delete this database, and any later origin change orphans existing notes. Must be fixed before the first real note is written. (Answer: TBD)
- [ ] [Affects: 2026-08-05-quick-keep-notepad-design.md] Can the 300 ms window be met with `durability: "strict"` on every draft write, or does the battery and I/O cost force relaxed durability on the hot path and strict only on version commits? Needs measurement. (Answer: TBD)
- [ ] [Affects: product-requirements.md] What do the three Safari modes — ordinary tab, installed web app, Private Browsing — actually do on a real device? Not blocking any more, since the product now declares ordinary Safari non-durable rather than depending on an exemption, but it must be measured before release. (Answer: TBD)

## Resolved

- [x] [Affects: product-requirements.md] Should syntax highlighting ship in v1? (Answer: No, deferred to v1.1 — the most expensive carried-over feature and the app's only markup-injection surface.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] Keep `rev` in v1, or drop it? (Answer: Kept, but renamed `localRev` and given a real job — it now orders draft and version reconciliation, so it is read rather than merely written.) (Date: 2026-08-06)
- [x] [Affects: product-requirements.md] Should accessibility be Should or Must? (Answer: Must. The product is a text editor.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] How long does a deleted note stay in the trash? (Answer: Indefinitely. Automatic purge was removed — a timed background deletion of the only copy is the wrong default here, and a forward clock jump could fire it early.) (Date: 2026-08-06)
- [x] [Affects: product-requirements.md] How does merge-on-import resolve conflicts? (Answer: It does not; merge is cut from v1. With versions keyed `[noteId, seq]`, divergent branches collide and one text would have to be discarded. Replace and import-as-copies instead.) (Date: 2026-08-06)

- [x] [Affects: product-requirements.md] Should version history store diffs or full snapshots? (Answer: Full snapshots. Diffs were chosen mid-design and then reverted, because restoring should be a read rather than a replay that can drift.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] Does v1 include Google Drive sync? (Answer: No. v1 is local-only; the data model carries the fields sync will need, and sync is v2.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] What happens when a user restores an old version? (Answer: The restore is itself committed as a new version, so nothing is destroyed and the restore can be undone.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] Which editor features carry over from `quick-web-notepad`? (Answer: Find and replace, dark theme, zoom, Turkish/English UI, syntax highlighting with line numbers. Protect mode is deferred.) (Date: 2026-08-05)
