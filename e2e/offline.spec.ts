import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * オフライン E2E: PWA DoD「オンラインで訪問済みの /meals /shopping /stock /baby の
 * 直近データがオフラインで閲覧できる」を Service Worker (public/sw.js) 込みで検証する。
 *
 * ## 前提
 * - SW は production build でのみ register される (service-worker-manager.tsx)。
 *   `pnpm e2e:build` → `next start` の経路 (playwright.config.ts の webServer) が前提。
 *   dev サーバーでは SW なしで全 assert が落ちるため E2E_OFFLINE=1 の明示 opt-in 制にする。
 *
 * ## setOffline × Service Worker の判別実験 (2026-06-10 実測)
 * CDP の Offline エミュレーションが SW 内部の fetch() に効かなかった実測が過去にあるため
 * (learnings 2026-06-10)、Playwright の context.setOffline(true) で実証した:
 * オンラインで SW を warmup → setOffline(true) → 一度も訪問していない APP_PAGE
 * (/settings) へハードナビゲーションした結果、SW の network-first fetch が失敗して
 * /offline フォールバック (h1「オフラインです」) が表示された。
 * = setOffline は SW 内部の fetch にも効く (Chromium の network emulation は
 * SW の subresource fetch を含むコンテキスト全体に適用される)。
 * 本テストの「未訪問ページ → /offline フォールバック」ステップは、この前提が
 * Playwright 更新で崩れた場合に静かに素通りせず、ここで落ちる恒久回帰チェックを兼ねる。
 */

// SW は production build 前提のため明示 opt-in (CI の e2e.yml は常時 E2E_OFFLINE=1)
test.skip(
  !process.env.E2E_OFFLINE,
  "E2E_OFFLINE=1 のときのみ実行 (production build + Service Worker が前提)"
)

// public/sw.js の CACHE_NAMES と手動同期 (CACHE_VERSION bump 時はここも更新する)
const DOCUMENTS_CACHE = "irori-v1-documents"
const PRECACHE = "irori-v1-precache"

// UI の静的文言と衝突しない一意なテストデータ名
const MEAL_TITLE = "E2Eオフライン献立カレー"
const SHOPPING_ITEM = "E2Eオフライン牛乳"
const STOCK_ITEM = "E2Eオフライン米"

const OFFLINE_BANNER_TEXT =
  "オフラインです。表示中の内容は最新でない可能性があります"

/**
 * Supabase error は plain object のため明示的にフィールドを抽出してログする
 * (String(err) だと "[object Object]" に化ける)。
 */
function formatError(error: {
  message?: string
  code?: string
  details?: string
  hint?: string
} | null): string {
  if (!error) return "(no error object)"
  return JSON.stringify({
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
  })
}

/**
 * 「今日」(Asia/Tokyo) の YYYY-MM-DD。
 * /meals の週範囲はサーバー側で JST 固定 (date-jst.ts の currentWeekRangeJst)
 * 計算になったため、runner プロセスの TZ (CI は UTC) に依存しない
 * Intl Asia/Tokyo 方式で揃える (golden-path.spec.ts の todayJst と同セマンティクス)。
 * これで「今日」は常に JST の今週 (月〜日) に含まれる。
 */
function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

/** service_role で 1 行 insert し、行が返ることまで検証する (silent fail 防止) */
async function insertRow(
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  const { data, error } = await adminClient()
    .from(table)
    .insert(row)
    .select("id")
    .single()
  if (error || !data) {
    throw new Error(`${table} insert failed: ${formatError(error)}`)
  }
}

