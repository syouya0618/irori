import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 共有カレンダー E2E: login → 世帯作成 → /calendar → 予定を作成 → 反映 → 削除。
 * 一覧反映は楽観更新 + Realtime 依存のため、DB 断面を poll してから reload して
 * SSR 断面を assert する(golden-path と同じフレーク対策)。
 */

test.setTimeout(180_000)

async function reloadHydrated(page: Page): Promise<void> {
  const ws = page.waitForEvent("websocket", { timeout: 20_000 })
  await page.reload()
  await ws
}

async function openOverlay(trigger: Locator, readySignal: Locator): Promise<void> {
  await expect(async () => {
    if (!(await readySignal.isVisible())) {
      await trigger.click({ timeout: 2_000 })
    }
    await expect(readySignal).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

async function waitForEventCount(
  userId: string,
  title: string,
  expected: number,
): Promise<void> {
  const admin = adminClient()
  await expect(async () => {
    const { data: profile } = await admin
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()
    if (!profile?.household_id) throw new Error("household not ready")
    const { data, error } = await admin
      .from("calendar_events")
      .select("id")
      .eq("household_id", profile.household_id)
      .eq("title", title)
    if (error) throw new Error(`calendar lookup failed: ${error.message}`)
    if ((data?.length ?? 0) !== expected)
      throw new Error(`expected ${expected} "${title}", got ${data?.length ?? 0}`)
  }).toPass({ timeout: 15_000 })
}

test("共有カレンダー: 予定を作成 → 反映 → 削除", async ({ page, approvedUser }) => {
  // 1. login → setup（世帯作成）→ /meals
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E カレンダー世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })

  // 2. BottomNav「予定」→ /calendar
  await page.getByRole("link", { name: "予定" }).click()
  await expect(page).toHaveURL(/\/calendar/, { timeout: 15_000 })

  // 3. FAB → フォーム → 追加（終日・今日）
  const addSheet = page.getByRole("heading", { name: "予定を追加" })
  await openOverlay(page.getByRole("button", { name: "予定を追加" }), addSheet)
  await page.getByLabel("タイトル").fill("検診")
  await page.getByRole("button", { name: "追加", exact: true }).click()

  // 4. DB 断面で作成完了を待ち、reload して SSR でアジェンダに出る
  await waitForEventCount(approvedUser.id, "検診", 1)
  await reloadHydrated(page)
  await expect(page.getByText("検診")).toBeVisible({ timeout: 15_000 })

  // 5. アジェンダの予定をタップ → 編集シート → 削除
  await page.getByText("検診").click()
  await expect(page.getByRole("heading", { name: "予定を編集" })).toBeVisible({
    timeout: 5_000,
  })
  await page.getByRole("button", { name: "削除" }).click()

  // 6. DB から消えたことを待ち、reload して SSR で消えている
  await waitForEventCount(approvedUser.id, "検診", 0)
  await reloadHydrated(page)
  await expect(page.getByText("検診")).toHaveCount(0)
})
