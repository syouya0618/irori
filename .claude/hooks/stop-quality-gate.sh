#!/usr/bin/env bash
# Claude Code Stop hook: 作業ツリーに変更があれば lint + test を強制する。
# 失敗時は exit 2 で停止をブロックし、末尾の出力を Claude に返して修正を促す。
set -uo pipefail

INPUT=$(cat)

# このフック自身が起こした再実行なら通す (無限ループ防止)
if printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

CHANGED=$(git status --porcelain 2>/dev/null) || exit 0
[ -z "$CHANGED" ] && exit 0

# rename 行 ("R old -> new") は新パスを採る
paths=$(printf '%s\n' "$CHANGED" | awk '{print $NF}')

run_web=false
run_flutter=false
while IFS= read -r p; do
  case "$p" in
    flutter/*) run_flutter=true ;;
    src/*|e2e/*|public/*|package.json|next.config.ts|tsconfig.json|vitest.config.ts|vitest.setup.ts|playwright.config.ts|eslint.config.mjs) run_web=true ;;
  esac
done <<<"$paths"

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

if [ "$run_web" = true ]; then
  if ! LINT_OUT=$(pnpm lint 2>&1); then
    fail "Stop blocked: pnpm lint failed:
$(printf '%s\n' "$LINT_OUT" | tail -30)"
  fi
  if ! TEST_OUT=$(pnpm test:run 2>&1); then
    fail "Stop blocked: pnpm test:run failed:
$(printf '%s\n' "$TEST_OUT" | tail -40)"
  fi
fi

if [ "$run_flutter" = true ]; then
  if command -v fvm >/dev/null 2>&1; then
    FLUTTER_BIN="fvm flutter"
  else
    FLUTTER_BIN="flutter"
  fi
  if ! ANALYZE_OUT=$(cd flutter && $FLUTTER_BIN analyze --fatal-infos 2>&1); then
    fail "Stop blocked: flutter analyze failed:
$(printf '%s\n' "$ANALYZE_OUT" | tail -30)"
  fi
fi

exit 0
