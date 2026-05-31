#!/usr/bin/env bash
# verify-flutter-readiness.sh の tri-state ロジック単体/結合テスト。
#
# 実 API を一切叩かず、(a) 純粋関数 aggregate_exit を直接呼ぶ単体テストと、
# (b) curl をシェル関数で上書きして status+body fixture を返させる end-to-end テストで
# tri-state ロジックと exit code 集約を検証する。
#
# 実行: bash scripts/test-verify-flutter-readiness.sh
# 終了コード: 0 = 全 green / 1 = 失敗あり

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/verify-flutter-readiness.sh"

# 親 shell に token が export されていると、token-未設定系テストが意図ブランチ
# (token 未設定) を踏まず別経路で偶然 exit2 に達し false green になりうる。
# トップレベルで 1 回だけ unset しておく (per-call の inline 代入は subshell 内で
# 有効なまま残るので、token-設定系テストには影響しない)。
unset VERCEL_TOKEN SUPABASE_ACCESS_TOKEN 2>/dev/null || true

PASS=0
FAIL=0

# テスト中に本物の .env.local をソースして token が漏れ込まないよう、
# REPO_ROOT を一時ディレクトリに差し替える。さらに token も明示的に空へ。
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $label (= $actual)"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $label : expected '$expected', got '$actual'"
  fi
}

# ---------------------------------------------------------------------------
# (A) 純粋関数 aggregate_exit の全パターン (副作用なしで source して直接呼ぶ)
# ---------------------------------------------------------------------------
test_aggregate_exit() {
  echo
  echo "### (A) aggregate_exit 純粋関数 — 集約優先順位 BLOCKER > UNVERIFIED > OK"
  # 関数定義のみ読み込む (BASH_SOURCE != $0 なので main は走らない)。
  # shellcheck disable=SC1090
  source "$TARGET"

  assert_eq "全 OK → 0" 0 "$(aggregate_exit OK OK OK)"
  assert_eq "1 つ BLOCKER → 1" 1 "$(aggregate_exit OK BLOCKER OK)"
  assert_eq "1 つ UNVERIFIED → 2" 2 "$(aggregate_exit OK UNVERIFIED OK)"
  # H-1 中核: BLOCKER と UNVERIFIED 混在で BLOCKER が消えないこと。
  assert_eq "BLOCKER + UNVERIFIED 混在 → 1 (BLOCKER優先)" 1 "$(aggregate_exit BLOCKER UNVERIFIED OK)"
  assert_eq "全 UNVERIFIED → 2" 2 "$(aggregate_exit UNVERIFIED UNVERIFIED UNVERIFIED)"
  assert_eq "全 BLOCKER → 1" 1 "$(aggregate_exit BLOCKER BLOCKER BLOCKER)"
  assert_eq "BLOCKER + UNVERIFIED + OK → 1" 1 "$(aggregate_exit BLOCKER UNVERIFIED OK)"
  assert_eq "未知状態は UNVERIFIED 扱い → 2" 2 "$(aggregate_exit OK GARBAGE OK)"
}

# ---------------------------------------------------------------------------
# (B) is_http_ok の境界
# ---------------------------------------------------------------------------
test_is_http_ok() {
  echo
  echo "### (B) is_http_ok — 2xx のみ成功、それ以外は失敗"
  # shellcheck disable=SC1090
  source "$TARGET"

  if is_http_ok 200; then assert_eq "200 → ok" ok ok; else assert_eq "200 → ok" ok ng; fi
  if is_http_ok 204; then assert_eq "204 → ok" ok ok; else assert_eq "204 → ok" ok ng; fi
  if is_http_ok 401; then assert_eq "401 → not-ok" ng ok; else assert_eq "401 → not-ok" ng ng; fi
  if is_http_ok 403; then assert_eq "403 → not-ok" ng ok; else assert_eq "403 → not-ok" ng ng; fi
  if is_http_ok 500; then assert_eq "500 → not-ok" ng ok; else assert_eq "500 → not-ok" ng ng; fi
  if is_http_ok 000; then assert_eq "000(curl失敗) → not-ok" ng ok; else assert_eq "000(curl失敗) → not-ok" ng ng; fi
}

