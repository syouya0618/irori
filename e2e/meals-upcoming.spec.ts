import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * CAL-4「今日・明日の予定」カード E2E:
 * login → 世帯作成 → /meals（予定 0 件でカード非表示）→ /calendar で予定を作成
 * → /meals でカードに反映 → カードから /calendar へ戻れる。
 *
 * calendar.spec.ts とはファイルを分けている（同一 spec の書き換え依存を作らない）。
 */

test.setTimeout(180_000)

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
