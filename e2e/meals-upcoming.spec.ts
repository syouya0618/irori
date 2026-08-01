import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * CAL-4「今日・明日の予定」カード E2E:
 * login → 世帯作成 → /meals（予定 0 件でカード非表示）→ /calendar で予定を作成
 * → /meals でカードに反映 → カードから /calendar へ戻れる。
 *
 * calendar.spec.ts とはファイルを分けている（同一 spec の書き換え依存を作らない）。
 */

test.setTimeout(180_000)

/**
 * 予定作成 server action の完了を DB 断面で待つ (service_role で RLS バイパス)。
 * calendar.spec.ts の同名ヘルパ・golden-path.spec.ts の waitForMealRow と同じ流儀
 * (各 spec ファイルでの重複が既存の慣習。cross-spec import は Playwright の
 * テストファイル読み込みを壊しうるため避ける)。
 *
 * calendar-view.tsx の新規予定作成は「楽観挿入 → シートを閉じる → startTransition
 * 内で非同期に createCalendarEvent を実行」の順であり、画面に予定名が見えた時点
 * ではサーバー側の INSERT が commit 済みである保証がない。/meals への遷移前に
 * この関数で実永続化を待つことで、「楽観表示は見えたが commit 前に SSR した」
 * という固定待ち時間に依存しない同期点を作る（waitForTimeout 等の時間待ちは
 * flake を時間で覆い隠すだけで使わない）。
 */
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

/** login(マジックリンク) → 世帯作成 → /meals に着地。 */
async function loginAndCreateHousehold(
  page: Page,
  email: string,
): Promise<void> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E 予定カード世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })
}

test("今日の予定を作ると /meals の先頭にカードが出て、そこから /calendar へ飛べる", async ({
  page,
  approvedUser,
}) => {
  await loginAndCreateHousehold(page, approvedUser.email)

  // 予定 0 件では何も出さない（0 件 null の受け入れ）。
  await expect(
    page.getByRole("link", { name: /今日・明日の予定/ }),
  ).toHaveCount(0)

  // /calendar で「今日」の時刻付き予定を作る。
  await page.getByRole("link", { name: "予定" }).click()
  await expect(page).toHaveURL(/\/calendar/, { timeout: 15_000 })

  await page.getByRole("button", { name: "予定を追加" }).click()
  await expect(
    page.getByRole("heading", { name: "予定を追加" }),
  ).toBeVisible({ timeout: 10_000 })
  await page.getByLabel("タイトル").fill("保育園見学")
  await page.getByRole("button", { name: "時刻あり", exact: true }).click()
  await page.locator("#cal-start-time").fill("14:00")
  await page.getByRole("button", { name: "追加", exact: true }).click()
  await expect(page.getByText("保育園見学").first()).toBeVisible({
    timeout: 15_000,
  })

  // 楽観表示は commit を保証しないため、DB 断面で実永続化を待ってから遷移する。
  await waitForEventCount(approvedUser.id, "保育園見学", 1)

  // /meals を SSR させ直してカードを確認する（Router Cache に依らず断面を見る）。
  await page.goto("/meals")
  const card = page.getByRole("link", { name: /今日・明日の予定/ })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText("今日")
  await expect(card).toContainText("保育園見学")
  await expect(card).toContainText("14:00")

  // カード全体が /calendar への導線になっている。
  await card.click()
  await expect(page).toHaveURL(/\/calendar/, { timeout: 15_000 })
})