# ---------------------------------------------------------------------------
# end-to-end ハーネス
#   curl をシェル関数で上書きし、URL に応じた fixture (body + 末尾 http_code) を返す。
#   サブシェルで実行し exit code と本文を捕捉する。
#
#   fixture 制御変数 (環境変数で渡す):
#     VERCEL_TOKEN / SUPABASE_ACCESS_TOKEN … 未設定なら token 欠如パス
#     FX_PROJECTS_CODE / FX_PROJECTS_BODY    … v9/projects 応答
#     FX_DETAIL_CODE   / FX_DETAIL_BODY      … v9/projects/<id> 応答
#     FX_ENV_CODE      / FX_ENV_BODY         … v10/projects/<id>/env 応答
#     FX_AUTH_CODE     / FX_AUTH_BODY        … supabase config/auth 応答
#     FX_CURL_FAIL=1                          … curl が exit 1 (接続不能) を模倣
#     FX_NO_PYTHON=1                           … python3 を exit127 空出力に shadow (パース不能模倣)
# ---------------------------------------------------------------------------
run_e2e() {
  # 出力を捕捉しつつ exit code を取得。サブシェルで TARGET を source → curl override → main。
  local out rc
  out=$(
    # 本物 env を読ませない: REPO_ROOT を空 tmp に向ける。
    export HOME="$TEST_TMP"
    # shellcheck disable=SC1090
    source "$TARGET"
    # REPO_ROOT/ENV_FILE はスクリプト先頭で確定済み (実 worktree) なので、
    # ここで ENV_FILE を存在しないパスへ上書きして本物 .env.local の混入を断つ。
    # (source 済みスクリプトの main() が読むため SC2034 はクロスソース誤検知)
    # shellcheck disable=SC2034
    ENV_FILE="$TEST_TMP/nonexistent.env"

    # token チャネル分離: 親から継承した本物 token を必ず剥がし、テストが渡す token は
    # FX_ プレフィックス経由でのみ復元する。これにより
    #   (a) token-未設定系テスト: FX_ 無し → unset 後そのまま → 未設定ブランチを確実に踏む
    #   (b) token-設定系テスト  : FX_ から復元 → main が token を見る
    # 親 shell の leak が token-未設定テストへ混入する false green を構造的に排除する。
    unset VERCEL_TOKEN SUPABASE_ACCESS_TOKEN
    [ -n "${FX_VERCEL_TOKEN:-}" ] && VERCEL_TOKEN="$FX_VERCEL_TOKEN"
    [ -n "${FX_SUPABASE_ACCESS_TOKEN:-}" ] && SUPABASE_ACCESS_TOKEN="$FX_SUPABASE_ACCESS_TOKEN"

    # FX_NO_PYTHON=1: python3 を空出力 (exit127) に shadow し「python パース不能」を模倣。
    # command -v は関数を見つけるので本体の preflight は通過し、各 check の
    # 「空/未知出力ガード」(誤 BLOCKER 防御) を狙い撃ちで踏ませる。
    if [ "${FX_NO_PYTHON:-0}" = "1" ]; then
      python3() { return 127; }
    fi

    # curl を上書き: 引数列から URL を拾い、fixture を 'body\n<code>' 形式で返す。
    curl() {
      if [ "${FX_CURL_FAIL:-0}" = "1" ]; then
        return 7  # CURLE_COULDNT_CONNECT 相当
      fi
      local url=""
      local a
      for a in "$@"; do
        case "$a" in
          https://*) url="$a" ;;
        esac
      done
      local code body
      case "$url" in
        *"/v9/projects?"*)  code="${FX_PROJECTS_CODE:-200}"; body="${FX_PROJECTS_BODY:-}" ;;
        *"/v9/projects/"*)  code="${FX_DETAIL_CODE:-200}";   body="${FX_DETAIL_BODY:-}" ;;
        *"/v10/projects/"*) code="${FX_ENV_CODE:-200}";      body="${FX_ENV_BODY:-}" ;;
        *"/config/auth"*)   code="${FX_AUTH_CODE:-200}";     body="${FX_AUTH_BODY:-}" ;;
        *) code="404"; body='{"error":"unmapped url"}' ;;
      esac
      printf '%s\n%s' "$body" "$code"
      return 0
    }

    main >/dev/null 2>&1
    echo "RC=$?"
  )
  rc="${out#RC=}"
  echo "$rc"
}

