# Decision Log

| Date | Decision | Why | Tradeoff |
| --- | --- | --- | --- |
| 2026-08-05 | Start a new project rather than version 3 of `quick-web-notepad` | Multi-note storage and version history change the data model and the UI shape enough that they are a different product, not a bigger notepad | The old project's single-file convenience is lost; two repos to maintain |
| 2026-08-05 | Persist to IndexedDB, no backend | Works on GitHub Pages with no server cost, and holds far more than localStorage without blocking the main thread | Data lives in one browser profile until sync ships |
| 2026-08-05 | Two persistence layers: per-keystroke draft plus committed snapshots | Never-lose and go-back are different guarantees; separating them keeps the never-lose path free of any computation that could fail | One more store, and a note's newest text lives in two places at once |
| 2026-08-05 | Store versions as full snapshots, not diffs | Restoring is a read rather than a computation, so history cannot silently drift; briefly reversed to diffs mid-design, then reverted | Uses more disk than a diff log; requires a pruning ladder to stay bounded |
| 2026-08-05 | Fresh codebase of small ES modules, no build step | The old single file had grown to 1628 lines with unrelated pasted CSS; multi-note plus history needs real boundaries | Editor features must be ported over deliberately rather than inherited |
| 2026-08-05 | Ship v1 without sync, but write sync-shaped fields now | Gets a working app soonest while keeping `id`, `updatedAt`, `deletedAt`, `rev` available for Drive sync in v2 | Carries fields nothing reads yet |
| 2026-08-05 | Keep two documentation homes | User chose both the artifacts tree and the superpowers spec | Same content in two places; the spec is canonical and the artifacts must follow it |
