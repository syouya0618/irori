#!/usr/bin/env python3
"""
Detect `startTransition(async () => { ... })` blocks that await a Server Action
without a try/catch guard.

Next.js 公式 docs 原文
(node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375):

  > Note that unhandled errors inside `startTransition` from `useTransition`,
  > will bubble up to the nearest error boundary.

ゆえに圏外・不安定な電波下で Server Action が reject すると、握っていない箇所は
**画面ごと error boundary へ飛び、記録が無言で失われる**。夜中の片手操作で
「素早く記録できること」を壊す経路のため、全箇所を try/catch で握って
`toastOfflineError` (src/lib/utils/offline-error.ts) へ倒すことを機械で固定する。

## 検出規則
`<name>Transition(async ... => {` で始まるブロックのうち、
  - ブロック内に `await` を含み、かつ
  - ブロック本体の最初の実文が `try {` でない
ものを violation として報告する。

「先頭が try」を要求するのは、部分的な try（await の一部だけ包む形）を
false negative にしないため。バリデーションを try の前に置きたくなった場合は
`startTransition` の外（呼び出し元の同期部分）へ出すこと。

## Usage
  scripts/check-transition-reject-guard.py            # src/ を report-only
  scripts/check-transition-reject-guard.py --strict   # exit 1 on violations
  scripts/check-transition-reject-guard.py PATH [--strict]

## Verify axes（この検出器が「必ず 0 件」を返す偽緑にならないこと）
  1. True positive:  try を外した block が報告される（導入時に実測で確認）
  2. False positive: `try {` で始まる block は報告されない（既存 28 箇所で確認）
  3. await 無しの同期 block は対象外
  4. `__tests__` 配下は除外（テストは startTransition を mock/再現するため）
  5. 非 UTF-8 / 読み取り不可ファイルは stderr へ warning を出して skip する

Limitation: 行ベースのヒューリスティックであり完全な AST 解析ではない。
`.catch()` の無い floating promise（`void action()` / プレーン async onClick）は
**別機序**（error boundary へは飛ばず無言の unhandled rejection になる）ゆえ
本検出器の対象外。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

# `startTransition(async () => {` / `startClearTransition(async () => {` 等。
# 変数名は startTransition 固定ではない（shopping-list は startClearTransition）。
OPEN_RE = re.compile(r"\b\w*[Tt]ransition\(\s*async\s*(?:\([^)]*\)|\w+)\s*=>\s*\{\s*$")
# 文字列リテラルを潰してから brace を数える（`${...}` などの誤カウント防止）
STRING_RE = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`")
LINE_COMMENT_RE = re.compile(r"//.*$")


def strip_noise(line: str) -> str:
    return LINE_COMMENT_RE.sub("", STRING_RE.sub('""', line))


def block_lines(lines: list[str], start: int) -> list[str] | None:
    """start 行（`... => {` で終わる行）の直後から、対応する `}` 直前までを返す。"""
    depth = strip_noise(lines[start]).count("{") - strip_noise(lines[start]).count("}")
    if depth <= 0:
        return None
    body: list[str] = []
    for i in range(start + 1, len(lines)):
        stripped = strip_noise(lines[i])
        depth += stripped.count("{") - stripped.count("}")
        if depth <= 0:
            return body
        body.append(lines[i])
    return None  # 閉じ括弧が見つからない = 解析失敗。呼び出し側で fail-closed 扱い


def first_statement(body: list[str]) -> str:
    for line in body:
        s = line.strip()
        if not s or s.startswith("//") or s.startswith("/*") or s.startswith("*"):
            continue
        return s
    return ""


def scan_file(path: Path) -> tuple[list[tuple[int, str]], int]:
    """(violations, 検査対象となった await 有り block の数) を返す。"""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (UnicodeDecodeError, OSError) as e:
        print(f"warning: skip {path}: {e}", file=sys.stderr)
        return [], 0

    violations: list[tuple[int, str]] = []
    checked = 0
    for idx, line in enumerate(lines):
        if not OPEN_RE.search(strip_noise(line)):
            continue
        body = block_lines(lines, idx)
        if body is None:
            # 解析できない = 保証できない。fail-closed で報告する。
            checked += 1
            violations.append((idx + 1, "block の終端を解析できませんでした"))
            continue
        if not any("await " in strip_noise(b) for b in body):
            continue  # await しない block は reject 経路を持たない
        checked += 1
        if not first_statement(body).startswith("try {"):
            violations.append(
                (idx + 1, "await があるのに block 先頭が try {} ではありません")
            )
    return violations, checked


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--strict"]
    strict = "--strict" in sys.argv[1:]
    target = Path(args[0]) if args else SRC

    files = (
        [target]
        if target.is_file()
        else sorted(
            p
            for p in target.rglob("*.tsx")
            if "__tests__" not in p.parts
        )
    )

    total = 0
    checked = 0
    for path in files:
        violations, n = scan_file(path)
        checked += n
        for lineno, reason in violations:
            total += 1
            rel = path.relative_to(ROOT) if ROOT in path.parents else path
            print(f"{rel}:{lineno}: {reason}")

    # checked を必ず出す: 正規表現が何にもマッチしない状態でも "violations: 0" は
    # 出てしまうため、「0 件」が偽緑でないことを検査対象数で示す。
    print(f"\nchecked (await を含む transition block): {checked}")
    print(f"startTransition reject guard violations: {total}")
    if total and strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
