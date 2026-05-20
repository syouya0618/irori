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

Verify axes:
  1. True positive:   `const { data } = await ...single()`            → reported
  2. False positive:  `const { data, error } = await ...single()`     → NOT reported
  3. Multi-line edge case: `const {\n  data,\n  error,\n} = ...`      → NOT reported
  4. Promise.all per-element:
       `const [{ data: a, error: aE }, { data: b }] = Promise.all([..single(), ..single()])`
       のように一部要素のみ error 欠落の場合、当該要素に対応する `.single()` 行のみ
       violation として検出 (LHS 全体に error トークンが在っても false negative を
       作らない)。
  5. Fat-arrow guard: `=>` の `=` を assignment と誤検出しない。
  6. Robustness: 非 UTF-8 / 読み取り不可ファイルは warning を stderr に出して skip し、
     script 全体をクラッシュさせない (report-only 前提を壊さない)。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SINGLE_RE = re.compile(r"\.(maybeSingle|single)\(\)")
DESTRUCTURE_START_RE = re.compile(r"(?:const|let|var)\s+[\[{]")
ARRAY_DESTRUCT_RE = re.compile(r"(?:const|let|var)\s*\[")
ERROR_TOKEN_RE = re.compile(r"\berror\b")
DATA_TOKEN_RE = re.compile(r"\bdata\b")
PROMISE_ALL_RE = re.compile(r"Promise\.all\s*\(\s*\[")
SCAN_LIMIT = 30


def _parse_array_lhs_elements(lhs: str) -> list[str] | None:
    """`const [{ data: a, error: aE }, { data: b }]` LHS を要素文字列リストに分割する。"""
    m = ARRAY_DESTRUCT_RE.search(lhs)
    if not m:
        return None
    start = m.end()  # position immediately after `[`
    elements: list[str] = []
    depth = 0
    cur = start
    i = start
    while i < len(lhs):
        c = lhs[i]
        if c in "[{(":
            depth += 1
        elif c in "]})":
            if c == "]" and depth == 0:
                elements.append(lhs[cur:i])
                return elements
            depth -= 1
        elif c == "," and depth == 0:
            elements.append(lhs[cur:i])
            cur = i + 1
        i += 1
    return None  # 構文崩壊などで `]` に達せず終了


def _find_position_in_promise_all(
    rhs_text: str, single_offset_in_rhs: int
) -> int | None:
    """
    Promise.all([...]) 内で、当該 .single() の rhs_text 内 offset が
    何番目の要素 (0-indexed) に属するか返す。
    `Promise.all` が見つからない、または対応する `[` の外に offset があれば None。
    """
    pa_match = PROMISE_ALL_RE.search(rhs_text)
    if not pa_match:
        return None
    pa_open = pa_match.end()  # `[` の直後
    if single_offset_in_rhs < pa_open:
        return None
    depth = 0
    position = 0
    for i in range(pa_open, single_offset_in_rhs):
        c = rhs_text[i]
        if c in "[{(":
            depth += 1
        elif c in "]})":
            if depth == 0:
                # `Promise.all([` の対応 `]` を抜けて先にある (= 別の式)
                return None
            depth -= 1
        elif c == "," and depth == 0:
            position += 1
    return position


def check_file(path: Path) -> list[tuple[int, str]]:
    """Return list of (line_number_1based, line_content) violations."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        # script 全体クラッシュ防止: 1 ファイル読み取り失敗は stderr に出して skip。
        print(
            f"warning: skipped {path} ({type(e).__name__}: {e})", file=sys.stderr
        )
        return []
    lines = text.splitlines()
    violations: list[tuple[int, str]] = []

    for idx, line in enumerate(lines):
        single_match = SINGLE_RE.search(line)
        if not single_match:
            continue

        # 上方向に最も近い destructure 宣言行を探す。
        # `range(idx, idx - SCAN_LIMIT - 1, -1)` で idx - SCAN_LIMIT 行も含めて走査する
        # (`max(-1, ...)` は idx < SCAN_LIMIT のとき index 0 まで届くようにするため)。
        block_start = -1
        floor = max(-1, idx - SCAN_LIMIT - 1)
        for j in range(idx, floor, -1):
            if DESTRUCTURE_START_RE.search(lines[j]):
                block_start = j
                break
        if block_start < 0:
            continue

        # 代入の `=` を見つける。`==`/`!=`/`<=`/`>=`/`=>` は skip。
        eq_line = -1
        eq_pos = -1
        for j in range(block_start, min(len(lines), idx + 1)):
            stripped = lines[j]
            cur = stripped.find("=")
            while cur >= 0:
                nxt = stripped[cur + 1 : cur + 2]
                prv = stripped[cur - 1 : cur] if cur > 0 else ""
                if nxt not in {"=", ">"} and prv not in {"=", "!", "<", ">"}:
                    eq_line = j
                    eq_pos = cur
                    break
                cur = stripped.find("=", cur + 1)
            if eq_line >= 0:
                break
        if eq_line < 0:
            continue

        # LHS テキスト (宣言開始から `=` の直前まで)。
        if eq_line == block_start:
            lhs = lines[eq_line][:eq_pos]
        else:
            lhs = (
                "\n".join(lines[block_start:eq_line])
                + "\n"
                + lines[eq_line][:eq_pos]
            )

        if not DATA_TOKEN_RE.search(lhs):
            # `data` を bind しない destructure (Supabase 結果ではない可能性が高い)。
            continue

        # `error` を検査する範囲を決める:
        #   - default: LHS 全体
        #   - Promise.all + array destructure: 当該 .single() の Promise.all 内 position に
        #     対応する LHS array element だけ (per-element 検査で false negative を防ぐ)
        check_target = lhs
        if ARRAY_DESTRUCT_RE.search(lhs):
            rhs_parts = [lines[eq_line][eq_pos + 1 :]]
            for j in range(eq_line + 1, idx + 1):
                rhs_parts.append(lines[j])
            rhs_text = "\n".join(rhs_parts)

            # rhs_text 内での .single() の offset を計算する。
            line_offsets: dict[int, int] = {eq_line: 0}
            offset = len(rhs_parts[0])
            for j in range(eq_line + 1, idx + 1):
                offset += 1  # `\n`
                line_offsets[j] = offset
                offset += len(lines[j])
            single_offset = line_offsets[idx] + single_match.start()

            position = _find_position_in_promise_all(rhs_text, single_offset)
            if position is not None:
                elements = _parse_array_lhs_elements(lhs)
                if elements is not None and 0 <= position < len(elements):
                    check_target = elements[position]

        if ERROR_TOKEN_RE.search(check_target):
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