# 同じだが本文も返す版 (本文 assert 用)。
run_e2e_body() {
  (
    export HOME="$TEST_TMP"
    # shellcheck disable=SC1090
    source "$TARGET"
    # ENV_FILE は source 済みスクリプトの main() が読む (SC2034 はクロスソース誤検知)。
    # shellcheck disable=SC2034
    ENV_FILE="$TEST_TMP/nonexistent.env"
    # token チャネル分離 (run_e2e と同じ。詳細はそちらのコメント参照)。
    unset VERCEL_TOKEN SUPABASE_ACCESS_TOKEN
    [ -n "${FX_VERCEL_TOKEN:-}" ] && VERCEL_TOKEN="$FX_VERCEL_TOKEN"
    [ -n "${FX_SUPABASE_ACCESS_TOKEN:-}" ] && SUPABASE_ACCESS_TOKEN="$FX_SUPABASE_ACCESS_TOKEN"
    if [ "${FX_NO_PYTHON:-0}" = "1" ]; then
      python3() { return 127; }
    fi
    curl() {
      if [ "${FX_CURL_FAIL:-0}" = "1" ]; then return 7; fi
      local url="" a
      for a in "$@"; do case "$a" in https://*) url="$a" ;; esac; done
      local code body
      case "$url" in
        *"/v9/projects?"*)  code="${FX_PROJECTS_CODE:-200}"; body="${FX_PROJECTS_BODY:-}" ;;
        *"/v9/projects/"*)  code="${FX_DETAIL_CODE:-200}";   body="${FX_DETAIL_BODY:-}" ;;
        *"/v10/projects/"*) code="${FX_ENV_CODE:-200}";      body="${FX_ENV_BODY:-}" ;;
        *"/config/auth"*)   code="${FX_AUTH_CODE:-200}";     body="${FX_AUTH_BODY:-}" ;;
        *) code="404"; body='{"error":"unmapped url"}' ;;
      esac
      printf '%s\n%s' "$body" "$code"
      return 0
    }
    main 2>&1
  )
}

# fixture 雛形 -----------------------------------------------------------------
PROJECTS_FOUND='{"projects":[{"id":"prj_123","name":"irori-flutter"}]}'
PROJECTS_NONE='{"projects":[{"id":"prj_999","name":"other-project"}]}'
DETAIL_OK='{"buildCommand":"flutter build web --dart-define=SUPABASE_URL=$X --dart-define=SUPABASE_ANON_KEY=$Y","rootDirectory":"flutter","outputDirectory":"build/web"}'
DETAIL_MISSING='{"buildCommand":"flutter build web","rootDirectory":"flutter","outputDirectory":"build/web"}'
ENV_OK='{"envs":[{"key":"SUPABASE_URL","target":["development","preview","production"]},{"key":"SUPABASE_ANON_KEY","target":["development","preview","production"]}]}'
ENV_MISSING='{"envs":[{"key":"SUPABASE_URL","target":["production"]}]}'
# target が str で来る変種。各 key につき 3 エントリ (str target) で dev+preview+prod を満たす。
# 正規化が効けば全 3 環境登録済 → R2 OK。効かないと 1 文字ずつ走査され誤 BLOCKER 化する。
ENV_STR_TARGET='{"envs":[{"key":"SUPABASE_URL","target":"development"},{"key":"SUPABASE_URL","target":"preview"},{"key":"SUPABASE_URL","target":"production"},{"key":"SUPABASE_ANON_KEY","target":"development"},{"key":"SUPABASE_ANON_KEY","target":"preview"},{"key":"SUPABASE_ANON_KEY","target":"production"}]}'
AUTH_OK='{"site_url":"https://irori.app","uri_allow_list":"https://irori.app/**,https://irori-flutter-abc.vercel.app/**"}'
AUTH_MISSING='{"site_url":"https://irori.app","uri_allow_list":"https://irori.app/**"}'

# ---------------------------------------------------------------------------
# (C) R1/R2/R3 個別の OK / BLOCKER / UNVERIFIED
# ---------------------------------------------------------------------------
test_per_requirement() {
  echo
  echo "### (C) R1/R2/R3 個別状態 (e2e, curl override)"

  # 全 OK → exit 0
  assert_eq "全項目 OK → exit 0" 0 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_OK" FX_ENV_BODY="$ENV_OK" FX_AUTH_BODY="$AUTH_OK" \
    run_e2e
  )"

  # R1 BLOCKER (build command 不足) のみ → exit 1
  assert_eq "R1 BLOCKER (dart-define不足) → exit 1" 1 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_MISSING" FX_ENV_BODY="$ENV_OK" FX_AUTH_BODY="$AUTH_OK" \
    run_e2e
  )"

  # R2 BLOCKER (env 一部のみ) のみ → exit 1
  assert_eq "R2 BLOCKER (env不足) → exit 1" 1 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_OK" FX_ENV_BODY="$ENV_MISSING" FX_AUTH_BODY="$AUTH_OK" \
    run_e2e
  )"

  # R3 BLOCKER (redirect URL 未登録) のみ → exit 1
  assert_eq "R3 BLOCKER (redirect未登録) → exit 1" 1 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_OK" FX_ENV_BODY="$ENV_OK" FX_AUTH_BODY="$AUTH_MISSING" \
    run_e2e
  )"

  # project 不在 → R1/R2 とも BLOCKER → exit 1
  assert_eq "project 不在 → R1/R2 BLOCKER → exit 1" 1 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_NONE" FX_AUTH_BODY="$AUTH_OK" \
    run_e2e
  )"
}

