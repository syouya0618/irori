#!/usr/bin/env python3
"""
Detect `.single()` / `.maybeSingle()` destructures that don't receive `error`.

Supabase の error は class Error を継承しない plain object で、`.single()` の失敗は
`data: null` で隠匿される。`{ data }` のみで destructure すると silent fail を作る
ため、`{ data, error }` で受け取り早期 log/throw すること
(learnings.md L55, inventory-hub で 3 日間真因隠匿の事例あり)。

Usage:
  scripts/check-supabase-error-destructure.py            # report-only, exit 0
  scripts/check-supabase-error-destructure.py --strict   # exit 1 on violations

Verify axes (learnings.md L243, 2026-05-16):
  1. True positive:   `const { data } = await ...single()`           → reported
  2. False positive:  `const { data, error } = await ...single()`    → NOT reported
  3. Edge case:       multi-line `const {\n  data,\n  error,\n} = ...` → NOT reported
  4. Known limitation: Promise.all で複数 .single() が並ぶケースは行ベース近似のため
     false positive が出うる。report-only で運用し、移行完了後に対象を絞ってから
     --strict に切り替える前提。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SINGLE_RE = re.compile(r"\.(maybeSingle|single)\(\)")
DESTRUCTURE_START_RE = re.compile(r"(?:const|let|var)\s+[\[{]")
ERROR_TOKEN_RE = re.compile(r"\berror\b")
DATA_TOKEN_RE = re.compile(r"\bdata\b")
SCAN_LIMIT = 30


def check_file(path: Path) -> list[tuple[int, str]]:
    """Return list of (line_number_1based, line_content) violations."""
    lines = path.read_text().splitlines()
    violations: list[tuple[int, str]] = []

    for idx, line in enumerate(lines):
        if not SINGLE_RE.search(line):
            continue

        # Walk upward to find the nearest destructure declaration line.
        block_start = -1
        for j in range(idx, max(-1, idx - SCAN_LIMIT), -1):
            if DESTRUCTURE_START_RE.search(lines[j]):
                block_start = j
                break
        if block_start < 0:
            continue

        # The destructure ends at the line containing `=` after block_start.
        eq_line = -1
        for j in range(block_start, min(len(lines), idx + 1)):
            stripped = lines[j]
            # Skip lines with `==` or `!=` only (no assignment).
            eq_idx = stripped.find("=")
            while eq_idx >= 0:
                nxt = stripped[eq_idx + 1 : eq_idx + 2]
                prv = stripped[eq_idx - 1 : eq_idx] if eq_idx > 0 else ""
                if nxt != "=" and prv not in {"=", "!", "<", ">"}:
                    eq_line = j
                    break
                eq_idx = stripped.find("=", eq_idx + 1)
            if eq_line >= 0:
                break
        if eq_line < 0:
            continue

        # Inspect text from block_start through the `=` on eq_line (LHS only).
        if eq_line == block_start:
            eq_pos = lines[eq_line].find("=")
            snippet = lines[eq_line][:eq_pos]
        else:
            snippet = "\n".join(lines[block_start:eq_line])
            eq_pos = lines[eq_line].find("=")
            snippet += "\n" + lines[eq_line][:eq_pos]

        if not DATA_TOKEN_RE.search(snippet):
            # Not a Supabase result destructure (likely await without LHS data binding).
            continue
        if ERROR_TOKEN_RE.search(snippet):
            continue

        violations.append((idx + 1, line.strip()))

    return violations


def main() -> int:
    strict = "--strict" in sys.argv

    if not SRC.exists():
        print(f"src/ not found at {SRC}", file=sys.stderr)
        return 2

    all_violations: list[tuple[Path, int, str]] = []
    for path in sorted(SRC.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix not in {".ts", ".tsx"}:
            continue
        if "__tests__" in path.parts or path.stem.endswith(".test"):
            continue
        for lineno, content in check_file(path):
            all_violations.append((path, lineno, content))

    if not all_violations:
        print("OK: no .single()/.maybeSingle() destructures missing `error`.")
        return 0

    print(
        f"Found {len(all_violations)} .single()/.maybeSingle() destructure(s) "
        "without `error` receiver:"
    )
    for path, lineno, content in all_violations:
        rel = path.relative_to(ROOT)
        print(f"  {rel}:{lineno}  {content}")

    print()
    print(
        "Supabase の error は class Error を継承しない plain object じゃ。"
        "`{ data, error }` で受け取り構造化ログ (learnings.md L55) を出すこと。"
    )

    return 1 if strict else 0


if __name__ == "__main__":
    sys.exit(main())
