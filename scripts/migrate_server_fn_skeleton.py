#!/usr/bin/env python3
"""Codemod: collapse the repeated server-fn auth preamble in plugins/*/src/fns.ts.

Transforms, inside `.handler(...)` async arrow bodies:

  [await requirePluginEnabled("ID");]
  const user = await ensureSessionUser();
  ...body using runAs(user, eff)...

into

  .handler([pluginHandler("ID", )]sessionHandler(async ({ data, user, run }) =>
    run(eff)...))

Variants handled:
  - ensureDoctorUser  -> doctorHandler
  - getSessionUser + `if (!user) return EXPR;`   -> optionalSessionHandler(({data...}) => EXPR, fn)
  - getDoctorUser  + same                            -> optionalDoctorHandler
  - plugin gate first                                -> pluginHandler("ID", <inner>)

Safety: a handler is only rewritten when EVERY `runAs(` call in its body
has `user` as first arg, the body has no bare `run(` token (would collide
with the injected `run`), and no `tenantSelector` (3-arg runAs sites are
left as variants). Mode "user-only" (no run injection) is used when the
body references the system `run(` — the ensure line is still removed and
`runAs(user, ...)` calls stay untouched.

Usage: migrate_server_fn_skeleton.py [--dry-run] [files...]
Default is dry-run: prints planned edits, writes nothing.
"""

import re
import sys
from pathlib import Path

APPLY = "--apply" in sys.argv
FILES = [a for a in sys.argv[1:] if not a.startswith("--")]


def find_matching(text, start, open_ch, close_ch):
    """Index of the close_ch matching text[start]==open_ch, string/comment aware."""
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


def skip_trivia(text, i):
    """Skip whitespace and // line comments."""
    n = len(text)
    while i < n:
        if text[i].isspace():
            i += 1
        elif text[i] == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            i = n if j == -1 else j + 1
        else:
            break
    return i


PREAMBLE_RES = [
    # plugin gate (optional, handled separately)
    ("plugin", re.compile(r'await\s+requirePluginEnabled\(\s*"([^"]+)"\s*\)\s*;')),
    ("ensure", re.compile(r"const\s+user\s*=\s*await\s+(ensureSessionUser|ensureDoctorUser)\(\s*\)\s*;")),
    ("optional", re.compile(r"const\s+user\s*=\s*await\s+(getSessionUser|getDoctorUser)\(\s*\)\s*;")),
]

IF_RE = re.compile(r"if\s*\(\s*(?:!\s*user|user\s*={2,3}\s*null)\s*\)")


def parse_if_return(text, i):
    """At position i (after trivia), parse `if (cond) return EXPR;` or
    `if (cond) { return EXPR; }`. Returns (expr_text, end_index) or None."""
    m = IF_RE.match(text, i)
    if not m:
        return None
    j = skip_trivia(text, m.end())
    if j >= len(text):
        return None
    if text[j] == "{":
        close = find_matching(text, j, "{", "}")
        if close == -1:
            return None
        inner = text[j + 1 : close]
        inner_stripped = inner.strip()
        mm = re.fullmatch(r"return\s+(.+);", inner_stripped, re.S)
        if not mm:
            return None
        return mm.group(1), close + 1
    # single statement: capture until ';' at depth 0
    depth = 0
    k = j
    while k < len(text):
        c = text[k]
        if c in "'\"`":
            q = c
            k += 1
            while k < len(text) and text[k] != q:
                if text[k] == "\\":
                    k += 1
                k += 1
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            if depth == 0:
                return None
            depth -= 1
        elif c == ";" and depth == 0:
            expr = text[j:k].strip()
            if not expr.startswith("return"):
                return None
            expr = expr[len("return"):].strip()
            # trailing comment on the line is fine to keep inside expr? drop it
            return expr, k + 1
        elif c == "\n" and depth == 0:
            # `return EXPR` may span lines; only stop at ';'
            pass
        k += 1
    return None


