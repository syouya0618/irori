import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * オフライン E2E: PWA DoD「オンラインで訪問済みの /baby /calendar /settings の
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
 * へハードナビゲーションした結果、SW の network-first fetch が失敗して
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
const BABY_MEMO = "E2Eオフラインメモ"
const CALENDAR_TITLE = "E2Eオフライン予定"

const OFFLINE_BANNER_TEXT =
  "オフラインです。表示中の内容は最新でない可能性があります"

// B-07: 圏外で記録タップ → Server Action が reject。ハンドラの try/catch が握って
// 圏外トーストを出し、error boundary (src/app/(main)/baby/error.tsx = 下記見出し)
// へ全画面遷移しないことを検証する。
// 文言は src/lib/utils/offline-error.ts の OFFLINE_ERROR_MESSAGE と手動同期。
const OFFLINE_ACTION_TOAST =
  "通信できませんでした。電波の良い場所でもう一度お試しください"
const BABY_ERROR_BOUNDARY_HEADING = "育児ログの読み込みに失敗しました"

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
 * /baby の選択日と /calendar のアジェンダはサーバー側で JST 固定
 * (date-jst.ts) 計算になっているため、runner プロセスの TZ (CI は UTC) に
 * 依存しない Intl Asia/Tokyo 方式で揃える (calendar.spec.ts の todayJst と
 * 同セマンティクス)。
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

