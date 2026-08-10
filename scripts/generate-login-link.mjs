#!/usr/bin/env node
/**
 * **メールを使わずにログインリンクを生成する**（緊急用の逃げ道）。
 *
 * ## なぜ要るか
 *
 * Supabase の組込みメールは **1 時間に 2 通**しか送れず、組込みのままでは上げ
 * られぬ（公式: "2 emails per hour with the built-in email provider" /
 * "You can only change this with a custom SMTP setup."）。夫婦二人で押し合えば
 * 即座に尽き、**ログアウトした側が戻れなくなる**。2026-08-10 に実際に起きた。
 *
 * このスクリプトは管理者（サービスロールキーを持つ者）の手元でリンクを生成する。
 * **メールは 1 通も使わぬ。** 生成したリンクは LINE 等で直接渡せばよい。
 *
 * ## 使い方
 *
 *   node scripts/generate-login-link.mjs <メールアドレス>
 *
 * `.env.local` から `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` /
 * `NEXT_PUBLIC_APP_URL` を読む（環境変数が既にあればそちらを優先）。
 *
 * ## ⚠️ 出力の扱い
 *
 * - **stdout に出るのは URL 1 行だけ**じゃ。注意書きは全て stderr へ出す
 *   ——混ぜると、そのまま貼った時に URL が壊れる（PR #741 で焼いた教訓）。
 * - 生成される URL は**使い切りの資格情報**じゃ。持つ者は誰でもその
 *   アカウントとしてログインできる。使うか期限が切れるまで秘密として扱え。
 * - **サービスロールキーは絶対に出力せぬ。**
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createClient } from "@supabase/supabase-js"

/** stdout を汚さぬための出力口（URL 以外は全てこちら） */
const note = (...args) => console.error(...args)

/**
 * `.env.local` を読む。dotenv に依存せぬのは、このスクリプトを
 * `pnpm install` の状態に関わらず動かしたいゆえ（緊急時に使う道具じゃ）。
 */
function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local")
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return {}
  }
  const out = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // クォートは剥がす。値は**絶対に出力せぬ**
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const email = process.argv[2]
if (!email || !email.includes("@")) {
  note("使い方: node scripts/generate-login-link.mjs <メールアドレス>")
  process.exit(1)
}

const fileEnv = loadEnvLocal()
const env = (key) => (process["env"][key] ?? fileEnv[key] ?? "").trim()

const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL")
const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY")
const appUrl = env("NEXT_PUBLIC_APP_URL")

const missing = [
  !supabaseUrl && "NEXT_PUBLIC_SUPABASE_URL",
  !serviceRoleKey && "SUPABASE_SERVICE_ROLE_KEY",
  !appUrl && "NEXT_PUBLIC_APP_URL",
].filter(Boolean)

if (missing.length > 0) {
  note(`❌ 次の値が見つかりませぬ: ${missing.join(", ")}`)
  note("   .env.local に在るか、環境変数として渡してくりゃれ。")
  note("   （Vercel から取るなら: vercel env pull .env.local）")
  process.exit(1)
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// `magiclink` は**既存ユーザー専用**じゃ。存在せぬアドレスならここで落ちる
// ——「知らぬ間に新しいアカウントが増える」ことを構造的に防いでおる。
const { data, error } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email,
})

if (error) {
  // Supabase の error は plain object ゆえフィールドを明示的に取り出す
  note("❌ リンクの生成に失敗しました", {
    message: error.message,
    code: error.code,
    status: error.status,
  })
  if (error.status === 422 || /not found/i.test(error.message ?? "")) {
    note("   → そのアドレスのユーザーが存在せぬ可能性があります。")
  }
  process.exit(1)
}

const tokenHash = data?.properties?.hashed_token
if (!tokenHash) {
  note("❌ hashed_token が返りませんでした（想定外）。Supabase の応答形式を確認してくりゃれ。")
  process.exit(1)
}

// ⚠️ `properties.action_link` は使わぬ。あちらは GoTrue の /auth/v1/verify を
// 指しており、implicit flow の `#access_token=...` を返す ——このアプリの
// 着地点はフラグメントを読めぬ（サーバに届かぬ）ゆえ、必ず失敗する。
// `token_hash` を自前の /auth/confirm へ渡す形だけが通る。
const link = `${appUrl.replace(/\/$/, "")}/auth/confirm?token_hash=${encodeURIComponent(
  tokenHash
)}&type=magiclink`

note("")
note(`✅ ${email} のログインリンクを生成しました（メールは使っておりませぬ）`)
note("")
note("⚠️ このリンクは**使い切りの資格情報**です。持つ者は誰でもこのアカウントとして")
note("   ログインできます。本人へ直接渡し、使うまでは秘密として扱ってくりゃれ。")
note("   一度使うか期限が切れれば無効になります。")
note("")

// stdout に出すのは URL 1 行だけ（貼り付けを壊さぬため）
console.log(link)
