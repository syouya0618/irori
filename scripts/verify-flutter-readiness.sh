#!/usr/bin/env bash
# Phase 1 着手前ブロッカー自動検証スクリプト
#
# 目的: Issue #48 (Flutter Auth UI) 着手前に解消すべき以下を Vercel/Supabase API で自動確認:
#   R1: Vercel `irori-flutter` project の Build Command に `--dart-define` 設定済か
#   R2: 同 project の env に `SUPABASE_URL` / `SUPABASE_ANON_KEY` が登録済か (Production/Preview/Development)
#   R3: Supabase Auth Allowed Redirect URLs に `https://irori-flutter-*.vercel.app/*` (wildcard) 登録済か
#
# 各項目は 3 状態 (tri-state) のいずれかで判定する:
#   OK         … HTTP 2xx でデータ取得成功し、要件を満たす
#   BLOCKER    … HTTP 2xx でデータ取得成功したが要件が欠落 (project 不在 / env 未登録 / redirect URL 未登録)
#   UNVERIFIED … 検証できなかった (token 未設定 / curl 失敗 / HTTP 非2xx (401/403/4xx/5xx) / JSON パース失敗・想定フィールド欠如)
#
# ★ 401/403 や通信失敗は UNVERIFIED であって BLOCKER ではない (「検証できないことは断言しない」)。
#
# 使用法:
#   1. cp .env.local.example .env.local
#   2. .env.local に VERCEL_TOKEN / SUPABASE_ACCESS_TOKEN を記入
#   3. bash scripts/verify-flutter-readiness.sh
#
# 終了コード (優先順位 BLOCKER > UNVERIFIED > OK):
#   0 = ✅ 全項目 OK (Phase 1 着手可能)
#   1 = ❌ 未解消ブロッカーあり (1 つ以上 BLOCKER)
#   2 = ❓ 検証不可 (BLOCKER は無いが 1 つ以上 UNVERIFIED — token 未設定 / 401 / 通信失敗 / パース失敗等)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.local"

# 設定 (環境変数で上書き可能)。env-load は main() 内で行う (テストが source する際の汚染防止)。
SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF:-your-project-ref}"
VERCEL_TEAM_ID="${VERCEL_TEAM_ID:-your-vercel-team-id}"
FLUTTER_PROJECT_NAME="${FLUTTER_PROJECT_NAME:-irori-flutter}"

# tri-state を保持するグローバル変数 (各 check 関数が直接代入する)。
R1_STATE="UNVERIFIED"
R2_STATE="UNVERIFIED"
R3_STATE="UNVERIFIED"

print_section() {
  echo
  echo "## $1"
}

# ---------------------------------------------------------------------------
# http_get URL [AUTH_HEADER_VALUE]
#   curl を実行し、body と HTTP status を安全に分離してグローバルへ格納する。
#   結果:
#     HTTP_CODE … HTTP status (curl 失敗・接続不能・タイムアウト時は '000')
#     HTTP_BODY … レスポンス本文 (status 行を除いたもの)
#   stderr は body に混ぜない (2>&1 廃止)。失敗判定は呼び出し側が HTTP_CODE で行う。
# ---------------------------------------------------------------------------
http_get() {
  local url="$1"
  local auth="${2:-}"
  local response
  if [ -n "$auth" ]; then
    response=$(curl -sS --connect-timeout 10 --max-time 30 \
      -H "Authorization: Bearer $auth" \
      -w '\n%{http_code}' \
      "$url" 2>/dev/null)
  else
    response=$(curl -sS --connect-timeout 10 --max-time 30 \
      -w '\n%{http_code}' \
      "$url" 2>/dev/null)
  fi
  # curl 自体が失敗 (接続不能・タイムアウト等) した場合は http_code が付かないので 000 を補う。
  if [ $? -ne 0 ]; then
    HTTP_CODE="000"
    HTTP_BODY=""
    return 0
  fi
  # 末尾 1 行が http_code、それ以外が body。空 body (401 等) でも壊れない。
  HTTP_CODE="${response##*$'\n'}"
  HTTP_BODY="${response%$'\n'*}"
  # http_code が数字 3 桁でない場合 (異常応答) も 000 扱い。
  if ! [[ "$HTTP_CODE" =~ ^[0-9]{3}$ ]]; then
    HTTP_CODE="000"
    HTTP_BODY="$response"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# is_http_ok HTTP_CODE
#   2xx のときだけ成功 (return 0)。それ以外 (000/401/403/4xx/5xx) は失敗 (return 1)。
#   curl 失敗・タイムアウト・非2xx をひとつのルールに集約する。
# ---------------------------------------------------------------------------
is_http_ok() {
  [[ "$1" =~ ^2[0-9][0-9]$ ]]
}

# ---------------------------------------------------------------------------
# aggregate_exit STATE1 STATE2 STATE3 ...
#   純粋関数: 各項目の tri-state を受け取り exit code を stdout に出力する。
#   優先順位 BLOCKER > UNVERIFIED > OK:
#     1 つでも BLOCKER          → 1
#     BLOCKER 無し & UNVERIFIED → 2
#     全て OK                    → 0
#   テストから直接呼んで全パターンを検証できるよう、副作用を持たない。
# ---------------------------------------------------------------------------
aggregate_exit() {
  local has_blocker=false
  local has_unverified=false
  local s
  for s in "$@"; do
    case "$s" in
      BLOCKER) has_blocker=true ;;
      UNVERIFIED) has_unverified=true ;;
      OK) ;;
      *) has_unverified=true ;;  # 未知の状態は安全側 (UNVERIFIED) に倒す
    esac
  done
  if $has_blocker; then
    echo 1
  elif $has_unverified; then
    echo 2
  else
    echo 0
  fi
}

