import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * ゴールデンパス E2E: 新規ユーザーの主要動線を 1 本で検証する。
 *
 * login → setup（世帯作成）→ 献立作成（食材つき）→ 買い物リストへ自動生成
 * → チェック（食品: 在庫対象外 / 衛生用品: 在庫自動追加）→ /stock で在庫反映
 *
 * ## フレーク対策の方針（時間ベースの sleep は使わない）
 * - 一覧への書き込み反映は Realtime 依存のため、書き込み後は reload して
 *   SSR 断面を assert する（#15 基盤の標準）
 * - full load 直後の click は React ハイドレーション完了前だと無反応になりうる。
 *   reload 後は reloadHydrated() で Supabase Realtime の WebSocket 接続
 *   （client component の useEffect 起点 = ハイドレーション完了後にしか起きない）
 *   を決定的シグナルとして待ってから操作する
 * - Sheet/Dialog のトリガーは openOverlay() で「開いていなければ click → 開きを待つ」
 *   を繰り返す（開いた後は再クリックしないため backdrop 誤クリックで閉じる事故もない）
 */

// 1 テストに full load + server action 往復が多数含まれるため、CI の
// cold path を考慮して上限を引き上げる（成功時の所要時間には影響しない）
test.setTimeout(180_000)

/**
 * 「今日」(Asia/Tokyo) の YYYY-MM-DD。
 * playwright.config.ts の timezoneId: "Asia/Tokyo" によりブラウザの
 * ローカル日付と一致するため、meal-week-view の data-testid
 * `meal-day-${formatDateKey(day)}` と同じ文字列になる
 * （src/lib/utils/date-jst.ts の todayJstString と同セマンティクス）。
 */
function todayJst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

/**
 * reload し、Supabase Realtime の WebSocket 接続まで待つ。
 * 必ず reload 前に listener を張る（reload 完了後に張ると、速いマシンでは
 * 接続イベントを取り逃して waitForEvent がタイムアウトする）。
 */
async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

/**
 * Sheet / Dialog を決定的に開く。
 * ハイドレーション前に click が無反応だった場合のみ再クリックする。
 */
