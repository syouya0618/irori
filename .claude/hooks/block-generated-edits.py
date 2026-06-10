#!/usr/bin/env python3
"""Claude Code PreToolUse hook: 生成物・ロックファイル・秘密情報への Edit/Write をブロックする。

対象は Edit / Write / NotebookEdit のみ。Bash 経由のツール実行
(pnpm add, dart run build_runner 等) はブロックしないので、
正規の生成手段は通常どおり使える。
"""
import json
import re
import sys

# (パターン, 理由) — パスは / 区切りに正規化してから照合する
BLOCK_PATTERNS = [
    (r"(^|/)pnpm-lock\.yaml$", "pnpm-lock.yaml は pnpm CLI 経由でのみ変更すること"),
    (r"(^|/)pubspec\.lock$", "pubspec.lock は flutter pub 経由でのみ変更すること"),
    (r"(^|/)\.env($|\.)", ".env* は秘密情報のため編集禁止 (env.example はブロック対象外)"),
    (r"(^|/)\.next(/|$)", ".next/ はビルド生成物"),
    (r"(^|/)node_modules(/|$)", "node_modules/ は編集禁止"),
    (r"(^|/)flutter/build(/|$)", "flutter/build/ はビルド生成物"),
    (r"\.freezed\.dart$", "*.freezed.dart は build_runner 生成物 (dart run build_runner build を使う)"),
    (r"\.g\.dart$", "*.g.dart は build_runner 生成物 (dart run build_runner build を使う)"),
    (r"(^|/)tsconfig\.tsbuildinfo$", "tsconfig.tsbuildinfo は生成物"),
    (r"(^|/)\.vercel(/|$)", ".vercel/ は編集禁止"),
    (r"(^|/)supabase/\.temp(/|$)", "supabase/.temp/ は生成物"),
]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0  # 入力が解釈できない場合はフェイルオープン
    tool_input = payload.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if not path:
        return 0
    normalized = str(path).replace("\\", "/")
    for pattern, reason in BLOCK_PATTERNS:
        if re.search(pattern, normalized):
            print(f"BLOCKED: {path} — {reason}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