def transform_handler(src, hstart, hend):
    """src[hstart:hend] is `.handler( <arg> )` incl. parens region we located.
    Actually hstart points at '.handler(' — find arg start after '('."""
    # locate '(' of .handler(
    p = src.index("(", hstart)
    arg_start = skip_trivia(src, p + 1)
    # expect: async ( params ) (: ret)? => { body }
    m = re.match(r"async\s*\(", src[arg_start:])
    if not m:
        return None
    params_open = arg_start + m.end() - 1  # index of '('
    params_close = find_matching(src, params_open, "(", ")")
    if params_close == -1:
        return None
    params = src[params_open + 1 : params_close]
    k = skip_trivia(src, params_close + 1)
    # optional return type annotation
    ret = ""
    if src[k:k+1] == ":":
        # capture until '=>'
        arrow = src.find("=>", k)
        # return type may contain '=>' inside generics? unlikely; find '=>' first
        ret = src[k:arrow].rstrip()
        k = arrow
    if not src.startswith("=>", k):
        return None
    body_open = skip_trivia(src, k + 2)
    if src[body_open:body_open+1] != "{":
        return None  # expression body — skip
    body_close = find_matching(src, body_open, "{", "}")
    if body_close == -1:
        return None
    body = src[body_open + 1 : body_close]

    # ---- parse preamble ----
    i = skip_trivia(body, 0)
    plugin_id = None
    kind = None
    anon_expr = None
    consumed = 0

    # optional plugin gate — may repeat? only one expected
    while True:
        mm = PREAMBLE_RES[0][1].match(body, i)
        if mm:
            plugin_id = mm.group(1)
            i = skip_trivia(body, mm.end())
            consumed = mm.end()
            continue
        break

    m2 = PREAMBLE_RES[1][1].match(body, i)
    if m2:
        kind = "session" if m2.group(1) == "ensureSessionUser" else "doctor"
        rest = body[m2.end():]
    else:
        m3 = PREAMBLE_RES[2][1].match(body, i)
        if not m3:
            return None
        getter = m3.group(1)
        parsed = parse_if_return(body, skip_trivia(body, m3.end()))
        if parsed is None:
            return None
        anon_expr, rest_start = parsed
        kind = "optional-session" if getter == "getSessionUser" else "optional-doctor"
        rest = body[rest_start:]

    # ---- safety checks on rest ----
    runas_calls = list(re.finditer(r"\brunAs\s*\(", rest))
    for rm in runas_calls:
        after = rest[rm.end():]
        if not re.match(r"\s*user\s*,", after):
            return None
    has_bare_run = re.search(r"\brun\s*\(", rest) is not None
    has_tenant = "tenantSelector" in rest or "getTenantSelector" in rest

    inject_run = not has_bare_run and not has_tenant and len(runas_calls) > 0

    # build new rest
    new_rest = rest
    if inject_run:
        new_rest = re.sub(r"\brunAs\(\s*user\s*,", "run(", new_rest)
        need_run = True
    else:
        need_run = False
    # `user` is only needed if the post-transform body still references the
    # variable — exclude `.user` member access (a following `:` is kept:
    # `cond ? user : other` is a real use; a stray `user:` key at worst
    # injects an unused param that lint surfaces).
    need_user = re.search(r"(?<![.\w$])user\b", new_rest) is not None

    # names to inject into params destructure
    inject = []
    if need_user:
        inject.append("user")
    if need_run:
        inject.append("run")

    # params rewrite
    p = params.strip()
    if p == "":
        new_params = "{ " + ", ".join(inject) + " }" if inject else ""
        # '()' stays '()' if nothing injected — but then wrapper adds nothing; still fine
        new_params = "(" + new_params + ")"
    elif p.startswith("{") and p.endswith("}"):
        inner = p[1:-1].strip().rstrip(",").strip()
        additions = [x for x in inject]
        if inner == "":
            new_inner = ", ".join(additions)
        else:
            new_inner = inner + (", " if inner and additions else "") + ", ".join(additions)
        new_params = "({ " + new_inner + " })"
    else:
        return None  # non-destructured params — skip

    # indentation: keep body as-is (rest already includes leading newline/indent)
    # wrappers
    inner_fn = f"async {new_params}{ret} => {{{new_rest}}}"
    # note: original had `async (params): Ret => {`; rebuild compactly
    if kind == "session":
        wrapped = f"sessionHandler({inner_fn})"
    elif kind == "doctor":
        wrapped = f"doctorHandler({inner_fn})"
    elif kind == "optional-session":
        # onAnonymous gets the same destructured params
        p2 = params.strip()
        if p2.startswith("{") and p2.endswith("}"):
            anon_params = "(" + p2 + ")"
        elif p2 == "":
            anon_params = "()"
        else:
            return None
        # parens keep object literals (`return {…};`) valid in expression position
        wrapped = f"optionalSessionHandler({anon_params} => ({anon_expr}), {inner_fn})"
    else:  # optional-doctor
        p2 = params.strip()
        if p2.startswith("{") and p2.endswith("}"):
            anon_params = "(" + p2 + ")"
        elif p2 == "":
            anon_params = "()"
        else:
            return None
        wrapped = f"optionalDoctorHandler({anon_params} => ({anon_expr}), {inner_fn})"
    if plugin_id is not None:
        wrapped = f'pluginHandler("{plugin_id}", {wrapped})'

    # splice: replace src[arg_start : body_close+1] with wrapped
    new_src = src[:arg_start] + wrapped + src[body_close + 1:]
    return new_src, arg_start, body_close + 1