async function openOverlay(
  trigger: Locator,
  readySignal: Locator
): Promise<void> {
  await expect(async () => {
    if (!(await readySignal.isVisible())) {
      await trigger.click({ timeout: 2_000 })
    }
    await expect(readySignal).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

test("golden path: login → 世帯作成 → 献立 → 買い物リスト → チェック → 在庫反映", async ({
  page,
  approvedUser,
}) => {
  const today = todayJst()

  // ── 1-2. login（Mailpit マジックリンク）→ 承認済み・世帯なし → /setup ──
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })

  // ── 3. 世帯作成 → /meals ───────────────────────────────────────────
  await page.getByLabel("世帯名").fill("E2Eゴールデンパス世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })

  // ── 4. 今日の行の夕食スロット → 「献立を追加」Sheet ─────────────────
  const todayRow = page.getByTestId(`meal-day-${today}`)
  await expect(todayRow).toBeVisible({ timeout: 15_000 })

  const sheetTitle = page.getByRole("heading", { name: "献立を追加" })
  await openOverlay(todayRow.getByTestId("empty-meal-slot-dinner"), sheetTitle)

  // ── 5. 「カレーライス」+ 食材「にんじん」を保存 ─────────────────────
  await page.getByLabel("メニュー名").fill("カレーライス")
  // 初回 open ではフォームの date/mealType state が props から再同期されない
  // （controlled open のため onOpenChange(true) 経由の setDate が走らず、
  //   マウント時の defaultDate="" が残る）。暗黙のデフォルトに依存せず
  // 日付と食事タイプを明示的に指定する（モーダル表示中は背景の同名
  // ボタンが aria-hidden になるため「夕食」は一意に解決できる）。
  await page.getByLabel("日付").fill(today)
  await page.getByRole("button", { name: "夕食", exact: true }).click()
  await page.getByRole("button", { name: "食材を追加" }).click()
  await page.getByPlaceholder("食材名").fill("にんじん")
  // カテゴリは既定（その他食品 = 食品カテゴリ → 在庫自動追加の対象外）のまま
  await page.getByRole("button", { name: "追加する", exact: true }).click()
  await expect(page.getByText("献立を追加しました")).toBeVisible()

  // 一覧反映は Realtime 依存のため、reload して SSR 断面を assert する
  // （今日の行の中に表示されることまで検証して日付の正しさも固定する）
  await reloadHydrated(page)
  await expect(
    page.getByTestId(`meal-day-${today}`).getByText("カレーライス")
  ).toBeVisible()

  // ── 6. BottomNav → /shopping ───────────────────────────────────────
  await page.getByRole("link", { name: "買い物" }).click()
  await expect(page).toHaveURL(/\/shopping/, { timeout: 15_000 })
  await expect(
    page.getByRole("heading", { name: "買い物リスト" })
  ).toBeVisible()

  // ── 7. 「献立から追加」→ にんじんが買い物リストへ ───────────────────
  const generateDialogTitle = page.getByRole("heading", {
    name: "献立から食材を追加",
  })
  await openOverlay(
    page.getByRole("button", { name: "献立から追加" }),
    generateDialogTitle
  )

  // 追加ボタンは preview (previewMealIngredients) 完了まで disabled
  const generateConfirm = page
    .getByRole("dialog")
    .getByRole("button", { name: "追加する", exact: true })
  await expect(generateConfirm).toBeEnabled({ timeout: 15_000 })
  await generateConfirm.click()
  await expect(page.getByText("1件の食材を追加しました")).toBeVisible()

  await reloadHydrated(page)
  await expect(page.getByText("にんじん", { exact: true })).toBeVisible()

  // ── 8. 「にんじん」をチェック → 楽観更新で打ち消し線 ────────────────
  // 食品カテゴリは auto_stock_categories 既定 ["baby","cleaning","hygiene"]
  // の対象外なので、在庫追加 toast は出ない（出ないことが正しい挙動）
  await page.getByRole("button", { name: "にんじんをチェック" }).click()
  // チェック済みアイテムは折り畳みセクションへ移動する（楽観更新で即時）
  await page.getByRole("button", { name: "チェック済み (1件)" }).click()
  await expect(page.getByText("にんじん", { exact: true })).toHaveClass(
    /line-through/
  )

  // ── 9. 手動追加: 「ティッシュ」（カテゴリ: 衛生用品）────────────────
  const addInput = page.getByPlaceholder("アイテムを追加...")
  await addInput.fill("ティッシュ")
  await page.getByRole("button", { name: "オプションを開く" }).click()
  // オプション行の 1 つ目の Select がカテゴリ、2 つ目が購入先
  // （Base UI の Select.Trigger は role="combobox"）
  await page.getByRole("combobox").first().click()
  await page.getByRole("option", { name: "衛生用品" }).click()
  await page.getByRole("button", { name: "追加", exact: true }).click()
  // 成功時のみ入力値がクリアされる（決定的な成功シグナル）
  await expect(addInput).toHaveValue("")

  await reloadHydrated(page)
  await expect(page.getByText("ティッシュ", { exact: true })).toBeVisible()

  // ── 10. 「ティッシュ」をチェック → 在庫自動追加 toast ───────────────
  // hygiene は auto_stock_categories 既定の対象 → この toast が在庫連携の証拠
  await page.getByRole("button", { name: "ティッシュをチェック" }).click()
  await expect(
    page.getByText("ティッシュを在庫に追加しました")
  ).toBeVisible()

  // ── 11. BottomNav → /stock で在庫反映を確認（SSR 直読みで決定的）────
  await page.getByRole("link", { name: "在庫" }).click()
  await expect(page).toHaveURL(/\/stock/, { timeout: 15_000 })
  await expect(page.getByText("ティッシュ", { exact: true })).toBeVisible()

  // ── 12. teardown は fixtures/test.ts の approvedUser が世帯ごと削除 ──
})
