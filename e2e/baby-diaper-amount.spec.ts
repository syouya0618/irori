import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * うんちの量（poop_amount）E2E。
 *
 * login → 世帯作成 → /baby → おむつ「うんち」→ 2 段目「大量」→ タイムラインに
 * 「うんち（大量）」→ DB 行に poop_amount='large' → reload しても残る
 * → 記録行をタップ → 編集シートで「大量」が選択済み → 「少量」へ変えて更新
 * → DB 行が 'small' へ → 続けて「おしっこ」は 1 タップで記録され poop_amount は NULL。
 *
 * ## なぜ DB 断面まで見るか
 * UI の「うんち（大量）」は楽観 append でも同じに見える。永続化の証拠は service_role の
 * 直読み（reload 後の SSR 断面 + DB 行）で固定する。
 *
 * ## フレーク対策（baby-feeding-cycle.spec.ts と同じ流儀）
 * - 時間ベースの sleep は使わず DB 断面を poll して同期する
 * - Sheet の open は openOverlay（退場中シートの消滅を待ってから click）
 * - シート内のロケータは開いているシート（[data-open]）へスコープする
 */

test.setTimeout(180_000)

/**
 * reload し、Supabase Realtime の WebSocket 接続まで待つ（listener は reload 前に張る）。
 */
async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

/** Sheet / Dialog を決定的に開く（calendar.spec.ts / baby-feeding-cycle.spec.ts と同一実装）。 */
async function openOverlay(
  trigger: Locator,
  readySignal: Locator
): Promise<void> {
  await expect(
    trigger.page().locator('[data-slot="sheet-content"]:not([data-open])')
  ).toHaveCount(0, { timeout: 10_000 })
  await expect(async () => {
    if (!(await readySignal.isVisible())) {
      await trigger.click({ timeout: 2_000 })
    }
    await expect(readySignal).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

/** approvedUser の世帯 ID を DB 断面で待つ（世帯作成 server action の完了同期点）。 */
async function waitForHouseholdId(userId: string): Promise<string> {
  const admin = adminClient()
  let householdId = ""
  await expect(async () => {
    const { data: profile, error } = await admin
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()
    if (error) throw new Error(`profile lookup failed: ${error.message}`)
    if (!profile?.household_id) throw new Error("household not ready")
    householdId = profile.household_id
  }).toPass({ timeout: 15_000 })
  return householdId
}

interface DiaperRow {
  id: string
  diaper_type: string | null
  poop_amount: string | null
}

/**
 * おむつ行が `expectedCount` 件になるのを DB 断面で待ち、diaper_type 昇順で返す。
 * 二重記録（再タップ）が無いことも同時に固定する。
 */
async function waitForDiaperRows(
  householdId: string,
  expectedCount: number
): Promise<DiaperRow[]> {
  const admin = adminClient()
  const captured: DiaperRow[] = []
  await expect(async () => {
    const { data, error } = await admin
      .from("baby_logs")
      .select("id, diaper_type, poop_amount")
      .eq("household_id", householdId)
      .eq("log_type", "diaper")
      .order("logged_at", { ascending: true })
    if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
    if (!data || data.length !== expectedCount)
      throw new Error(
        `expected ${expectedCount} diaper rows, got ${data?.length ?? 0}`
      )
    captured.length = 0
    captured.push(...(data as DiaperRow[]))
  }).toPass({ timeout: 15_000 })
  return captured
}

test("うんちの量: 大量で記録 → タイムライン・DB・reload・編集で少量へ → おしっこは量なし", async ({
  page,
  approvedUser,
}) => {
  // ── 1. login → 世帯作成 → /baby（起動時のページ）──────────────────────
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2Eうんち量世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)

  const todaySummary = page.getByRole("group", { name: "今日のまとめ" })
  await expect(todaySummary).toBeVisible({ timeout: 15_000 })

  // ── 2. おむつ「うんち」→ 2 段目（少量 / 大量 / 指定なし）が同じ行に出る ──
  await page.getByRole("button", { name: "うんち", exact: true }).click()
  const largeButton = page.getByRole("button", { name: "大量", exact: true })
  await expect(largeButton).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole("button", { name: "少量", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "指定なし", exact: true })).toBeVisible()
  // 2 段目では種別ボタンは隠れる（うんちの記録はまだ無い）
  await expect(page.getByRole("button", { name: "おしっこ", exact: true })).toHaveCount(0)

  // ── 3. 「大量」で記録 → トースト・タイムライン（楽観反映）─────────────
  await largeButton.click()
  await expect(
    page.getByText("おむつ交換を記録しました（うんち（大量））")
  ).toBeVisible({ timeout: 15_000 })
  const poopRow = page.getByRole("button", { name: /うんち（大量）/ })
  await expect(poopRow).toBeVisible({ timeout: 15_000 })
  await expect(todaySummary).toContainText("うんち1")
  // 1 段目へ戻っている
  await expect(page.getByRole("button", { name: "おしっこ", exact: true })).toBeVisible()

  // ── 4. DB 断面: poop_amount='large' が永続化されている ───────────────
  const [row] = await waitForDiaperRows(householdId, 1)
  expect(row.diaper_type).toBe("poop")
  expect(row.poop_amount).toBe("large")

  // ── 5. reload して SSR 断面でも同じ表示 ─────────────────────────────
  await reloadHydrated(page)
  await expect(poopRow).toBeVisible({ timeout: 15_000 })
  await expect(todaySummary).toContainText("うんち1")

  // ── 6. 編集シート: 「大量」が選択済み → 「少量」へ変えて更新 ─────────
  await openOverlay(poopRow, page.getByRole("heading", { name: "おむつを編集" }))
  const openSheet = page.locator('[data-slot="sheet-content"][data-open]')
  await expect(openSheet.getByText("うんちの量")).toBeVisible()
  await expect(
    openSheet.getByRole("button", { name: "大量", exact: true })
  ).toHaveClass(/bg-primary/)
  await openSheet.getByRole("button", { name: "少量", exact: true }).click()
  await openSheet.getByRole("button", { name: "更新する" }).click()
  await expect(page.getByText("ログを更新しました")).toBeVisible({ timeout: 15_000 })

  // DB 行が small へ（Realtime を待たず DB 断面で同期）
  await expect(async () => {
    const [updated] = await waitForDiaperRows(householdId, 1)
    if (updated.poop_amount !== "small")
      throw new Error(`poop_amount still ${updated.poop_amount}`)
  }).toPass({ timeout: 15_000 })

  // ── 7. おしっこは従来どおり 1 タップで記録され、量は NULL ───────────
  await page.getByRole("button", { name: "おしっこ", exact: true }).click()
  await expect(
    page.getByText("おむつ交換を記録しました（おしっこ）")
  ).toBeVisible({ timeout: 15_000 })
  const rows = await waitForDiaperRows(householdId, 2)
  const peeRow = rows.find((r) => r.diaper_type === "pee")
  expect(peeRow).toBeDefined()
  expect(peeRow?.poop_amount).toBeNull()
  await expect(todaySummary).toContainText("おしっこ1・うんち1")

  // ── 8. teardown は fixtures/test.ts の approvedUser が世帯ごと削除 ──
})