def process_file(path: Path):
    src = path.read_text()
    out = src
    offset = 0
    edits = 0
    # iterate over .handler( occurrences in ORIGINAL src; rebuild incrementally
    result = src
    pos = 0
    while True:
        idx = result.find(".handler(", pos)
        if idx == -1:
            break
        # only transform top-level-ish handlers: the arg must start with 'async'
        t = transform_handler(result, idx, None)
        if t is None:
            pos = idx + len(".handler(")
            continue
        new_result, a0, a1 = t
        result = new_result
        edits += 1
        pos = a0 + 10  # continue after inserted wrapper start
    return result, edits


HELPER_NAMES = ["sessionHandler", "doctorHandler", "optionalSessionHandler",
                "optionalDoctorHandler", "pluginHandler", "forbiddenTo"]


def fix_imports(text):
    """Rebuild the @ktb/server-fns named import: keep entries still used in
    the file body, add the handler helpers now referenced."""
    import_spans = [m.span() for m in re.finditer(
        r"import\s+(?:type\s+)?\{[^}]*\}\s*from\s*[\"']@ktb/server-fns[\"'];?",
        text, re.S)]
    if not import_spans:
        return text
    body_text = text
    for s, e in reversed(import_spans):
        body_text = body_text[:s] + " " + body_text[e:]

    def still_used(name):
        return re.search(rf"\b{name}\b", body_text) is not None

    new_text = text
    for s, e in reversed(import_spans):
        block = text[s:e]
        m = re.search(r"\{(.*)\}", block, re.S)
        if not m:
            continue
        entries = [x.strip() for x in m.group(1).split(",") if x.strip()]
        kept = []
        for entry in entries:
            base = entry[5:].strip() if entry.startswith("type ") else entry
            if still_used(base):
                kept.append(entry)
        have = {k[5:].strip() if k.startswith("type ") else k for k in kept}
        for h in HELPER_NAMES:
            if h not in have and still_used(h):
                kept.append(h)
                have.add(h)
        kept = sorted(set(kept))
        new_block = re.sub(r"\{.*\}", "{ " + ", ".join(kept) + " }",
                           block, count=1, flags=re.S)
        new_text = new_text[:s] + new_block + new_text[e:]
    return new_text


def main():
    global FILES
    if not FILES:
        FILES = sorted(str(p) for p in Path(".").glob("plugins/*/src/fns.ts"))
    total_edits = 0
    for f in FILES:
        path = Path(f)
        src = path.read_text()
        new, edits = process_file(path)
        if edits == 0:
            continue
        new = fix_imports(new)
        total_edits += edits
        if APPLY:
            path.write_text(new)
            print(f"{f}: {edits} handler(s) migrated")
        else:
            print(f"{f}: {edits} handler(s) WOULD migrate")
    print(f"total: {total_edits}")


if __name__ == "__main__":
    main()
