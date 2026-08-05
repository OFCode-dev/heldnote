# Quick Keep Notepad

A browser notepad whose defining promise is that nothing you type is ever lost.

Multiple notes, saved continuously to IndexedDB, with a version history you can
step back through. No account, no server, no build step — open the page and write.

Part of the OFCode "Quick" family, alongside
[Quick Web Notepad](https://github.com/OFCode-dev/quick-web-notepad) (its
single-pad predecessor) and the Quick screenshot-to-clipboard extensions.

## Status

In design. The architecture is settled and written down; implementation has not
started yet.

- Canonical design spec: `docs/superpowers/specs/2026-08-05-quick-keep-notepad-design.md`
- Planning artifacts: `.claude/artifacts/`

## Planned for v1

- Multiple notes with search, pinning, and a trash you can undo from
- Two-layer persistence: a per-keystroke draft you cannot lose, plus committed
  snapshots you can return to
- Version history per note, with timestamped restore
- Find and replace, syntax highlighting with line numbers, dark theme, zoom
- Turkish and English UI, following the browser's language
- JSON export and import as a full backup

## Not in v1

Google Drive sync, writing straight to disk, tags and folders, markdown preview,
sharing, and encryption. Sync is the intended v2; the data model already carries
the fields it will need.

## License

MIT