test("オンラインで訪問済みの 3 画面がオフラインで閲覧できる", async ({
  page,
  context,
  approvedUser,
}) => {
  // 巡回 + マジックリンクログインを含むため既定 60s から延長する
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

  // RLS スコープ = 上で紐付けた household を指す 2 件 (/baby と /calendar に 1 件ずつ)。
  // /settings はデータ無しでも見出しが描画される。
  // baby_logs の memo 行: タイムラインが memo 本文をそのまま描く
  // (baby-timeline-item.tsx)。logged_at は既定 now() = 今日ゆえ選択日 (今日) に載る。
  await insertRow("baby_logs", {
    household_id: householdId,
    log_type: "memo",
    logged_by: approvedUser.id,
    memo: BABY_MEMO,
  })
  // calendar_events の native 終日行: 今日に置けばアジェンダ (選択日 = 今日) に出る。
  const today = todayKey()
  await insertRow("calendar_events", {
    household_id: householdId,
    title: CALENDAR_TITLE,
    is_all_day: true,
    start_date: today,
    end_date: today,
    source: "native",
  })

  // ── 2. 実ログイン (signInWithOtp → Mailpit → /auth/callback) ──
  await loginViaMagicLink(page, approvedUser.email)

  // ── 3. SW の register → activate → controlled 化を待つ ──
  await page.goto("/baby")
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

  // ── 4. 判別ステップ (恒久回帰チェック): オフライン化が SW の fetch に効いているか ──
  // 未訪問の APP_PAGE (/settings) へハードナビ → SW の network-first が失敗し、
  // documents キャッシュも無いので /offline フォールバックが表示されるはず。
  // setOffline が SW に効かなくなった場合は新鮮な /settings が表示されてここで落ちる。
  // ⚠️ /settings は後で巡回に含めるゆえ、温める**前**にここで撃つ。
  await context.setOffline(true)
  await page.goto("/settings")
  await expect(
    page.getByRole("heading", { name: "オフラインです" })
  ).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/settings")
  await context.setOffline(false)

  // ── 5. 3 画面をオンラインで巡回して documents キャッシュを温める ──
  // 各画面で「投入データ (または骨格) が見える」ことと「documents キャッシュに
  // 格納された」ことを確認。キャッシュキーは makeDocumentCacheKey (sw.js) が
  // _rsc / date クエリを除去した完全 URL。ハードナビゲーションにクエリは付かない
  // ため `origin + path` がそのままキーになる。
  const pages: { path: string; assertContent: () => Promise<void> }[] = [
    {
      path: "/baby",
      assertContent: () => expect(page.getByText(BABY_MEMO)).toBeVisible(),
    },
    {
      path: "/calendar",
      assertContent: () =>
        expect(page.getByText(CALENDAR_TITLE).first()).toBeVisible(),
    },
    {
      // settings は世帯データに依らず描画される骨格 (見出し「設定」) を検証する
      path: "/settings",
      assertContent: () =>
        expect(page.getByRole("heading", { name: "設定" })).toBeVisible(),
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

  // ── 6. 温めた 3 画面をオフラインのままハードナビで再訪問 ──
  // SW の handleDocument が documents キャッシュからスナップショット HTML を返す。
  await context.setOffline(true)
  for (const { path, assertContent } of pages) {
    await page.goto(path)
    await assertContent()
    await expect(
      page.getByRole("heading", { name: "オフラインです" })
    ).not.toBeVisible()
  }

  // ── 7. オフラインバナー (navigator.onLine 連動) の表示 ──
  await expect(page.getByText(OFFLINE_BANNER_TEXT)).toBeVisible()

  // ── 8. オンライン復帰 → reload で通常表示に戻る ──
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByText(OFFLINE_BANNER_TEXT)).toBeHidden()
  // ネットワーク経由の新鮮な SSR でも骨格が表示される (最後の巡回ページ = /settings)
  await expect(page.getByRole("heading", { name: "設定" })).toBeVisible()

  // teardown は fixture (approvedUser) が household ごと削除する
})

test("圏外で /baby のおしっこをタップ → 圏外トースト・error boundary へ落ちない", async ({
  page,
  context,
  approvedUser,
}) => {
  // SW warmup + マジックリンクログインを含むため既定 60s から延長する
  test.setTimeout(90_000)

  // B-07 / I-02: startTransition 内で Server Action が reject すると、未処理の
  // reject は最寄りの error boundary へ bubble する
  // (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375)。
  // 圏外タップのたびに画面ごとエラー化し、記録も無言で失われる袋小路になるため、
  // ハンドラの try/catch が握って圏外トースト (offline-error.ts) へ倒す契約を
  // /baby のクイックアクションで固定する。
  // route abort ではなく context.setOffline(true) を使うのは本ファイルの既存流儀
  // （SW の fetch にも効くことを冒頭コメントの判別実験で実証済み）。

  // ── 1. 世帯を service_role で直 insert (baby ページはログ 0 件でも描画される) ──
  const admin = adminClient()

  const { data: household, error: householdError } = await admin
    .from("households")
    .insert({ name: "E2Eオフライン世帯(baby reject)" })
    .select("id")
    .single()
  if (householdError || !household) {
    throw new Error(`households insert failed: ${formatError(householdError)}`)
  }
  const householdId = household.id as string

  const { data: linked, error: linkError } = await admin
    .from("profiles")
    .update({ household_id: householdId, role: "owner" })
    .eq("id", approvedUser.id)
    .select("id")
    .single()
  if (linkError || !linked) {
    throw new Error(`profiles link failed: ${formatError(linkError)}`)
  }

  // ── 2. 実ログイン ──
  await loginViaMagicLink(page, approvedUser.email)

  // ── 3. SW の register → activate → controlled 化を待つ ──
  await page.goto("/baby")
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return !!registration?.active
    },
    undefined,
    { timeout: 15_000 }
  )
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)

  // ── 4. /baby をオンラインで訪問して documents キャッシュを温める ──
  // ログ未投入でも描画される骨格要素 (クイックアクション「ミルク」) で内容を確認する。
  await page.goto("/baby")
  await expect(
    page.getByRole("button", { name: "ミルク", exact: true })
  ).toBeVisible()
  await page.waitForFunction(
    async ({ cacheName, pagePath }) => {
      const cache = await caches.open(cacheName)
      const key = new URL(pagePath, location.origin).href
      return !!(await cache.match(key))
    },
    { cacheName: DOCUMENTS_CACHE, pagePath: "/baby" },
    { timeout: 15_000 }
  )

  // ── 5. オフライン化 → キャッシュから /baby を表示 ──
  await context.setOffline(true)
  await page.goto("/baby")
  await expect(
    page.getByRole("button", { name: "ミルク", exact: true })
  ).toBeVisible()

  // ── 6. 圏外でおむつ「おしっこ」をタップ → Server Action が reject ──
  // full load 直後の click は React ハイドレーション完了前だと無反応になりうるため、
  // 「トースト未表示なら click」を toPass で再試行する。オフラインゆえ再タップしても
  // Server Action はサーバへ到達せず（DB 書き込みは起きず）トーストが出るだけで安全。
  const diaperButton = page.getByRole("button", { name: "おしっこ", exact: true })
  const offlineToast = page.getByText(OFFLINE_ACTION_TOAST)
  await expect(async () => {
    if (!(await offlineToast.isVisible())) {
      await diaperButton.click({ timeout: 2_000 })
    }
    await expect(offlineToast).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })

  // error boundary の全画面フォールバック見出し (ErrorView は <h2>) は出ない
  await expect(
    page.getByRole("heading", { name: BABY_ERROR_BOUNDARY_HEADING })
  ).toHaveCount(0)
  // 画面は /baby のまま、操作 UI（ミルクボタン）も生きている
  expect(new URL(page.url()).pathname).toBe("/baby")
  await expect(
    page.getByRole("button", { name: "ミルク", exact: true })
  ).toBeVisible()

  await context.setOffline(false)

  // teardown は fixture (approvedUser) が household ごと削除する
})
