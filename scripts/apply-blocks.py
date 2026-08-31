#!/usr/bin/env python3
# Applies agent-emitted ===FILE:/===EDIT: blocks. All-or-nothing: every hunk
# must match verbatim and uniquely before anything is written to disk.
import re, sys, pathlib
raw = pathlib.Path(sys.argv[1]).read_text()
writes, errors = {}, []
blocks = re.split(r"^===(FILE|EDIT): (.+?)===\s*$", raw, flags=re.M)
# blocks: [preamble, kind, path, body, kind, path, body, ...]
for i in range(1, len(blocks) - 2, 3):
    kind, path, body = blocks[i], blocks[i+1].strip(), blocks[i+2]
    body = re.sub(r"^\n", "", re.split(r"^===END===\s*$", body, flags=re.M)[0])
    if kind == "FILE":
        writes[path] = body
        continue
    text = writes.get(path)
    if text is None:
        try: text = pathlib.Path(path).read_text()
        except FileNotFoundError: errors.append(f"{path}: EDIT target missing"); continue
    hunks = re.split(r"^<<<<<<<+ ?SEARCH\s*$", body, flags=re.M)[1:]
    if not hunks: errors.append(f"{path}: EDIT block with no hunks"); continue
    for n, hunk in enumerate(hunks, 1):
        parts = re.split(r"^=======\s*$", hunk, flags=re.M)
        if len(parts) != 2: errors.append(f"{path} hunk {n}: bad ======= split"); continue
        search = parts[0]
        replace = re.split(r"^>>>>>>>+ ?REPLACE\s*$", parts[1], flags=re.M)[0]
        # bodies arrive newline-wrapped by the block format
        search = search[1:] if search.startswith("\n") else search
        if search.endswith("\n") and not search.endswith("\n\n"): pass
        count = text.count(search)
        if count == 0:
            stripped = search.strip("\n"); count = text.count(stripped)
            if count == 1: search, replace = stripped, replace.strip("\n")
        if count == 0: errors.append(f"{path} hunk {n}: SEARCH not found ({search[:80]!r}...)"); continue
        if count > 1: errors.append(f"{path} hunk {n}: SEARCH not unique ({count}x)"); continue
        text = text.replace(search, replace, 1)
    writes[path] = text
if errors:
    print("APPLY FAILED — nothing written:"); [print(" -", e) for e in errors]; sys.exit(1)
for path, text in writes.items():
    p = pathlib.Path(path); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text)
    print(f"wrote {path} ({len(text)} bytes)")
