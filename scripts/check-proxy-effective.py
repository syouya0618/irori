#!/usr/bin/env python3
"""
`src/proxy.ts`（認証ゲートの最外殻）が「在るだけ」でなく **Next に走査・登録された**
ことをビルド成果物の実体で検査する。

## なぜ要るか

Next の規約ファイル（`proxy.ts` / `middleware.ts` 等）は、置き場所を一段
間違えるだけで **build も lint も型検査も緑のまま黙って無効化**される。
例外も警告も出ぬ。単体テスト（`src/__tests__/proxy.test.ts`）は default/named
export を直接呼ぶため、ファイルが inert でも緑になり、**無効化の検知に一切
ならない**。

## 実測（Next 16.2.11 / Turbopack, 2026-07-31）— 弁別子の選定根拠

`src/proxy.ts` をリポジトリ直下 `./proxy.ts` へ移して `pnpm build` した結果:

| 観測点                                   | 正配置          | 誤配置                  | 弁別子か |
|------------------------------------------|-----------------|-------------------------|----------|
| `pnpm build` の終了コード                | 0               | **0**（緑のまま）       | ✗        |
| `pnpm lint`                              | 0               | **0**                   | ✗        |
| build 出力の `ƒ Proxy (Middleware)` 行   | あり            | **消える**              | ✓        |
| `functions-config-manifest.json` の `/_middleware` | あり   | **消える**              | ✓        |
| `.next/server/middleware.js` の実在      | あり            | **あり（同じ 221B）**   | ✗        |
| 同 chunk 内の proxy 実装コード           | あり            | **あり（コンパイル済）**| ✗        |
| `.next/server/middleware-manifest.json`  | `{}` 空         | `{}` 空                 | ✗        |

**`.next/server/middleware.js` の実在は弁別子にならぬ**。誤配置でも Turbopack は
`./proxy.ts` を **コンパイルして同名の bundle を吐く**（中身に proxy 実装がそのまま
入っている）。にもかかわらず Next はそれを **登録しない**。「成果物ファイルが在る」
＝「効いている」ではない、という更に一段深い罠じゃ。`middleware-manifest.json`
（edge 用）が両方とも空なのは既知どおり。

ゆえに本検査は次の2軸で「**登録された**こと」を取る:
  - `.next/server/functions-config-manifest.json` の `functions["/_middleware"]`
    （常時検査・fail-closed）。matcher の `originalSource` が `src/proxy.ts` の
    `config.matcher` と一致することまで見て、「登録されたのはこのファイルの設定」
    を固定する。
  - `next build` の標準出力に現れる `ƒ Proxy (Middleware)` 行（`--build-log` 指定時）。

## Usage
  scripts/check-proxy-effective.py                       # report-only
  scripts/check-proxy-effective.py --strict               # exit 1 on violations
  scripts/check-proxy-effective.py --strict \
      --build-log /tmp/next-build.log                     # CI（build 出力も検査）
  scripts/check-proxy-effective.py --allow-missing-build  # .next 無しを許容（明示 opt-out）

## Verify axes（この検査が偽緑にならぬこと）
  1. True positive:  `src/proxy.ts` を `./proxy.ts` へ移して build → 赤（導入時に実測）
  2. False positive: 正配置・正常 build では 0 件
  3. `.next` が無い状態で `--strict` は **赤**（fail-open にしない）。緩めるには
     `--allow-missing-build` を明示すること
  4. 検査した位置数・matcher 数を必ず出力し、「0 件」が空振りでないことを示す

## 意図的な仕様
`src/proxy.ts` から `config.matcher` を消す（＝全経路に proxy を掛ける）と、本検査は
「matcher が見つかりません」で **赤になる**。matcher は静的アセットと /offline を
除外する load-bearing な設定ゆえ、その変更は本検査の更新を伴うべきものとして
fail-closed にしてある（黙って通すより、明示的に赤で気付かせる）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 規約ファイルとして Next が解釈しうる拡張子（pageExtensions 未カスタム前提）。
CONVENTION_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
CONVENTION_STEMS = ("proxy", "middleware")

# この repo は `src/app` 構成ゆえ、規約位置は `src/proxy.ts` ただ一つ。
CORRECT_PROXY = ROOT / "src" / "proxy.ts"

# 誤配置が起きうる「規約として解釈されうる/されそうな」位置のみを走査する。
# 全 rglob にすると `src/lib/**/proxy.ts` のような無害なファイルまで赤にし、
# 「邪魔だから緩める」圧力を生むため、意図的に狭く取る。
NEGATIVE_DIRS = (ROOT, ROOT / "src", ROOT / "src" / "app")

BUILD_LOG_PROXY_RE = re.compile(r"^\s*ƒ\s+Proxy \(Middleware\)\s*$")

# `matcher: [ "..." ]` / `matcher: "..."` の文字列リテラルを抜く。
MATCHER_BLOCK_RE = re.compile(r"\bmatcher\s*:\s*(\[[^\]]*\]|\"(?:\\.|[^\"\\])*\")", re.S)
STRING_LITERAL_RE = re.compile(r"\"(?:\\.|[^\"\\])*\"")


def source_matchers() -> tuple[list[str] | None, str | None]:
    """`src/proxy.ts` の config.matcher を返す。(matchers, エラー理由)。"""
    try:
        text = CORRECT_PROXY.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        return None, f"{CORRECT_PROXY} を読めません: {e}"

    block = MATCHER_BLOCK_RE.search(text)
    if not block:
        return None, "src/proxy.ts に config.matcher が見つかりません"

    literals = STRING_LITERAL_RE.findall(block.group(1))
    if not literals:
        return None, "config.matcher から文字列リテラルを抽出できません"

    try:
        # TS の文字列リテラルのエスケープは JSON と同型（本 matcher は `\\.` のみ）。
        # 解釈できない書き方に変わったら fail-closed で赤にする。
        return [json.loads(lit) for lit in literals], None
    except json.JSONDecodeError as e:
        return None, f"config.matcher のリテラルを解釈できません（fail-closed）: {e}"


def check_placement() -> tuple[list[str], int]:
    """配置（正位置に在る／誤位置に無い）を検査する。(violations, 走査位置数)。"""
    violations: list[str] = []

    # 前提: `src/app` 構成であること。app を動かすと「正しい proxy の位置」も動く。
    if not (ROOT / "src" / "app").is_dir():
        violations.append(
            "src/app がありません。app の位置が変われば proxy の規約位置も変わるため、"
            "本検査の前提が崩れています（scripts/check-proxy-effective.py を更新すること）"
        )

    if not CORRECT_PROXY.is_file():
        violations.append(
            "src/proxy.ts がありません（`src/app` 構成では proxy は src/ 直下が規約位置）"
        )

    scanned = 0
    for directory in NEGATIVE_DIRS:
        for stem in CONVENTION_STEMS:
            for ext in CONVENTION_EXTS:
                candidate = directory / f"{stem}{ext}"
                scanned += 1
                if candidate == CORRECT_PROXY:
                    continue  # 唯一の正位置
                if candidate.exists():
                    rel = candidate.relative_to(ROOT)
                    violations.append(
                        f"{rel}: 規約ファイルが誤った位置にあります"
                        "（`src/app` 構成の規約位置は src/proxy.ts のみ。"
                        "リポジトリ直下・src/app 配下・deprecated な middleware.* は"
                        "いずれも黙って無効化される／曖昧になる）"
                    )
    return violations, scanned


def check_registration() -> tuple[list[str], int]:
    """ビルド成果物で「登録された」ことを検査する。(violations, 比較した matcher 数)。"""
    violations: list[str] = []
    manifest_path = ROOT / ".next" / "server" / "functions-config-manifest.json"

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        violations.append(f"{manifest_path.relative_to(ROOT)} を読めません: {e}")
        return violations, 0

    entry = (manifest.get("functions") or {}).get("/_middleware")
    if not entry:
        violations.append(
            ".next/server/functions-config-manifest.json に /_middleware がありません"
            "＝ proxy が **登録されていません**（誤配置ビルドと同じ形。"
            "`.next/server/middleware.js` は誤配置でも出るため実在は根拠になりません）"
        )
        return violations, 0

    artifact_matchers = [
        m.get("originalSource") for m in (entry.get("matchers") or [])
    ]
    if not artifact_matchers:
        violations.append(
            "/_middleware に matchers がありません（config.matcher が成果物へ渡っていません）"
        )
        return violations, 0

    expected, err = source_matchers()
    if err:
        violations.append(err)
        return violations, len(artifact_matchers)

    assert expected is not None
    if sorted(artifact_matchers) != sorted(expected):
        violations.append(
            "登録された matcher が src/proxy.ts の config.matcher と一致しません"
            f"\n  成果物: {artifact_matchers}\n  ソース: {expected}"
        )
    return violations, len(artifact_matchers)


def check_build_log(path: Path) -> list[str]:
    """`next build` 出力に `ƒ Proxy (Middleware)` 行があることを検査する。"""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as e:
        return [f"build log を読めません（fail-closed）: {path}: {e}"]

    if not any(BUILD_LOG_PROXY_RE.match(line) for line in lines):
        return [
            f"build 出力に `ƒ Proxy (Middleware)` 行がありません（{path}）"
            "＝ Next が proxy を登録していません"
        ]
    return []


def main() -> int:
    argv = sys.argv[1:]
    strict = "--strict" in argv
    allow_missing_build = "--allow-missing-build" in argv

    build_log: Path | None = None
    if "--build-log" in argv:
        i = argv.index("--build-log")
        if i + 1 >= len(argv):
            print("error: --build-log にはパスが必要です", file=sys.stderr)
            return 2
        build_log = Path(argv[i + 1])

    violations: list[str] = []

    placement_violations, scanned = check_placement()
    violations.extend(placement_violations)

    next_dir = ROOT / ".next"
    matchers_compared = 0
    registration_state = ""
    if next_dir.is_dir():
        registration_violations, matchers_compared = check_registration()
        violations.extend(registration_violations)
        registration_state = "検査した"
    elif allow_missing_build:
        # fail-open を明示的に選んだ場合のみ。stderr と集計行の両方に出し、
        # 「violations: 0」が「検証済み」と読めないようにする。
        print(
            "warning: .next がないため登録検査を skip しました"
            "（--allow-missing-build 指定）。proxy の有効性は **未検証** です",
            file=sys.stderr,
        )
        registration_state = "skip（--allow-missing-build・未検証）"
    else:
        violations.append(
            ".next がありません。先に `pnpm build` を実行してください"
            "（未ビルドを緑にすると、この検査自体が fail-open になります。"
            "意図的に飛ばすなら --allow-missing-build を明示すること）"
        )
        registration_state = "未実施（.next なし）"

    if build_log is not None:
        violations.extend(check_build_log(build_log))
        build_log_state = f"検査した（{build_log}）"
    else:
        build_log_state = "未検査（--build-log 未指定）"

    for v in violations:
        print(v)

    # 「0 件」が空振りでないことを示すため、必ず走査量を出す。
    print(f"\nchecked (規約ファイルの位置候補): {scanned}")
    print(f"checked (成果物の登録): {registration_state}")
    print(f"checked (matcher 一致比較): {matchers_compared}")
    print(f"checked (build 出力の `ƒ Proxy (Middleware)` 行): {build_log_state}")
    print(f"proxy effectiveness violations: {len(violations)}")

    if violations and strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
