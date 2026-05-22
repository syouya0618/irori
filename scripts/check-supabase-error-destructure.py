#!/usr/bin/env python3
"""
Detect Supabase query destructures that don't receive `error`.

Supabase の error は class Error を継承しない plain object で、クエリ失敗は
`data: null` (または空配列) で隠匿される。`{ data }` のみで destructure すると
silent fail を作るため、`{ data, error }` で受け取り早期 log/throw すること
(learnings.md L55, inventory-hub で 3 日間真因隠匿の事例あり)。

検出対象は 2 種類:
  A. single-row:  `.single()` / `.maybeSingle()` を含む destructure
  B. multi-row:   `.single()` を含まない supabase 読み取り/書き込みクエリ
                  (`supabase....select(...)` または `supabase....rpc(...)`)。
                  PR #31 で baby/meals/shopping page.tsx の instance を修正したが、
                  従来この検出器は B を見逃していた (Issue #14 推奨3)。

Usage:
  scripts/check-supabase-error-destructure.py            # src/ を report-only
  scripts/check-supabase-error-destructure.py --strict   # exit 1 on violations
  scripts/check-supabase-error-destructure.py PATH       # 任意パスをスキャン (test 用)
  scripts/check-supabase-error-destructure.py PATH --strict

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
  7. multi-row false positive 防止: RHS チェーンに `supabase` 識別子を含む destructure
     のみ検出 (`const { data } = await fetch(...)` 等を誤検出しない)。
  8. dedup (要素単位): `.single()` を含む要素は A の担当として B はスキップ。Promise.all
     内で `.single()` 要素と multi-row 要素が同居しても、後者を取りこぼさない。
  9. multi-row Promise.all per-element: 一部要素のみ error 欠落の場合、当該要素に
     対応する anchor 行のみ violation として検出する (LHS 全体に他要素の error
     トークンが在っても false negative を作らない)。

Limitation: line-based ヒューリスティックであり完全な AST 解析ではない。supabase
client を `supabase` 以外の名前 (例: `db`, `sb`) に alias した場合は検出できない。
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
# multi-row anchor: supabase 読み取り (`.select(`) / rpc (`.rpc(`)。
MULTIROW_ANCHOR_RE = re.compile(r"\.(select|rpc)\s*\(")
SUPABASE_TOKEN_RE = re.compile(r"\bsupabase\b")
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


def _split_promise_all_elements(rhs_text: str) -> list[str] | None:
    """
    `Promise.all([elemA, elemB, ...])` の interior を top-level カンマで分割し、
    各要素の RHS 文字列リストを返す。`Promise.all([` が無い / `]` に達しなければ None。
    dedup を要素単位で行うため (要素 RHS に `.single()` が在るかを個別判定する) に使う。
    """
    pa_match = PROMISE_ALL_RE.search(rhs_text)
    if not pa_match:
        return None
    start = pa_match.end()  # `[` の直後
    elements: list[str] = []
    depth = 0
    cur = start
    i = start
    while i < len(rhs_text):
        c = rhs_text[i]
        if c in "[{(":
            depth += 1
        elif c in "]})":
            if c == "]" and depth == 0:
                elements.append(rhs_text[cur:i])
                return elements
            depth -= 1
        elif c == "," and depth == 0:
            elements.append(rhs_text[cur:i])
            cur = i + 1
        i += 1
    return None  # 構文崩壊などで `]` に達せず終了


def _locate_destructure_block(
    lines: list[str], idx: int
) -> tuple[int, int, int] | None:
    """
    トリガー行 idx から上方向に走査し、対応する destructure 宣言と代入 `=` を探す。
    `(block_start, eq_line, eq_pos)` を返す。見つからなければ None。
    (`.single()` pass と multi-row pass で共有する up-scan ロジック。)
    """
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
        return None

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
        return None

    return block_start, eq_line, eq_pos


def _extract_lhs(lines: list[str], block_start: int, eq_line: int, eq_pos: int) -> str:
    """destructure 宣言開始から `=` 直前までの LHS テキストを返す。"""
    if eq_line == block_start:
        return lines[eq_line][:eq_pos]
    return "\n".join(lines[block_start:eq_line]) + "\n" + lines[eq_line][:eq_pos]


def _rhs_text(lines: list[str], eq_line: int, eq_pos: int, end_idx: int) -> str:
    """`=` の直後から end_idx 行までの RHS テキストを返す。"""
    parts = [lines[eq_line][eq_pos + 1 :]]
    for j in range(eq_line + 1, end_idx + 1):
        parts.append(lines[j])
    return "\n".join(parts)


def _find_statement_end(lines: list[str], eq_line: int, eq_pos: int) -> int:
    """
    `=` 直後から bracket depth を追い、destructure 代入 statement が閉じる行を返す。
    RHS が複数行 (`Promise.all([...])` を改行で書く等) の場合、最後の anchor 行より
    後ろにある `])` まで RHS を伸ばすために使う (要素単位 split/dedup に必須)。
    depth が 0 に戻っても、次の非空行が method-chain 継続 (`.` / `?.` 始まり) なら
    statement は続いているとみなし走査を継続する。これにより
    `await supabase\n  .from(...)\n  .select(...)\n  .single()` のような改行チェーンで
    `.from(...)` の `)` で打ち切らず `.single()` 行まで RHS を伸ばせる
    (multi-row pass の dedup が `.single()` を取りこぼし二重報告する罠を防ぐ)。
    閾値 (SCAN_LIMIT) 内で閉じなければ最終走査行を返す。
    """
    depth = 0
    started = False
    limit = min(len(lines), eq_line + SCAN_LIMIT + 1)
    for j in range(eq_line, limit):
        segment = lines[j][eq_pos + 1 :] if j == eq_line else lines[j]
        for c in segment:
            if c in "[{(":
                depth += 1
                started = True
            elif c in "]})":
                depth -= 1
        if started and depth <= 0:
            # 次の非空行が method-chain 継続なら statement はまだ閉じていない。
            nxt = j + 1
            while nxt < limit and not lines[nxt].strip():
                nxt += 1
            if nxt < limit and lines[nxt].lstrip().startswith((".", "?.")):
                continue
            return j
    return limit - 1


def _offset_in_rhs(
    lines: list[str],
    eq_line: int,
    eq_pos: int,
    anchor_line: int,
    anchor_col_in_line: int,
) -> int:
    """
    `_rhs_text(lines, eq_line, eq_pos, anchor_line)` で得られる文字列内での、
    anchor (anchor_line 行・anchor_col_in_line 列、いずれも元行基準) の offset を返す。

    RHS は `=` 直後から始まるため、`anchor_line == eq_line` のときは RHS 文字列が
    `lines[eq_line][eq_pos + 1:]` で始まる。よって anchor の RHS 内 offset は
    `anchor_col_in_line - (eq_pos + 1)` となる (元行先頭基準の列をそのまま使うと
    `eq_pos + 1` 文字ぶんずれる — 単文 Promise.all で per-element 判定が壊れる原因)。
    """
    if anchor_line == eq_line:
        return anchor_col_in_line - (eq_pos + 1)
    # eq_line の RHS 部分長 + 以降の各行 (改行込み)。
    offset = len(lines[eq_line][eq_pos + 1 :])
    for j in range(eq_line + 1, anchor_line):
        offset += 1 + len(lines[j])  # `\n` + 行本体
    offset += 1  # anchor_line 直前の `\n`
    return offset + anchor_col_in_line


def _check_single(lines: list[str]) -> list[int]:
    """
    pass A: `.single()` / `.maybeSingle()` を含む destructure で `error` 欠落を検出。
    違反した .single() 行の 0-based index リストを返す。
    """
    violations: list[int] = []
    for idx, line in enumerate(lines):
        single_match = SINGLE_RE.search(line)
        if not single_match:
            continue

        block = _locate_destructure_block(lines, idx)
        if block is None:
            continue
        block_start, eq_line, eq_pos = block
        lhs = _extract_lhs(lines, block_start, eq_line, eq_pos)

        if not DATA_TOKEN_RE.search(lhs):
            # `data` を bind しない destructure (Supabase 結果ではない可能性が高い)。
            continue

        # `error` を検査する範囲を決める:
        #   - default: LHS 全体
        #   - Promise.all + array destructure: 当該 .single() の Promise.all 内 position に
        #     対応する LHS array element だけ (per-element 検査で false negative を防ぐ)
        check_target = lhs
        if ARRAY_DESTRUCT_RE.search(lhs):
            rhs_text = _rhs_text(lines, eq_line, eq_pos, idx)
            single_offset = _offset_in_rhs(
                lines, eq_line, eq_pos, idx, single_match.start()
            )

            position = _find_position_in_promise_all(rhs_text, single_offset)
            if position is not None:
                elements = _parse_array_lhs_elements(lhs)
                if elements is not None and 0 <= position < len(elements):
                    check_target = elements[position]

        if ERROR_TOKEN_RE.search(check_target):
            continue

        violations.append(idx)

    return violations


def _check_multirow(lines: list[str]) -> list[int]:
    """
    pass B: multi-row supabase 読み取り/書き込みクエリ
    (`supabase....select(...)` / `.rpc(...)`) の destructure で `error` 欠落を検出。

    Promise.all 内では要素単位で判定する:
      - 当該 anchor が属する Promise.all element の LHS だけで `error` を検査する
        (LHS 全体に他要素の error トークンが在っても false negative を作らない)。
      - dedup も要素単位: 当該要素の RHS が `.single()`/`.maybeSingle()` を含むなら
        その要素は pass A の担当なので pass B はスキップする。`.single()` を含む別の
        兄弟要素が在っても、multi-row only の要素は取りこぼさない。
    Promise.all 外の単文では従来どおり statement 全体で判定する。
    違反した anchor 行の 0-based index リストを返す。
    """
    violations: list[int] = []
    for idx, line in enumerate(lines):
        anchor_match = MULTIROW_ANCHOR_RE.search(line)
        if not anchor_match:
            continue

        block = _locate_destructure_block(lines, idx)
        if block is None:
            continue
        block_start, eq_line, eq_pos = block
        lhs = _extract_lhs(lines, block_start, eq_line, eq_pos)

        if not DATA_TOKEN_RE.search(lhs):
            # `data` を bind しない destructure は対象外。
            continue

        # RHS は statement 末尾まで伸ばす: Promise.all の閉じ `])` が anchor 行より
        # 後ろにある場合でも要素 split できるようにする (anchor offset は anchor_line
        # までの行長にしか依存しないため、RHS を伸ばしても offset は不変)。
        stmt_end = max(idx, _find_statement_end(lines, eq_line, eq_pos))
        rhs = _rhs_text(lines, eq_line, eq_pos, stmt_end)

        # false positive 防止: RHS チェーンが supabase 識別子を含むことを必須とする。
        if not SUPABASE_TOKEN_RE.search(rhs):
            continue

        # 検査範囲を決める:
        #   - default (Promise.all 外): LHS 全体 / RHS 全体。
        #   - Promise.all + array destructure: 当該 anchor の Promise.all 内 position に
        #     対応する LHS array element / RHS element だけを見る (要素単位精度)。
        check_lhs = lhs
        check_rhs = rhs
        if ARRAY_DESTRUCT_RE.search(lhs):
            anchor_offset = _offset_in_rhs(
                lines, eq_line, eq_pos, idx, anchor_match.start()
            )

            position = _find_position_in_promise_all(rhs, anchor_offset)
            if position is not None:
                lhs_elems = _parse_array_lhs_elements(lhs)
                if lhs_elems is not None and 0 <= position < len(lhs_elems):
                    check_lhs = lhs_elems[position]
                rhs_elems = _split_promise_all_elements(rhs)
                if rhs_elems is not None and 0 <= position < len(rhs_elems):
                    check_rhs = rhs_elems[position]

        # dedup: 当該要素 (Promise.all 外なら statement 全体) の RHS が
        # `.single()`/`.maybeSingle()` を含むなら pass A の担当。
        if SINGLE_RE.search(check_rhs):
            continue

        if ERROR_TOKEN_RE.search(check_lhs):
            continue

        violations.append(idx)

    return violations


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

    single_idx = _check_single(lines)
    # pass B は要素単位で `.single()` を含む要素を自前で除外するため、
    # pass A から dedup 情報を渡す必要はない (要素単位 dedup が statement-wide skip より精密)。
    multirow_idx = _check_multirow(lines)

    # 行番号順にマージ (二重報告は _check_multirow 側で既に除外済み)。
    all_idx = sorted(set(single_idx) | set(multirow_idx))
    return [(i + 1, lines[i].strip()) for i in all_idx]


def main() -> int:
    args = sys.argv[1:]
    strict = "--strict" in args
    # `--strict` 等のフラグを除いた最初の位置引数をスキャン対象パスとする。
    positional = [a for a in args if not a.startswith("-")]
    scan_root = Path(positional[0]).resolve() if positional else SRC

    if not scan_root.exists():
        print(f"scan path not found: {scan_root}", file=sys.stderr)
        return 2

    if scan_root.is_file():
        candidates = [scan_root]
    else:
        candidates = sorted(scan_root.rglob("*"))

    all_violations: list[tuple[Path, int, str]] = []
    for path in candidates:
        if not path.is_file():
            continue
        if path.suffix not in {".ts", ".tsx"}:
            continue
        if "__tests__" in path.parts or path.stem.endswith(".test"):
            continue
        for lineno, content in check_file(path):
            all_violations.append((path, lineno, content))

    if not all_violations:
        print("OK: no Supabase destructures missing `error`.")
        return 0

    print(
        f"Found {len(all_violations)} Supabase destructure(s) "
        "without `error` receiver:"
    )
    for path, lineno, content in all_violations:
        # ROOT 配下なら相対表示、外部 (test の tmpdir 等) なら絶対のまま。
        try:
            display = path.relative_to(ROOT)
        except ValueError:
            display = path
        print(f"  {display}:{lineno}  {content}")

    print()
    print(
        "Supabase の error は class Error を継承しない plain object じゃ。"
        "`.single()` 失敗は `data: null`、multi-row クエリ失敗は空配列で隠匿される。"
        "`{ data, error }` で受け取り構造化ログ (learnings.md L55) を出すこと。"
    )

    return 1 if strict else 0


if __name__ == "__main__":
    sys.exit(main())
