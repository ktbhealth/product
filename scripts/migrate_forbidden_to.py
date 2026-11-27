#!/usr/bin/env python3
"""Codemod: `Effect.catchTag("Forbidden", () => Effect.succeed(EXPR))`
→ `forbiddenTo(EXPR)` in plugins/*/src/fns.ts, and add `forbiddenTo` to the
@ktb/server-fns import when used.

Only the exact two-argument shape is rewritten; catchTags/multi-tag
handlers and non-succeed recoveries are left alone. Dry-run by default;
pass --apply to write.
"""

import re
import sys
from pathlib import Path

APPLY = "--apply" in sys.argv
FILES = [a for a in sys.argv[1:] if not a.startswith("--")]


def find_matching(text, start, open_ch, close_ch):
    depth = 0
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c in "'\"":
            q = c
            i += 1
            while i < n and text[i] != q:
                if text[i] == "\\":
                    i += 1
                i += 1
        elif c == "`":
            i += 1
            while i < n and text[i] != "`":
                if text[i] == "\\":
                    i += 1
                elif text[i] == "$" and i + 1 < n and text[i + 1] == "{":
                    close = find_matching(text, i + 1, "{", "}")
                    if close == -1:
                        return -1
                    i = close
                i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j == -1 else j
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def skip_ws(text, i):
    while i < len(text) and text[i].isspace():
        i += 1
    return i


CATCH_RE = re.compile(r'Effect\.catchTag\(\s*"Forbidden"\s*,')


def transform(text):
    """Replace exact-shape catchTag calls; returns (new_text, count)."""
    out = []
    pos = 0  # search position
    last = 0  # everything before `last` has been emitted to `out`
    count = 0
    while True:
        m = CATCH_RE.search(text, pos)
        if not m:
            break
        # m.end() is just after the comma following "Forbidden"
        j = skip_ws(text, m.end())
        # expect: () => Effect.succeed( EXPR )
        if not text.startswith("()", j):
            pos = m.end()
            continue
        j = skip_ws(text, j + 2)
        if not text.startswith("=>", j):
            pos = m.end()
            continue
        j = skip_ws(text, j + 2)
        sm = re.match(r"Effect\.succeed\(", text[j:])
        if not sm:
            pos = m.end()
            continue
        expr_open = j + sm.end() - 1
        expr_close = find_matching(text, expr_open, "(", ")")
        if expr_close == -1:
            pos = m.end()
            continue
        expr = text[expr_open + 1 : expr_close]
        # after Effect.succeed(...) allow an optional trailing comma, then
        # expect ')' closing catchTag
        k = skip_ws(text, expr_close + 1)
        if k < len(text) and text[k] == ",":
            k = skip_ws(text, k + 1)
        if k >= len(text) or text[k] != ")":
            pos = m.end()
            continue
        # ensure nothing else inside catchTag args (3rd arg etc.): the ')' we
        # found must close catchTag — i.e. catchTag( "Forbidden", fn ) shape.
        # Verify by finding catchTag's own open paren and matching it.
        open_paren = text.rfind("(", 0, m.start() + len("Effect.catchTag"))
        # simpler: the ')' at k should match the '(' right after catchTag
        # find_matching from that '('
        call_open = text.index("(", m.start())
        call_close = find_matching(text, call_open, "(", ")")
        if call_close != k:
            pos = m.end()
            continue
        out.append(text[last:m.start()])
        out.append(f"forbiddenTo({expr})")
        pos = k + 1
        last = k + 1
        count += 1
    out.append(text[last:])
    return "".join(out), count


def add_import(text):
    if "forbiddenTo" not in re.sub(r"import[^;]*;", "", text, flags=re.S):
        return text
    m = re.search(r"import\s*\{([^}]*)\}\s*from\s*[\"']@ktb/server-fns[\"'];?", text, re.S)
    if not m:
        return text
    names = [x.strip() for x in m.group(1).split(",") if x.strip()]
    if "forbiddenTo" in names:
        return text
    names.append("forbiddenTo")
    names = sorted(set(names))
    new_block = "import { " + ", ".join(names) + ' } from "@ktb/server-fns";'
    return text[:m.start()] + new_block + text[m.end():]


def main():
    files = FILES or sorted(str(p) for p in Path(".").glob("plugins/*/src/fns.ts"))
    total = 0
    for f in files:
        path = Path(f)
        src = path.read_text()
        new, n = transform(src)
        if n == 0:
            continue
        new = add_import(new)
        total += n
        if APPLY:
            path.write_text(new)
        print(f"{f}: {n} catchTag -> forbiddenTo{' (applied)' if APPLY else ' (dry)'}")
    print(f"total: {total}")


if __name__ == "__main__":
    main()
