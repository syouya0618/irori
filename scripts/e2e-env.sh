#!/usr/bin/env bash
# E2E 用 env ファイル (.env.e2e) を Supabase ローカルスタックから生成する。
#
# `supabase status -o env --override-name ...` で必要な 3 キーを
# アプリの env 名に変換して書き出す（CLI 2.101 で動作検証済み）。
# .env.e2e は .gitignore (.env*) で除外済み。
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.e2e"
TMP_FILE="${ENV_FILE}.tmp"

cleanup() { rm -f "$TMP_FILE"; }
trap cleanup EXIT

# supabase status は停止中だと非 0 で終了する
if ! supabase status -o env \
  --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
  --override-name auth.anon_key=NEXT_PUBLIC_SUPABASE_ANON_KEY \
  --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY \
  > "$TMP_FILE" 2>/dev/null; then
  echo "error: Supabase ローカルスタックが起動していません。先に \`supabase start\` を実行してください。" >&2
  exit 1
fi

# 必要キーのみ抽出（他キーで Next.js ビルドの env を汚染しない）
grep -E '^(NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)=' \
  "$TMP_FILE" > "$ENV_FILE"

# GoTrue の site_url (supabase/config.toml) と一致させるため 127.0.0.1 固定
echo 'NEXT_PUBLIC_APP_URL="http://127.0.0.1:3000"' >> "$ENV_FILE"

# 検証: 4 キーが揃っているか
for key in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_APP_URL; do
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    echo "error: ${key} を ${ENV_FILE} に書き出せませんでした。\`supabase status -o env\` の出力を確認してください。" >&2
    exit 1
  fi
done

# 検証: API URL が 127.0.0.1 形式か（localhost だと GoTrue site_url と不一致になる）
if ! grep -q '^NEXT_PUBLIC_SUPABASE_URL="\{0,1\}http://127\.0\.0\.1:54321' "$ENV_FILE"; then
  echo "error: NEXT_PUBLIC_SUPABASE_URL が http://127.0.0.1:54321 形式ではありません:" >&2
  grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" >&2
  exit 1
fi

echo "wrote ${ENV_FILE}:"
# 値はマスクして表示（service_role キー等の機密をログに残さない）
sed -E 's/=.*$/=***/' "$ENV_FILE"
