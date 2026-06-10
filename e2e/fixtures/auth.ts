/**
 * E2E 認証ヘルパー（Mailpit 経由のマジックリンクログイン）
 *
 * ## なぜ admin.generateLink を使わないか（回帰防止メモ）
 *
 * `admin.auth.admin.generateLink({ type: "magiclink" })` は PKCE 非対応で、
 * action_link を踏むと GoTrue は implicit flow のフラグメント
 * (`#access_token=...`) を返す。本アプリの /auth/callback は `?code=` クエリ
 * しか処理しない（フラグメントはサーバーに届かない）ため、この経路では
 * 絶対にログインできない（調査済み・確定）。
 *
 * よって「実ログイン UI で signInWithOtp → Mailpit API でメール本文から
 * verify リンクを取得 → page.goto(リンク)」という実ユーザーと同一の経路を使う。
 * signInWithOtp が code_verifier を Cookie に保存し、/auth/callback?code= の
 * exchangeCodeForSession が同じブラウザコンテキストでそれを参照する。
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { expect, type Page } from "@playwright/test"
import { loadE2eEnv } from "./env"

const MAILPIT_URL = "http://127.0.0.1:54324"
const MAILPIT_POLL_INTERVAL_MS = 500
const MAILPIT_POLL_TIMEOUT_MS = 15_000
const FETCH_TIMEOUT_MS = 5_000

export interface E2eUser {
  id: string
  email: string
}

/**
 * Supabase error は plain object / message 非列挙の class で、
 * `String(err)` だと "[object Object]" に化けるため明示的にフィールドを抽出する。
 */
function formatSupabaseError(error: {
  message?: string
  code?: string
  details?: string
  hint?: string
  status?: number
} | null): string {
  if (!error) return "(no error object)"
  return JSON.stringify({
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
    status: error.status,
  })
}

let cachedAdminClient: SupabaseClient | null = null

/** service_role キーで動く管理クライアント（RLS バイパス）。 */
export function adminClient(): SupabaseClient {
  if (cachedAdminClient) return cachedAdminClient

  const env = loadE2eEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error(
      ".env.e2e に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY がありません。`pnpm e2e:env` を再実行してください。"
    )
  }

  cachedAdminClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return cachedAdminClient
}

/** worker ごと・実行ごとに一意なテスト用メールアドレス。 */
export function uniqueEmail(workerIndex: number): string {
  return `e2e-w${workerIndex}-${Date.now()}@example.com`
}

/**
 * 承認済みユーザーを作成する。
 * handle_new_user トリガが profiles を is_approved=false で作るため、
 * service_role で is_approved=true に更新する（承認フローのバイパス）。
 */
export async function createApprovedUser(email: string): Promise<E2eUser> {
  const admin = adminClient()

  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  })
  if (error || !data.user) {
    throw new Error(
      `createUser failed for ${email}: ${formatSupabaseError(error)}`
    )
  }
  const userId = data.user.id

  // .update() は 0 行更新でも error: null のため .select().single() で行数を検証する
  const { data: updated, error: updateError } = await admin
    .from("profiles")
    .update({ is_approved: true })
    .eq("id", userId)
    .select("id")
    .single()
  if (updateError || !updated) {
    throw new Error(
      `profiles approve failed for ${userId}: ${formatSupabaseError(updateError)}`
    )
  }

  return { id: userId, email }
}

/**
 * テストユーザーと（あれば）世帯を削除する。best-effort:
 * クリーンアップ失敗でテスト自体は落とさない（console.warn のみ）。
 */