# ---------------------------------------------------------------------------
# state_icon STATE  →  ✅ / ❌ / ❓
# ---------------------------------------------------------------------------
state_icon() {
  case "$1" in
    OK) echo "✅" ;;
    BLOCKER) echo "❌" ;;
    *) echo "❓" ;;
  esac
}

check_r1_r2_vercel() {
  print_section "R1+R2: Vercel '${FLUTTER_PROJECT_NAME}' project (Build Command + env)"

  # R1/R2 は project-list fetch を共有するが、その後の detail/env fetch は独立。
  # どれか 1 つが UNVERIFIED でも他を巻き込まないよう、各状態を独立に決める。
  R1_STATE="UNVERIFIED"
  R2_STATE="UNVERIFIED"

  if [ -z "${VERCEL_TOKEN:-}" ]; then
    echo "❓ VERCEL_TOKEN 未設定 → R1/R2 検証不可 (UNVERIFIED)"
    echo "   発行: https://vercel.com/account/tokens"
    echo "   設定先: .env.local の VERCEL_TOKEN="
    return
  fi

  # --- project 一覧取得 (R1/R2 共通の前提) ---
  http_get "https://api.vercel.com/v9/projects?teamId=$VERCEL_TEAM_ID&limit=100" "$VERCEL_TOKEN"
  if ! is_http_ok "$HTTP_CODE"; then
    echo "❓ Vercel projects 一覧取得 失敗 (HTTP $HTTP_CODE) → R1/R2 検証不可 (UNVERIFIED)"
    echo "   401/403 は token 無効/権限不足。通信失敗は HTTP 000。いずれも『欠落』とは断言しない。"
    return
  fi

  # project 名は python ソース文字列へ直接補間せず os.environ 経由で渡す
  # (名前にアポストロフィ等が入っても SyntaxError で壊れた経路に縮退しない)。
  local match
  match=$(printf '%s' "$HTTP_BODY" | FLUTTER_PROJECT_NAME="$FLUTTER_PROJECT_NAME" python3 -c '
import json, os, sys
try:
    name = os.environ.get("FLUTTER_PROJECT_NAME", "")
    d = json.load(sys.stdin)
    projects = d.get("projects")
    if not isinstance(projects, list):
        print("UNVERIFIED:projects フィールド欠如")
        sys.exit(0)
    m = [p for p in projects if p.get("name") == name]
    if m:
        print("FOUND:" + str(m[0].get("id", "")))
    else:
        print("NOTFOUND")
except Exception as e:
    print("UNVERIFIED:" + type(e).__name__ + ": " + str(e))
')

  if [[ "$match" == UNVERIFIED:* ]]; then
    echo "❓ Vercel projects 一覧の解析失敗: ${match#UNVERIFIED:} → R1/R2 検証不可 (UNVERIFIED)"
    return
  fi

  # 空出力・未知出力 (python3 不在 exit127 等で stdout が空のケース含む) は
  # NOTFOUND=BLOCKER 分岐に落とさず UNVERIFIED に倒す (誤 BLOCKER 防御)。
  # 正常時の唯一の継続パスは FOUND: のみ。NOTFOUND は上で BLOCKER 確定させる。
  if [ "$match" != "NOTFOUND" ] && [[ "$match" != FOUND:* ]]; then
    echo "❓ Vercel projects 一覧の出力が想定外 (空/未知) → R1/R2 検証不可 (UNVERIFIED)"
    return
  fi

  if [ "$match" = "NOTFOUND" ]; then
    echo "❌ R1: Vercel project '${FLUTTER_PROJECT_NAME}' 不在 (BLOCKER)"
    echo "❌ R2: project 不在のため env も不在 (BLOCKER)"
    echo "   作成手順: flutter/README.md の Section 6"
    R1_STATE="BLOCKER"
    R2_STATE="BLOCKER"
    return
  fi

  local project_id="${match#FOUND:}"
  echo "✓ project 発見: $project_id"

  # --- R1: Build Command 確認 (独立 fetch) ---
  http_get "https://api.vercel.com/v9/projects/$project_id?teamId=$VERCEL_TEAM_ID" "$VERCEL_TOKEN"
  if ! is_http_ok "$HTTP_CODE"; then
    echo "❓ R1: project 詳細取得 失敗 (HTTP $HTTP_CODE) → R1 検証不可 (UNVERIFIED)"
  else
    local detail
    detail=$(printf '%s' "$HTTP_BODY" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    bc = d.get('buildCommand') or '(default/none)'
    rd = d.get('rootDirectory') or '(repo root)'
    od = d.get('outputDirectory') or '(default)'
    has_url = '--dart-define=SUPABASE_URL' in bc
    has_key = '--dart-define=SUPABASE_ANON_KEY' in bc
    print('BUILD=' + bc)
    print('ROOT=' + rd)
    print('OUTPUT=' + od)
    print('R1=' + ('OK' if (has_url and has_key) else 'BLOCKER'))
except Exception as e:
    print('PARSE_ERROR:' + type(e).__name__ + ': ' + str(e))
")
    if [[ "$detail" == PARSE_ERROR:* ]]; then
      echo "❓ R1: project 詳細の解析失敗: ${detail#PARSE_ERROR:} → R1 検証不可 (UNVERIFIED)"
    elif ! printf '%s' "$detail" | grep -q '^R1='; then
      # 空出力・想定外出力 (python3 不在の空 stdout 等) は BLOCKER に落とさず UNVERIFIED に。
      echo "❓ R1: project 詳細の出力が想定外 (空/未知) → R1 検証不可 (UNVERIFIED)"
    else
      echo "  Build Command: $(printf '%s' "$detail" | grep '^BUILD=' | sed 's/^BUILD=//')"
      echo "  Root Directory: $(printf '%s' "$detail" | grep '^ROOT=' | sed 's/^ROOT=//')"
      echo "  Output Directory: $(printf '%s' "$detail" | grep '^OUTPUT=' | sed 's/^OUTPUT=//')"
      local r1
      r1=$(printf '%s' "$detail" | grep '^R1=' | sed 's/^R1=//')
      if [ "$r1" = "OK" ]; then
        echo "✅ R1: Build Command に --dart-define 両方設定済"
        R1_STATE="OK"
      else
        echo "❌ R1: Build Command に --dart-define 不足 (BLOCKER)"
        R1_STATE="BLOCKER"
      fi
    fi
  fi

  # --- R2: env 確認 (独立 fetch) ---
  http_get "https://api.vercel.com/v10/projects/$project_id/env?teamId=$VERCEL_TEAM_ID&decrypt=false" "$VERCEL_TOKEN"
  if ! is_http_ok "$HTTP_CODE"; then
    echo "❓ R2: env 一覧取得 失敗 (HTTP $HTTP_CODE) → R2 検証不可 (UNVERIFIED)"
    return
  fi

  local env_summary
  env_summary=$(printf '%s' "$HTTP_BODY" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    envs = d.get('envs')
    if not isinstance(envs, list):
        print('PARSE_ERROR:envs フィールド欠如')
        sys.exit(0)
    def targets_for(key):
        matches = [e for e in envs if e.get('key') == key]
        if not matches:
            return ''
        acc = set()
        for e in matches:
            tv = e.get('target')
            # target が str で来た場合に1文字ずつ走査して誤判定するのを防ぐ正規化。
            if isinstance(tv, str):
                tv = [tv]
            elif not isinstance(tv, list):
                tv = []
            acc.update(tv)
        return ','.join(sorted(acc))
    print('URL=' + targets_for('SUPABASE_URL'))
    print('KEY=' + targets_for('SUPABASE_ANON_KEY'))
except Exception as e:
    print('PARSE_ERROR:' + type(e).__name__ + ': ' + str(e))
")

  if [[ "$env_summary" == PARSE_ERROR:* ]]; then
    echo "❓ R2: env 一覧の解析失敗: ${env_summary#PARSE_ERROR:} → R2 検証不可 (UNVERIFIED)"
    return
  fi

  # 空出力・想定外出力 (python3 不在の空 stdout 等) は env 未登録=BLOCKER ではなく UNVERIFIED に。
  if ! printf '%s' "$env_summary" | grep -q '^URL='; then
    echo "❓ R2: env 一覧の出力が想定外 (空/未知) → R2 検証不可 (UNVERIFIED)"
    return
  fi

  local url_targets key_targets
  url_targets=$(printf '%s' "$env_summary" | grep '^URL=' | sed 's/^URL=//')
  key_targets=$(printf '%s' "$env_summary" | grep '^KEY=' | sed 's/^KEY=//')

  echo "  SUPABASE_URL targets: '${url_targets:-(none)}'"
  echo "  SUPABASE_ANON_KEY targets: '${key_targets:-(none)}'"

  local required_targets="development,preview,production"
  local r2_ok=true

  local env_key actual
  for env_key in SUPABASE_URL SUPABASE_ANON_KEY; do
    if [ "$env_key" = "SUPABASE_URL" ]; then
      actual="$url_targets"
    else
      actual="$key_targets"
    fi
    if [ -z "$actual" ]; then
      echo "  ❌ $env_key 未登録"
      r2_ok=false
    elif [ "$actual" != "$required_targets" ]; then
      echo "  ⚠️  $env_key は '$actual' のみ (期待: $required_targets)"
      r2_ok=false
    fi
  done

  if $r2_ok; then
    echo "✅ R2: 両 env が全 3 environment (dev/preview/prod) で登録済"
    R2_STATE="OK"
  else
    echo "❌ R2: env 登録が不足 (BLOCKER)"
    R2_STATE="BLOCKER"
  fi
}

check_r3_supabase() {
  print_section "R3: Supabase Auth Allowed Redirect URLs"

  R3_STATE="UNVERIFIED"

  if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
    echo "❓ SUPABASE_ACCESS_TOKEN 未設定 → R3 検証不可 (UNVERIFIED)"
    echo "   発行: https://supabase.com/dashboard/account/tokens"
    echo "   設定先: .env.local の SUPABASE_ACCESS_TOKEN="
    return
  fi

  http_get "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/config/auth" "$SUPABASE_ACCESS_TOKEN"
  if ! is_http_ok "$HTTP_CODE"; then
    echo "❓ R3: Supabase Management API 取得 失敗 (HTTP $HTTP_CODE) → R3 検証不可 (UNVERIFIED)"
    echo "   401/403 は token 無効/権限不足。通信失敗は HTTP 000。いずれも『未登録』とは断言しない。"
    echo "   token / project ref が正しいか確認してたもれ"
    return
  fi

  local result
  result=$(printf '%s' "$HTTP_BODY" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict) or 'uri_allow_list' not in d:
        print('PARSE_ERROR:uri_allow_list フィールド欠如')
        sys.exit(0)
    uri_allow = d.get('uri_allow_list', '') or ''
    site_url = d.get('site_url', '') or ''
    urls = [u.strip() for u in uri_allow.split(',') if u.strip()]
    flutter_match = [u for u in urls if 'irori-flutter' in u.lower()]
    print('SITE_URL=' + site_url)
    print('URL_COUNT=' + str(len(urls)))
    print('FLUTTER_MATCH_COUNT=' + str(len(flutter_match)))
    for u in flutter_match:
        print('FLUTTER=' + u)
    for u in urls:
        if u not in flutter_match:
            print('OTHER=' + u)
except Exception as e:
    print('PARSE_ERROR:' + type(e).__name__ + ': ' + str(e))
")

  if [[ "$result" == PARSE_ERROR:* ]]; then
    echo "❓ R3: auth config の解析失敗: ${result#PARSE_ERROR:} → R3 検証不可 (UNVERIFIED)"
    return
  fi

  # 空出力・想定外出力 (python3 不在の空 stdout 等) は redirect 未登録=BLOCKER ではなく UNVERIFIED に。
  if ! printf '%s' "$result" | grep -q '^FLUTTER_MATCH_COUNT='; then
    echo "❓ R3: auth config の出力が想定外 (空/未知) → R3 検証不可 (UNVERIFIED)"
    return
  fi

  local site_url url_count flutter_count
  site_url=$(printf '%s' "$result" | grep '^SITE_URL=' | sed 's/^SITE_URL=//')
  url_count=$(printf '%s' "$result" | grep '^URL_COUNT=' | sed 's/^URL_COUNT=//')
  flutter_count=$(printf '%s' "$result" | grep '^FLUTTER_MATCH_COUNT=' | sed 's/^FLUTTER_MATCH_COUNT=//')

  echo "  site_url: ${site_url:-(empty)}"
  echo "  Redirect URLs 登録総数: $url_count"
  echo "  irori-flutter 関連 URL 件数: $flutter_count"

  if [ "${flutter_count:-0}" -gt 0 ]; then
    echo "✅ R3: irori-flutter 関連 URL 登録済"
    printf '%s' "$result" | grep '^FLUTTER=' | sed 's/^FLUTTER=/    - /'
    R3_STATE="OK"
  else
    echo "❌ R3: irori-flutter 関連 URL 未登録 (BLOCKER)"
    echo "   登録先: https://supabase.com/dashboard/project/$SUPABASE_PROJECT_REF/auth/url-configuration"
    echo "   推奨追加: https://irori-flutter-*.vercel.app/*"
    R3_STATE="BLOCKER"
  fi

  if [ "${url_count:-0}" -gt 0 ]; then
    echo
    echo "  参考: 現在登録されている全 Redirect URLs (上位 10):"
    printf '%s' "$result" | grep -E '^(FLUTTER|OTHER)=' | sed 's/^\(FLUTTER\|OTHER\)=/    - /' | head -10
  fi
}

main() {
  # .env.local から token をロード (存在すれば)。テストが source する際は main を呼ばないので汚染しない。
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi

  echo "# Phase 1 着手前ブロッカー検証 (Issue #48 着手前)"
  echo "実行日時: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "対象: Vercel team='${VERCEL_TEAM_ID}', Flutter project='${FLUTTER_PROJECT_NAME}', Supabase ref='${SUPABASE_PROJECT_REF}'"

  # preflight: python3 が無ければ JSON パースが一切できない。
  # ここで弾かないと各 check の python パイプが空出力を返し、全項目が誤って BLOCKER に
  # 化ける (H-1 と同じ「検証不能を断言」アンチパターンの別経路)。R1/R2/R3 を UNVERIFIED
  # のまま aggregate_exit を通して exit 2 で終える。
  if ! command -v python3 >/dev/null 2>&1; then
    print_section "前提チェック"
    echo "❓ python3 が見つからぬ → JSON 解析不能。R1/R2/R3 すべて検証不可 (UNVERIFIED)"
    echo "   python3 を PATH に通してから再実行してたもれ。"
  else
    check_r1_r2_vercel
    check_r3_supabase
  fi

  print_section "項目別状態"
  echo "  $(state_icon "$R1_STATE") R1 (Build Command --dart-define): $R1_STATE"
  echo "  $(state_icon "$R2_STATE") R2 (env SUPABASE_URL/ANON_KEY):   $R2_STATE"
  echo "  $(state_icon "$R3_STATE") R3 (Supabase redirect URL):       $R3_STATE"

  local exit_code
  exit_code=$(aggregate_exit "$R1_STATE" "$R2_STATE" "$R3_STATE")

  print_section "総合判定"
  case $exit_code in
    0) echo "✅ Phase 1 着手準備完了 — Issue #48 着手可能" ;;
    1) echo "❌ 未解消ブロッカーあり (上記 BLOCKER 項目を参照)"
       echo "   主の手元作業が必要: flutter/README.md Section 6-7 / 設計書 Section 7.2.1" ;;
    2) echo "❓ 検証不可 (未検証項目あり — token 未設定 / 401 / 通信失敗 / パース失敗 等)"
       echo "   BLOCKER は検出されなかったが、確実に『着手可能』とは断言できぬ。"
       echo "   設定方法: scripts/README.md を参照してたもれ" ;;
  esac

  return "$exit_code"
}

# スクリプトとして直接実行されたときだけ main を走らせる。
# source されたとき (テスト) は関数定義のみ読み込み、env-load や API 呼び出しを起こさない。
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
  exit $?
fi
