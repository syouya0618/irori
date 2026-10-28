import { AxeBuilder } from "@axe-core/playwright"
import type { Page, TestInfo } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * 主要な状態の axe 検査（2026-10-27 大型更新 F2・AC26 の axe 層）。
 *
 * @axe-core/playwright 4.13.0（MPL-2.0。`npm view` と導入版の README / index.d.ts で API を確認:
 * `new AxeBuilder({ page }).withTags([...]).analyze()` → `results.violations`）。
 * package.json への追加は主担当（shared_change_requests）。版は 4.13.0 に固定する提案
 * （4.14.0 は 2026-10-15 公開で日が浅い）。
 *
 * 検査するのは WCAG 2.x A/AA の自動で判定できる規則だけ。自動検査で 0 件でも、読み上げの順序・
 * 意味・日本語の読み・実機の VoiceOver は保証せぬ（manual-device は別）。
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]

async function expectNoViolations(page: Page, testInfo: TestInfo, label: string) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  await testInfo.attach(`axe-${label}`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  })
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5),
  }))
  expect(summary, `${label} の axe 違反`).toEqual([])
}

test("axe: ログイン画面（未ログイン）と /offline", async ({ page }, testInfo) => {
  await page.goto("/login")
  await expect(page.getByLabel("メールアドレス")).toBeVisible()
  await expectNoViolations(page, testInfo, "login")

  await page.goto("/offline")
  await expect(page.getByRole("heading", { name: "オフラインです" })).toBeVisible()
  await expectNoViolations(page, testInfo, "offline")
})

for (const colorScheme of ["light", "dark"] as const) {
  test(`axe: 育児ホーム・量のシート・設定（${colorScheme}・390px）`, async ({
    page,
    approvedUser,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 390, height: 844 })
    await loginViaMagicLink(page, approvedUser.email)
    await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
    await page.getByLabel("世帯名").fill(`E2E axe ${colorScheme}`)
    await page.getByRole("button", { name: "世帯を作成する" }).click()
    await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
    await expect(page.getByRole("group", { name: "今日のまとめ" })).toBeVisible({ timeout: 15_000 })
    await expectNoViolations(page, testInfo, `baby-${colorScheme}`)

    // 量のシートを開いた状態（モーダル・数値入力・増減ボタン）
    await page.getByRole("main").getByRole("button", { name: "ミルク", exact: true }).click()
    await expect(page.getByRole("heading", { name: "いつものミルク量" })).toBeVisible({
      timeout: 15_000,
    })
    await expectNoViolations(page, testInfo, `bottle-sheet-${colorScheme}`)
    await page.keyboard.press("Escape")

    // 設定（版の欄・書き出し・ログアウトの確認）
    await page.goto("/settings")
    await expect(page.getByText("このアプリの版", { exact: true })).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "ログアウト", exact: true }).click()
    await expect(page.getByRole("group", { name: /ログアウト/ })).toBeVisible()
    await expectNoViolations(page, testInfo, `settings-${colorScheme}`)
  })
}