# ---------------------------------------------------------------------------
# (D) H-1 再現ケース (最重要) — 後勝ち上書きで状態が消えないこと
# ---------------------------------------------------------------------------
test_h1_regression() {
  echo
  echo "### (D) H-1 再現ケース (BLOCKER と UNVERIFIED の混在で情報が消えない)"

  # D-1: Vercel 真 BLOCKER (200+project不在) + Supabase UNVERIFIED (token未設定) → exit 1
  local body
  body=$(
    FX_VERCEL_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_NONE" \
    run_e2e_body
  )
  local rc=$?
  assert_eq "D-1: Vercel BLOCKER + Supabase UNVERIFIED → exit 1" 1 "$rc"
  if echo "$body" | grep -q "❌ R1"; then assert_eq "D-1: 本文に R1 BLOCKER (❌) が残る" yes yes; else assert_eq "D-1: 本文に R1 BLOCKER (❌) が残る" yes no; fi
  if echo "$body" | grep -q "R3 (Supabase redirect URL):       UNVERIFIED"; then assert_eq "D-1: 本文に R3 UNVERIFIED が残る" yes yes; else assert_eq "D-1: 本文に R3 UNVERIFIED が残る" yes no; fi

  # D-2: Vercel UNVERIFIED (401) + Supabase BLOCKER (200+URL未登録) → exit 1
  body=$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_CODE=401 FX_PROJECTS_BODY='{"error":{"message":"Not authorized"}}' \
    FX_AUTH_BODY="$AUTH_MISSING" \
    run_e2e_body
  )
  rc=$?
  assert_eq "D-2: Vercel UNVERIFIED(401) + Supabase BLOCKER → exit 1" 1 "$rc"
  if echo "$body" | grep -q "R1 (Build Command --dart-define): UNVERIFIED"; then assert_eq "D-2: R1 が UNVERIFIED (401をBLOCKER化しない)" yes yes; else assert_eq "D-2: R1 が UNVERIFIED" yes no; fi
  if echo "$body" | grep -q "❌ R3"; then assert_eq "D-2: 本文に R3 BLOCKER (❌) が残る" yes yes; else assert_eq "D-2: 本文に R3 BLOCKER (❌) が残る" yes no; fi

  # D-3: Vercel UNVERIFIED + Supabase UNVERIFIED (両方 token 未設定) → exit 2
  rc=$(run_e2e)  # token 一切渡さず
  assert_eq "D-3: 両方 UNVERIFIED (token未設定) → exit 2" 2 "$rc"

  # D-4: R1 detail-fetch だけ失敗 (500=UNVERIFIED) しても R2 env-fetch は独立に OK のまま、
  #      R3 も OK → BLOCKER 無し / R1 のみ UNVERIFIED → exit 2。
  #      projects 一覧 401 (R1/R2 同時 early-return) ではなく、detail だけ落ちる fall-through 経路を突く。
  #      ここで R2 が UNVERIFIED に巻き込まれたら「detail 失敗が env を潰す」退行 → 検出される。
  body=$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" \
    FX_DETAIL_CODE=500 FX_DETAIL_BODY='{"error":"boom"}' \
    FX_ENV_BODY="$ENV_OK" FX_AUTH_BODY="$AUTH_OK" \
    run_e2e_body
  )
  rc=$?
  assert_eq "D-4: R1 detail失敗(500) + R2/R3 OK → exit 2" 2 "$rc"
  if echo "$body" | grep -q "R1 (Build Command --dart-define): UNVERIFIED"; then assert_eq "D-4: R1 が UNVERIFIED" yes yes; else assert_eq "D-4: R1 が UNVERIFIED" yes no; fi
  # R2 が detail 失敗に巻き込まれず OK を維持している (独立性) ことを pin。
  if echo "$body" | grep -q "R2 (env SUPABASE_URL/ANON_KEY):   OK"; then assert_eq "D-4: R2 は独立に OK (detail失敗に巻き込まれない)" yes yes; else assert_eq "D-4: R2 は独立に OK" yes no; fi
}

