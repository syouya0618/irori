#!/usr/bin/env python3
"""
`transition-all` の混入と、`transition-[...]` 列挙の取りこぼしを検出する。

## なぜ要るか

CLAUDE.md:31 と docs/DESIGN_SYSTEM.md:117 は `transition-all` を禁じておる。
しかし 2026-08-03 の監査時点で `src/components/ui/` の 4 プリミティブ
（button / badge / switch / tabs）に残っており、**機械ガードは 1 つも無かった**。

`components.json` が在る（`"style": "base-nova"`）ゆえ、次に
`npx shadcn add button` を撃つと**上流既定の `transition-all` へ黙って巻き戻る**。
人の目視だけでは守れぬ。

## もう 1 つの、より静かな壊れ方

`transition-all` を「実際に動く性質だけ」の列挙へ置き換えるとき、**列挙を 1 つ
落とすと、その性質だけが瞬間切替へ退行する**。しかも `grep transition-all` は
0 件になるため「直った」ように見える。テストも通る（このリポジトリに
transition クラスを assert するテストは 1 本も無い）。

ゆえに本検出器は 2 段構えじゃ:

  1. `transition-all` の混入を弾く
  2. `transition-[...]` を持つ行について、**同じ class 文字列が動かす性質**が
     列挙に含まれておるかを検査する

2 が本体じゃ。1 だけなら grep で足りる。

## 判定の向き（denylist ではなく「実際に在る状態バリアント」から導出）

Tailwind の状態バリアント（`hover:` / `focus-visible:` / `active:` /
`disabled:` / `aria-invalid:` / `data-*:` / `group-data-*:`）が付いた
ユーティリティを走査し、それが動かす CSS プロパティを引く。列挙に無ければ違反。

**Tailwind v4 の罠**: `translate-y-px` は `transform` ではなく **`translate`**
プロパティへコンパイルされる（ビルド成果物で実測済み。Tailwind 自身も
`.transition-transform{transition-property:transform,translate,scale,rotate}`
と 4 つを別物として列挙しておる）。ゆえに `transform` と書いても押し込みの
手応えは動かぬ。この対応表がその知識の置き場じゃ。

## 限界（正直に書く）

- これは**検知**であって防止ではない。ガードを緩める変更は止められぬ
- CSS ファイル直書きや、実行時に組み立てられる class 名は見えぬ
- 対応表に無いユーティリティは「性質不明」として**無視**する（偽陽性で
  作業を止める方が高くつくため）。表を育てるのは人の仕事じゃ

使い方:
    ./scripts/check-transition-all.py [path ...] [--strict]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# 状態バリアントの判定は **allowlist で書かぬ**。
#
# 当初は `hover|focus-visible|active|aria-...` 等を列挙する形で書いたが、
# 自分の注入テストで**守るべき当のケースを素通りさせた**:
#   `active:not-aria-[haspopup]:translate-y-px`
# の接頭辞 `not-aria-[haspopup]` が列挙に無く、トークンごと無視されておった。
# ゆえに列挙から `translate` を落としても違反 0 件で通った。
#
# Tailwind のバリアントは任意に増える（`not-*` / `has-*` / `supports-*` /
# 独自 variant）。**allowlist は増えた瞬間に無音で漏れる** —
# CLAUDE.md の「判定の向き」則そのものじゃ。
#
# ゆえに「コロンを含むトークンは全て候補」とし、絞り込みは
# UTILITY_TO_PROPERTY 側（＝性質が引けたものだけ）に任せる。
# 性質が引けぬユーティリティ（`h-11` / `w-full` / `pointer-events-none` 等）は
# そこで落ちるため、過剰検出にはならぬ。

# ユーティリティ名 → 遷移対象の CSS プロパティ
#
# ⚠️ `translate-*` を `transform` にするな。Tailwind v4 は `translate`
#    プロパティへ出す（ビルド成果物で実測）。ここを間違えると
#    「列挙したのに動かぬ」という、最も気付けぬ形で壊れる。
UTILITY_TO_PROPERTY: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(?:bg)-"), "background-color"),
    (re.compile(r"^(?:text)-(?!\[?(?:xs|sm|base|lg|[0-9]?xl))"), "color"),
    (re.compile(r"^(?:border)-(?!\d)"), "border-color"),
    (re.compile(r"^(?:outline)-(?!\d)"), "outline-color"),
    # Tailwind の ring / shadow はいずれも box-shadow 実装
    (re.compile(r"^(?:ring|shadow)(?:-|$)"), "box-shadow"),
    (re.compile(r"^translate-"), "translate"),
    (re.compile(r"^scale-"), "scale"),
    (re.compile(r"^rotate-"), "rotate"),
    (re.compile(r"^opacity-"), "opacity"),
]

TRANSITION_ARBITRARY = re.compile(r"transition-\[([^\]]+)\]")
CLASS_STRING = re.compile(r'"([^"\n]{20,})"')

# 行コメント / ブロックコメント。**禁止語を説明する行が禁止に引っかかる**のを避ける。
#
# これは規約系検出器の典型的な穴じゃ。初版は行に `transition-all` の文字列が
# 在るだけで違反としたため、
#   `// transition は colors のみ（transition-all は禁止）`
# のような**規約を説明するコメント自体**を違反と報告した（実測 2 件）。
# 違反の説明が違反になると、正しく書いた者ほど赤くなる。
LINE_COMMENT = re.compile(r"//[^\n]*")
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)

DEFAULT_PATHS = ["src"]


def properties_of(utility: str) -> str | None:
    for pattern, prop in UTILITY_TO_PROPERTY:
        if pattern.search(utility):
            return prop
    return None


def is_test_path(path: Path) -> bool:
    """
    テストファイルは検査せぬ。

    テストの class 文字列は**描画されぬ**うえ、「`transition-all` が無いこと」を
    assert するテスト（`expect(cls).not.toContain("transition-all")`）は
    禁止語をソースに持たざるを得ぬ。**検査する側を検査すると必ず偽陽性になる。**

    代償: テスト内に定義したインラインコンポーネントは見えぬ。それは受け入れる
    （そもそも描画経路に乗らぬため）。
    """
    return "__tests__" in path.parts or ".test." in path.name or ".spec." in path.name


def strip_comments(text: str) -> str:
    """コメントを**同じ長さの空白**へ潰す（行番号と桁位置を保つため）。"""
    def blank(m: re.Match[str]) -> str:
        return "".join(" " if c != "\n" else "\n" for c in m.group(0))

    return LINE_COMMENT.sub(blank, BLOCK_COMMENT.sub(blank, text))


def check_file(path: Path) -> list[str]:
    violations: list[str] = []
    if is_test_path(path):
        return violations
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return violations
    text = strip_comments(raw)

    for lineno, line in enumerate(text.splitlines(), start=1):
        if "transition-all" in line:
            violations.append(
                f"{path}:{lineno}: `transition-all` は禁止じゃ"
                "（CLAUDE.md:31 / DESIGN_SYSTEM.md:117）。"
                "実際に動く性質だけを `transition-[...]` で列挙せよ"
            )

    # 列挙の取りこぼし検査は class 文字列単位で行う
    for match in CLASS_STRING.finditer(text):
        class_string = match.group(1)
        enumerated = TRANSITION_ARBITRARY.search(class_string)
        if enumerated is None:
            continue
        listed = {p.strip() for p in enumerated.group(1).split(",")}
        lineno = text[: match.start()].count("\n") + 1

        missing: dict[str, str] = {}
        for token in class_string.split():
            if ":" not in token:
                continue
            _, _, utility = token.rpartition(":")
            prop = properties_of(utility)
            if prop is not None and prop not in listed:
                missing.setdefault(prop, token)

        for prop, token in sorted(missing.items()):
            violations.append(
                f"{path}:{lineno}: `{token}` が {prop} を動かすが "
                f"transition-[...] に含まれておらぬ。"
                "列挙漏れは『その性質だけ瞬間切替』へ静かに退行する"
                "（grep transition-all は 0 件のままゆえ気付けぬ）"
            )

    return violations


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--strict"]
    strict = "--strict" in sys.argv
    targets = args or DEFAULT_PATHS

    violations: list[str] = []
    checked = 0
    for target in targets:
        root = Path(target)
        paths = (
            [root]
            if root.is_file()
            else [
                p
                for suffix in ("*.tsx", "*.ts", "*.css")
                for p in root.rglob(suffix)
                if "node_modules" not in p.parts and ".next" not in p.parts
            ]
        )
        for path in paths:
            checked += 1
            violations.extend(check_file(path))

    for v in violations:
        print(v)
    print(f"transition-all / 列挙漏れ violations: {len(violations)} (checked: {checked})")
    return 1 if (violations and strict) else 0


if __name__ == "__main__":
    raise SystemExit(main())
