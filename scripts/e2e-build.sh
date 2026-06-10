#!/usr/bin/env bash
# E2E 用 Next.js 本番ビルド
#
# .env.e2e の値をシェル env として export してから `pnpm build` する。
# Next.js は「シェル env > .env.local」の優先順位のため、.env.local を
# 一切書き換えずにローカル Supabase スタック向けのビルドが作れる。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env.e2e ]; then
  echo "error: .env.e2e がありません。先に \`supabase start && pnpm e2e:env\` を実行してください。" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.e2e
set +a

pnpm build
