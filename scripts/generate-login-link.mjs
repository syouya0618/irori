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
 *   node scripts/generate-login-link.mjs <メールアドレス> [--env <path>]
 *
 * `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_APP_URL`
 * を、次の順で探す（先に見つかった方を使う）:
 *   ① 実行時の環境変数
 *   ② `--env` で指定したファイル
 *   ③ `.env.production.local` → `.env.local`
 *
 * ⚠️ **`.env.local` を本番の値で上書きせぬこと。** あれはローカル開発用
 * （ローカル Supabase 等）ゆえ、潰すと開発環境が壊れる。本番の値が要るなら
 * **別ファイルへ**引くこと:
 *
 *   vercel env pull .env.production.local --environment=production
 *   node scripts/generate-login-link.mjs <メールアドレス>
 *
 * ## ⚠️ どのプロジェクトを狙っておるかを必ず確かめよ
 *
 * ローカル Supabase の値で実行すると、**ローカル用のリンクが何食わぬ顔で出る**
 * ——本番では通らぬ。ゆえに生成前に対象の host を stderr へ出す。目で見よ。
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
 * env ファイルを読む。dotenv に依存せぬのは、このスクリプトを
 * `pnpm install` の状態に関わらず動かしたいゆえ（緊急時に使う道具じゃ）。
 */
function loadEnvFile(path) {
  let raw
  try {
    raw = readFileSync(resolve(process.cwd(), path), "utf8")
  } catch {
    return null
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

const args = process.argv.slice(2)
const envFileFlag = args.indexOf("--env")
const explicitEnvFile = envFileFlag !== -1 ? args[envFileFlag + 1] : null
const email = args.find((a) => a.includes("@") && !a.startsWith("-"))

if (!email) {
  note("使い方: node scripts/generate-login-link.mjs <メールアドレス> [--env <path>]")
  process.exit(1)
}
if (envFileFlag !== -1 && !explicitEnvFile) {
  note("❌ --env にパスが指定されておりませぬ")
  process.exit(1)
}

/**
 * 探索順。**本番用を先に見る**のが肝じゃ。
 *
 * `.env.local` はローカル開発用（ローカル Supabase を指す）ゆえ、そちらを先に
 * 読むと**ローカル向けのリンクが何食わぬ顔で生成される** —— 本番では通らぬのに、
 * 出力は成功に見える。最も質の悪い失敗ゆえ順序で殺す。
 */
const ENV_FILE_CANDIDATES = explicitEnvFile
  ? [explicitEnvFile]
  : [".env.production.local", ".env.local"]

let fileEnv = {}
let envFileUsed = null
for (const candidate of ENV_FILE_CANDIDATES) {
  const loaded = loadEnvFile(candidate)
  if (loaded) {
    fileEnv = loaded
    envFileUsed = candidate
    break
  }
}

if (explicitEnvFile && !envFileUsed) {
  note(`❌ --env で指定された ${explicitEnvFile} が読めませぬ`)
  process.exit(1)
}

/**
 * 値を解決する。**空文字は「無い」と同じに扱う。**
 *
 * `??` だけで繋ぐと、シェルに `FOO=` が空で export されておった場合に
 * **空文字が勝ってファイルの値を隠す** ——「ファイルに在るのに見つからぬ」という
 * 最も分かりにくい失敗になる。空を弾いてから次へ落とす。
 */
const env = (key) => {
  for (const candidate of [process["env"][key], fileEnv[key]]) {
    const value = (candidate ?? "").trim()
    if (value) return value
  }
  return ""
}

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
  note(`   読んだファイル: ${envFileUsed ?? "（見つからず）"}`)
  // ⚠️「キーは在るのに値が空」と「キーごと無い」は原因が全く違う（前者は
  // Vercel の Sensitive 指定で読み戻せておらぬ形）。**値は出さず**、
  // キーの有無と空か否かだけを見せて弁別できるようにする。
  for (const key of missing) {
    const present = Object.prototype.hasOwnProperty.call(fileEnv, key)
    note(
      `     - ${key}: ${
        present ? "キーは在るが値が空（Vercel の Sensitive 指定を疑え）" : "キーごと無い"
      }`
    )
  }
  note("")
  note("   本番の値は **development 環境には入っておらぬ**。必ず production を、")
  note("   しかも **別ファイルへ** 引くこと（.env.local はローカル開発用ゆえ潰すな）:")
  note("")
  note("     vercel env pull .env.production.local --environment=production")
  note("     node scripts/generate-login-link.mjs <メールアドレス>")
  process.exit(1)
}

/**
 * ⚠️ **狙う先を必ず目に見せる。**
 *
 * ローカル Supabase の値で実行すると、**ローカル向けのリンクが何食わぬ顔で出る**
 * ——本番では通らぬのに、出力は成功に見える。host は秘密ではないゆえ表示できる。
 */
const supabaseHost = (() => {
  try {
    return new URL(supabaseUrl).host
  } catch {
    return supabaseUrl
  }
})()
const looksLocal = /^(127\.0\.0\.1|localhost|\[::1\])/.test(supabaseHost)

note(`   env: ${envFileUsed ?? "（環境変数のみ）"}`)
note(`   Supabase: ${supabaseHost}`)
note(`   リンクの向き先: ${appUrl}`)
if (looksLocal) {
  note("")
  note("⚠️ **ローカルの Supabase を指しております。** このリンクは本番では通りませぬ。")
  note("   本番の値が要るなら:")
  note("     vercel env pull .env.production.local --environment=production")
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