export async function cleanupUser(
  userId: string,
  householdId?: string
): Promise<void> {
  const admin = adminClient()
  try {
    if (householdId) {
      const { error: householdError } = await admin
        .from("households")
        .delete()
        .eq("id", householdId)
      if (householdError) {
        console.warn(
          `[e2e cleanup] households delete failed (${householdId}): ${formatSupabaseError(householdError)}`
        )
      }
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(userId)
    if (deleteError) {
      console.warn(
        `[e2e cleanup] deleteUser failed (${userId}): ${formatSupabaseError(deleteError)}`
      )
    }
  } catch (err) {
    console.warn(`[e2e cleanup] unexpected error (${userId}):`, err)
  }
}

interface MailpitSearchMessage {
  ID: string
  Created: string
}

interface MailpitSearchResponse {
  messages: MailpitSearchMessage[]
}

interface MailpitMessageDetail {
  Text?: string
  HTML?: string
}

const VERIFY_LINK_PATTERN =
  /http:\/\/127\.0\.0\.1:54321\/auth\/v1\/verify\?[^\s"<\]]+/

async function fetchJson<T>(url: string): Promise<T> {
  // 外部 API 呼び出しのためタイムアウト必須
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`Mailpit API error: ${response.status} ${url}`)
  }
  return (await response.json()) as T
}

function extractVerifyLink(detail: MailpitMessageDetail): string | null {
  const fromText = detail.Text?.match(VERIFY_LINK_PATTERN)
  if (fromText) return fromText[0]

  // HTML パートでは & が &amp; にエスケープされているため戻してから抽出する
  const fromHtml = detail.HTML?.replace(/&amp;/g, "&").match(
    VERIFY_LINK_PATTERN
  )
  if (fromHtml) return fromHtml[0]

  return null
}

/**
 * Mailpit からマジックリンク（GoTrue verify URL）を取得する。
 * sentAfterMs 以前の古いメールは無視し、500ms 間隔で最大 15 秒ポーリングする。
 */
export async function fetchMagicLink(
  email: string,
  sentAfterMs: number
): Promise<string> {
  const query = encodeURIComponent(`to:"${email}"`)
  const searchUrl = `${MAILPIT_URL}/api/v1/search?query=${query}`
  const deadline = Date.now() + MAILPIT_POLL_TIMEOUT_MS

  // Mailpit 側のタイムスタンプ丸め誤差を吸収する小さなマージン
  const createdAfterMs = sentAfterMs - 2_000

  while (Date.now() < deadline) {
    const result = await fetchJson<MailpitSearchResponse>(searchUrl)
    // Mailpit 公式 doc は検索結果の sort 順を保証していないため、
    // 「先頭 = 最新」を仮定せず Created 降順に明示 sort してから先頭を取る
    const latest = [...(result.messages ?? [])].sort(
      (a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime()
    )[0]

    if (latest && new Date(latest.Created).getTime() >= createdAfterMs) {
      const detail = await fetchJson<MailpitMessageDetail>(
        `${MAILPIT_URL}/api/v1/message/${latest.ID}`
      )
      const link = extractVerifyLink(detail)
      if (link) return link
    }

    await new Promise((resolve) =>
      setTimeout(resolve, MAILPIT_POLL_INTERVAL_MS)
    )
  }

  throw new Error(
    `Magic link mail for ${email} not found in Mailpit within ${MAILPIT_POLL_TIMEOUT_MS}ms (${searchUrl})`
  )
}

/**
 * 実ログイン UI からマジックリンクログインを行う。
 * /login → メール送信 → Mailpit からリンク取得 → リンクへ遷移（/auth/callback?code= 経由）。
 */
export async function loginViaMagicLink(
  page: Page,
  email: string
): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("メールアドレス").fill(email)

  const sentAtMs = Date.now()
  await page.getByRole("button", { name: "マジックリンクを送信" }).click()
  await expect(
    page.getByRole("heading", { name: "メールを送信しました" })
  ).toBeVisible()

  const link = await fetchMagicLink(email, sentAtMs)
  await page.goto(link)

  // issue #16 修正済み: callback の origin は getAppOrigin（NEXT_PUBLIC_APP_URL
  // 優先、e2e build では http://127.0.0.1:3000）で解決されるため、Location は
  // 127.0.0.1 を維持する。Next.js には NextRequest の loopback host を
  // localhost に正規化する仕様 (next/dist/server/web/next-url.js の
  // REGEX_LOCALHOST_HOSTNAME) があり、localhost への回帰をここで機械検証する。
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:3000\//)
  // 防御として残置: 仕様変更等で origin が揺れても baseURL へ冪等に帰還する。
  await page.goto("/")
}