# ---------------------------------------------------------------------------
# (E) 401/403 が UNVERIFIED に分類される (旧バグでは BLOCKER)
# ---------------------------------------------------------------------------
test_401_403_unverified() {
  echo
  echo "### (E) 401/403 → UNVERIFIED (旧バグでは BLOCKER だった)"

  # Vercel 401 のみ (Supabase は OK) → BLOCKER 無し / UNVERIFIED あり → exit 2
  assert_eq "Vercel 401 のみ → exit 2 (BLOCKERでなくUNVERIFIED)" 2 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_CODE=401 FX_PROJECTS_BODY='{"error":{"message":"Not authorized"}}' \
    FX_AUTH_BODY="$AUTH_OK" \
    run_e2e
  )"

  # Supabase 403 のみ (Vercel は OK) → exit 2
  assert_eq "Supabase 403 のみ → exit 2" 2 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_OK" FX_ENV_BODY="$ENV_OK" \
    FX_AUTH_CODE=403 FX_AUTH_BODY='{"message":"forbidden"}' \
    run_e2e
  )"

  # 旧バグ証跡: 401 を BLOCKER 扱いしていたら exit 1 になるはず → 1 でないことを確認済 (上で 2)。
}

# ---------------------------------------------------------------------------
# (F) JSON パース失敗 → UNVERIFIED
# ---------------------------------------------------------------------------
test_parse_failure() {
  echo
  echo "### (F) JSON パース失敗 → UNVERIFIED"

  # Vercel projects が壊れた JSON (200 だが非JSON) → R1/R2 UNVERIFIED、Supabase OK → exit 2
  assert_eq "Vercel 200+壊れJSON → exit 2" 2 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY='this is not json <<<' \
    FX_AUTH_BODY="$AUTH_OK" \
    run_e2e
  )"

  # Supabase auth が想定フィールド欠如 (200 だが uri_allow_list 無し) → R3 UNVERIFIED → exit 2
  assert_eq "Supabase 200+フィールド欠如 → exit 2" 2 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_OK" FX_ENV_BODY="$ENV_OK" \
    FX_AUTH_BODY='{"site_url":"https://irori.app"}' \
    run_e2e
  )"
}

# ---------------------------------------------------------------------------
# (G) curl 接続失敗 / タイムアウト → UNVERIFIED
# ---------------------------------------------------------------------------
test_curl_failure() {
  echo
  echo "### (G) curl 接続失敗/タイムアウト → UNVERIFIED"

  # curl が exit 7 (接続不能) を返す → 全 HTTP が 000 → R1/R2/R3 UNVERIFIED → exit 2
  assert_eq "curl 接続失敗 (exit7→HTTP000) → exit 2" 2 "$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_CURL_FAIL=1 \
    run_e2e
  )"
}

# ---------------------------------------------------------------------------
# (H) python3 パース不能 (空出力) → 誤 BLOCKER ではなく UNVERIFIED (修正1 検証)
# ---------------------------------------------------------------------------
test_python_missing() {
  echo
  echo "### (H) python3 パース不能 (空出力) → 誤 BLOCKER 防御"

  # 全 OK fixture + token 設定 + python3 を空出力に shadow。
  # ガードが無ければ空出力 → detail/env/auth が BLOCKER → exit 1 になる (旧アンチパターン)。
  # ガードがあれば全項目 UNVERIFIED → exit 2。
  local body rc
  body=$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_NO_PYTHON=1 \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_OK" FX_ENV_BODY="$ENV_OK" FX_AUTH_BODY="$AUTH_OK" \
    run_e2e_body
  )
  rc=$?
  assert_eq "H: python3 空出力 + 全OK fixture → exit 2 (NOT 1)" 2 "$rc"
  # 全項目が UNVERIFIED に倒れている (誤 BLOCKER 化していない) こと。
  if echo "$body" | grep -q "R1 (Build Command --dart-define): UNVERIFIED"; then assert_eq "H: R1 UNVERIFIED" yes yes; else assert_eq "H: R1 UNVERIFIED" yes no; fi
  if echo "$body" | grep -q "R2 (env SUPABASE_URL/ANON_KEY):   UNVERIFIED"; then assert_eq "H: R2 UNVERIFIED" yes yes; else assert_eq "H: R2 UNVERIFIED" yes no; fi
  if echo "$body" | grep -q "R3 (Supabase redirect URL):       UNVERIFIED"; then assert_eq "H: R3 UNVERIFIED" yes yes; else assert_eq "H: R3 UNVERIFIED" yes no; fi
  if echo "$body" | grep -q "❌"; then assert_eq "H: 本文に ❌(BLOCKER) が出ない" no yes; else assert_eq "H: 本文に ❌(BLOCKER) が出ない" no no; fi
}

