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

  // 家事（2026-11）。下ナビの 4 本目から入り、ハブ（3 枠の今日の要約）と、ごみ・掃除・ごはんの
  // 最初の画面（新しい世帯の空の状態）を検査する。項目つきの画面・シートの操作は
  // e2e/chores-{garbage,cleaning,meals}.spec.ts が持つ（axe は掛けておらぬ）。
  test(`axe: 家事ハブ・ごみ・掃除・ごはん（${colorScheme}・390px）`, async ({
    page,
    approvedUser,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width: 390, height: 844 })
    await loginViaMagicLink(page, approvedUser.email)
    await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
    await page.getByLabel("世帯名").fill(`E2E axe chores ${colorScheme}`)
    await page.getByRole("button", { name: "世帯を作成する" }).click()
    await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })

    // 下ナビ → 家事ハブ。育児・予定・設定の入口は残っておる（既存の導線を保つ）
    const nav = page.getByRole("navigation", { name: "メインナビゲーション" })
    await expect(nav.getByRole("link")).toHaveText(["育児", "予定", "家事", "設定"])
    await nav.getByRole("link", { name: "家事", exact: true }).click()
    await expect(page).toHaveURL(/\/chores$/, { timeout: 15_000 })
    await expect(page.getByRole("heading", { level: 1, name: "家事" })).toBeVisible({ timeout: 15_000 })
    await expect(nav.getByRole("link", { name: "家事", exact: true })).toHaveAttribute("aria-current", "page")

    // 3 枠の要約は読めておる（新しい世帯の空の状態。「読み込めませんでした」ではない）
    const hub = page.getByRole("navigation", { name: "家事の機能" })
    await expect(hub.getByRole("link")).toHaveCount(3)
    await expect(hub.getByRole("link", { name: /^ごみ/ })).toContainText("ごみの日はまだ登録されていません。")
    await expect(hub.getByRole("link", { name: /^掃除/ })).toContainText("掃除の項目はまだありません。")
    await expect(hub.getByRole("link", { name: /^ごはん/ })).toContainText("今夜の献立は未定")
    await expect(hub.getByRole("link", { name: /^ごはん/ })).toContainText("まだ買うものはありません")
    await expect(hub).not.toContainText("読み込めませんでした")
    await expectNoViolations(page, testInfo, `chores-hub-${colorScheme}`)

    await hub.getByRole("link", { name: /^ごみ/ }).click()
    await expect(page).toHaveURL(/\/chores\/garbage$/, { timeout: 15_000 })
    await expect(page.getByRole("heading", { level: 1, name: "ごみ" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("ごみの日はまだ登録されていません")).toBeVisible()
    await expectNoViolations(page, testInfo, `chores-garbage-${colorScheme}`)

    await page.goto("/chores/cleaning")
    await expect(page.getByRole("heading", { level: 1, name: "掃除" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("掃除の項目がまだありません")).toBeVisible()
    await expectNoViolations(page, testInfo, `chores-cleaning-${colorScheme}`)

    await page.goto("/chores/meals")
    await expect(page.getByRole("heading", { level: 1, name: "ごはん" })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("tonight-state")).toBeVisible()
    await expectNoViolations(page, testInfo, `chores-meals-${colorScheme}`)
  })
}
