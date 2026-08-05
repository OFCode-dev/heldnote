# Open Questions

## Open

- [ ] [Affects: product-requirements.md] What are the exact pruning thresholds and the per-note version cap? The ladder is agreed in shape (every version for the last hour, hourly for the last day, daily beyond that) but the numbers and the cap are not fixed. (Answer: TBD)
- [ ] [Affects: product-requirements.md] How long does a deleted note stay in the trash before it is purged for real? Working assumption is 30 days. (Answer: TBD)
- [ ] [Affects: product-requirements.md] Is there an upper bound on note size, and what happens past it? Snapshot versioning makes a very large note expensive to keep history for. (Answer: TBD)
- [ ] [Affects: product-requirements.md] Does the version history panel need a text search across versions, or is a timestamp list enough for v1? (Answer: TBD)
- [ ] [Affects: 2026-08-05-quick-keep-notepad-design.md] Syntax highlighting renders user text into HTML, which is a real XSS surface. The old project had an `esc()` helper; confirm the escaping approach before that module is written. (Answer: TBD)
- [ ] [Blocking] [Affects: product-requirements.md] Does Safari actually grant persistent storage for this origin? Without it, Safari evicts IndexedDB after roughly seven days of no visits, which would make the product's central promise false on a browser listed as Must-support. (Answer: TBD)
- [ ] [Affects: product-requirements.md] Should syntax highlighting ship in v1, or move to v1.1? It is the most expensive carried-over feature and the app's only markup-injection surface. (Answer: TBD)
- [ ] [Affects: product-requirements.md] Should the pruning ladder collapse from four tiers to two (newest N, then one per day)? (Answer: TBD)
- [ ] [Affects: product-requirements.md] Keep `rev` in v1 with tested invariants, or drop it and backfill at v2? (Answer: TBD)
- [ ] [Affects: product-requirements.md] Should accessibility move from Should to Must, given that the product is a text editor? (Answer: TBD)

## Resolved

- [x] [Affects: product-requirements.md] Should version history store diffs or full snapshots? (Answer: Full snapshots. Diffs were chosen mid-design and then reverted, because restoring should be a read rather than a replay that can drift.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] Does v1 include Google Drive sync? (Answer: No. v1 is local-only; the data model carries the fields sync will need, and sync is v2.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] What happens when a user restores an old version? (Answer: The restore is itself committed as a new version, so nothing is destroyed and the restore can be undone.) (Date: 2026-08-05)
- [x] [Affects: product-requirements.md] Which editor features carry over from `quick-web-notepad`? (Answer: Find and replace, dark theme, zoom, Turkish/English UI, syntax highlighting with line numbers. Protect mode is deferred.) (Date: 2026-08-05)