# ---------------------------------------------------------------------------
# (I) env target が str 型でも正規化され R2 を誤 BLOCKER 化しない (修正2 検証)
# ---------------------------------------------------------------------------
test_env_str_target() {
  echo
  echo "### (I) env target=str 正規化 → R2 誤 BLOCKER 化しない"

  # str target を 3 環境分そろえた fixture。正規化が効けば R2 OK (→ 全 OK → exit 0)。
  # 効かないと "production" 等を 1 文字ずつ走査し target 集合が壊れ R2 BLOCKER → exit 1。
  local body rc
  body=$(
    FX_VERCEL_TOKEN=t FX_SUPABASE_ACCESS_TOKEN=t \
    FX_PROJECTS_BODY="$PROJECTS_FOUND" FX_DETAIL_BODY="$DETAIL_OK" FX_ENV_BODY="$ENV_STR_TARGET" FX_AUTH_BODY="$AUTH_OK" \
    run_e2e_body
  )
  rc=$?
  assert_eq "I: str target × 3環境 → exit 0 (正規化で R2 OK)" 0 "$rc"
  if echo "$body" | grep -q "R2 (env SUPABASE_URL/ANON_KEY):   OK"; then assert_eq "I: R2 が OK (str を char 走査しない)" yes yes; else assert_eq "I: R2 が OK" yes no; fi
  # 表示 targets が 'development,preview,production' に正規化されている (char 化けでない)。
  if echo "$body" | grep -q "SUPABASE_URL targets: 'development,preview,production'"; then assert_eq "I: targets 表示が正規 (char化けでない)" yes yes; else assert_eq "I: targets 表示が正規" yes no; fi
}

# ---------------------------------------------------------------------------
# (J) token isolation: token 未設定系が本当に「token 未設定ブランチ」を踏む (修正3 検証)
# ---------------------------------------------------------------------------
test_token_isolation() {
  echo
  echo "### (J) token isolation — token 未設定系が意図ブランチを踏む"

  # 親 shell に token を export した状態でも、トップレベル unset により
  # token 未設定ブランチが踏まれることを確認。run_e2e_body は本文も返す。
  local body rc
  export VERCEL_TOKEN="leaked-parent-token"
  export SUPABASE_ACCESS_TOKEN="leaked-parent-token"
  body=$(run_e2e_body)  # inline で token を渡さない = 未設定経路を期待
  rc=$?
  unset VERCEL_TOKEN SUPABASE_ACCESS_TOKEN
  assert_eq "J: 親 token leak 下でも token 未設定 → exit 2" 2 "$rc"
  # 「VERCEL_TOKEN 未設定」「SUPABASE_ACCESS_TOKEN 未設定」の文言が出る = 意図ブランチを踏んだ証跡。
  if echo "$body" | grep -q "VERCEL_TOKEN 未設定"; then assert_eq "J: VERCEL_TOKEN 未設定ブランチを踏む" yes yes; else assert_eq "J: VERCEL_TOKEN 未設定ブランチを踏む" yes no; fi
  if echo "$body" | grep -q "SUPABASE_ACCESS_TOKEN 未設定"; then assert_eq "J: SUPABASE_ACCESS_TOKEN 未設定ブランチを踏む" yes yes; else assert_eq "J: SUPABASE_ACCESS_TOKEN 未設定ブランチを踏む" yes no; fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "# verify-flutter-readiness.sh tri-state テスト"
test_aggregate_exit
test_is_http_ok
test_per_requirement
test_h1_regression
test_401_403_unverified
test_parse_failure
test_curl_failure
test_python_missing
test_env_str_target
test_token_isolation

echo
echo "================================================"
echo "PASS: $PASS  /  FAIL: $FAIL"
echo "================================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
