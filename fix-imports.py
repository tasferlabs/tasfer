#!/usr/bin/env python3
"""Fix import-path breakage left by the in-flight editor refactor.

Root causes addressed:
  A. Editor-internal files import via the web app's `@/` alias (wrong package).
  B. `renderer.ts` was moved into `rendering/` but its own `./` imports + the
     `../renderer` referrers were not re-based.
  C. `inlineMath`/`mathjax` were merged into `math.ts`.
  D. A botched global rename produced `getVisibleTextFromRuns*FromRuns/FromChars`.
  E. Web app imports stale subpaths (`deserializer`, `types`, `state`, `mount`,
     `renderer`, `mathjax`, and a mashed `htmlSerializerloadPage`).
"""
import os
import re

EDITOR = "packages/editor/src"
WEB = "apps/web/src"

changed = {}

def walk(root, exts):
    for dirpath, _, names in os.walk(root):
        for n in names:
            if os.path.splitext(n)[1] in exts:
                yield os.path.join(dirpath, n)

def rewrite(path, fn):
    with open(path) as f:
        src = f.read()
    new = fn(src)
    if new != src:
        with open(path, "w") as f:
            f.write(new)
        changed[path] = changed.get(path, 0) + 1

# ---------------------------------------------------------------------------
# Editor package
# ---------------------------------------------------------------------------
for path in walk(EDITOR, {".ts", ".mjs"}):
    rel_dir = os.path.relpath(os.path.dirname(path), EDITOR)
    depth = 0 if rel_dir == "." else len(rel_dir.split(os.sep))
    prefix = "./" if depth == 0 else "../" * depth

    def fn(src, prefix=prefix, path=path):
        # A. `@/x` alias -> relative path to package src root
        src = re.sub(r'(["\'])@/', lambda m: m.group(1) + prefix, src)

        # B. `../renderer` referrers -> new rendering/ location
        src = src.replace('"../renderer"', '"../rendering/renderer"')

        # C. moved/renamed renderer.ts internal imports (only that file)
        if path.replace(os.sep, "/").endswith("rendering/renderer.ts"):
            src = src.replace('from "./', 'from "../')
            src = src.replace('import("./', 'import("../')
            src = src.replace('"../scrollbar"', '"./scrollbar"')   # stays same dir
            src = src.replace('"../inlineMath"', '"../math"')
            src = src.replace('"../mathjax"', '"../math"')

        # D. restore botched double-renamed helper names
        src = src.replace("getVisibleTextFromRunsFromRuns", "getVisibleTextFromRuns")
        src = src.replace("getVisibleTextFromRunsFromChars", "getVisibleTextFromChars")
        return src

    rewrite(path, fn)

# ---------------------------------------------------------------------------
# Web app — stale `@cypherkit/editor/*` subpaths
# ---------------------------------------------------------------------------
WEB_SUBS = [
    ("@cypherkit/editor/serlization/htmlSerializerloadPage", "@cypherkit/editor/serlization/loadPage"),
    ("@cypherkit/editor/deserializer/", "@cypherkit/editor/serlization/"),
    ('@cypherkit/editor/types"', '@cypherkit/editor/state-types"'),
    ("@cypherkit/editor/types'", "@cypherkit/editor/state-types'"),
    ('@cypherkit/editor/state"', '@cypherkit/editor/state-utils"'),
    ("@cypherkit/editor/state'", "@cypherkit/editor/state-utils'"),
    ('@cypherkit/editor/mount"', '@cypherkit/editor/entries/mount"'),
    ('@cypherkit/editor/renderer"', '@cypherkit/editor/rendering/renderer"'),
    ('@cypherkit/editor/mathjax"', '@cypherkit/editor/math"'),
]
for path in walk(WEB, {".ts", ".tsx"}):
    def fn(src):
        for a, b in WEB_SUBS:
            src = src.replace(a, b)
        return src
    rewrite(path, fn)

print(f"Modified {len(changed)} files:")
for p in sorted(changed):
    print(f"  {p}")