test("オンラインで訪問済みの 4 画面がオフラインで閲覧できる", async ({
  page,
  context,
  approvedUser,
}) => {
  // 巡回 12 回 + マジックリンクログインを含むため既定 60s から延長する
  test.setTimeout(120_000)

  // ── 1. 世帯 + テストデータを service_role で直 insert (決定性優先) ──
  // 世帯作成 UI (/setup) は smoke spec が検証済み。ここでは前提データとして
  // service_role で作成し、fixture の teardown (profiles.household_id 参照 →
  // households 削除 → 各テーブルへ ON DELETE CASCADE) で丸ごと回収される。
  const admin = adminClient()

  const { data: household, error: householdError } = await admin
    .from("households")
    .insert({ name: "E2Eオフライン世帯" })
    .select("id")
    .single()
  if (householdError || !household) {
    throw new Error(`households insert failed: ${formatError(householdError)}`)
  }
  const householdId = household.id as string

  // profiles へ世帯を紐付け (service_role は authenticated 向け列 GRANT 制限の対象外)。
  // .update() は 0 行更新でも error: null のため .select().single() で行数を検証する。
  const { data: linked, error: linkError } = await admin
    .from("profiles")
    .update({ household_id: householdId, role: "owner" })
    .eq("id", approvedUser.id)
    .select("id")
    .single()
  if (linkError || !linked) {
    throw new Error(`profiles link failed: ${formatError(linkError)}`)
  }

  // RLS スコープ = 上で紐付けた household を指す 3 件 (各画面 1 件ずつ)
  await insertRow("meals", {
    household_id: householdId,
    date: todayKey(),
    meal_type: "dinner",
    title: MEAL_TITLE,
    created_by: approvedUser.id,
  })
  await insertRow("shopping_items", {
    household_id: householdId,
    name: SHOPPING_ITEM,
    created_by: approvedUser.id,
  })
  await insertRow("stock_items", {
    household_id: householdId,
    name: STOCK_ITEM,
    quantity: 1,
    unit: "袋",
    created_by: approvedUser.id,
  })

  // ── 2. 実ログイン (signInWithOtp → Mailpit → /auth/callback) ──
  await loginViaMagicLink(page, approvedUser.email)

  // ── 3. SW の register → activate → controlled 化を待つ ──
  await page.goto("/meals")
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return !!registration?.active
    },
    undefined,
    { timeout: 15_000 }
  )
  // activate 直後の clients.claim() を信頼せず、reload で確実に controlled にする
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)

  // install 時 precache の /offline 格納を待つ (未訪問ページ判定の前提条件)
  await page.waitForFunction(
    async (cacheName) => {
      const cache = await caches.open(cacheName)
      return !!(await cache.match("/offline"))
    },
    PRECACHE,
    { timeout: 15_000 }
  )

  // ── 4. 4 画面をオンラインで巡回して documents キャッシュを温める ──
  // 各画面で「投入データが見える」ことと「documents キャッシュに格納された」ことを確認。
  // キャッシュキーは makeCacheKey (sw.js) が _rsc クエリのみ除去した完全 URL。
  // ハードナビゲーションにクエリは付かないため `origin + path` がそのままキーになる。
  const pages: { path: string; assertContent: () => Promise<void> }[] = [
    {
      path: "/meals",
      assertContent: () => expect(page.getByText(MEAL_TITLE)).toBeVisible(),
    },
    {
      path: "/shopping",
      assertContent: () => expect(page.getByText(SHOPPING_ITEM)).toBeVisible(),
    },
    {
      path: "/stock",
      assertContent: () => expect(page.getByText(STOCK_ITEM)).toBeVisible(),
    },
    {
      // baby はログ未投入のため骨格 (クイックアクション) を検証する
      path: "/baby",
      assertContent: () =>
        expect(
          page.getByRole("button", { name: "ミルク", exact: true })
        ).toBeVisible(),
    },
  ]

  for (const { path, assertContent } of pages) {
    await page.goto(path)
    await assertContent()
    await page.waitForFunction(
      async ({ cacheName, pagePath }) => {
        const cache = await caches.open(cacheName)
        const key = new URL(pagePath, location.origin).href
        return !!(await cache.match(key))
      },
      { cacheName: DOCUMENTS_CACHE, pagePath: path },
      { timeout: 15_000 }
    )
  }

  // ── 5. 判別ステップ (恒久回帰チェック): オフライン化が SW の fetch に効いているか ──
  // 未訪問の APP_PAGE (/settings) へハードナビ → SW の network-first が失敗し、
  // documents キャッシュも無いので /offline フォールバックが表示されるはず。
  // setOffline が SW に効かなくなった場合は新鮮な /settings が表示されてここで落ちる。
  await context.setOffline(true)
  await page.goto("/settings")
  await expect(
    page.getByRole("heading", { name: "オフラインです" })
  ).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/settings")

  // ── 6. 温めた 4 画面をオフラインのままハードナビで再訪問 ──
  // SW の handleDocument が documents キャッシュからスナップショット HTML を返す。
  for (const { path, assertContent } of pages) {
    await page.goto(path)
    await assertContent()
  }

  // ── 7. オフラインバナー (navigator.onLine 連動) の表示 ──
  await expect(page.getByText(OFFLINE_BANNER_TEXT)).toBeVisible()

  // ── 8. オンライン復帰 → reload で通常表示に戻る ──
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByText(OFFLINE_BANNER_TEXT)).toBeHidden()
  // ネットワーク経由の新鮮な SSR でも骨格が表示される (最後の巡回ページ = /baby)
  await expect(
    page.getByRole("button", { name: "ミルク", exact: true })
  ).toBeVisible()

  // teardown は fixture (approvedUser) が household ごと削除する
})
