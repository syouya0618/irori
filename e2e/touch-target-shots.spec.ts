import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * タッチ領域 44px の変更を**目で比べられる**ようにするための撮影用 spec。
 *
 * 統括は実機を持たぬゆえ「見た目は変わっておらぬはず」と言えぬ。ここで主要画面を
 * 撮り、変更前後を並べて主に判断してもらう。
 *
 * ⚠️ **回帰テストではない**（assert を持たぬ）。既定では skip され、
 * `E2E_SHOTS=1` のときだけ走る。判断が済んだら消してよい。
 *
 * 実行:
 *   E2E_SHOTS=1 E2E_SHOT_LABEL=before pnpm e2e e2e/touch-target-shots.spec.ts
 */
test.skip(process.env.E2E_SHOTS !== "1", "撮影用。E2E_SHOTS=1 のときだけ走る")

const LABEL = process.env.E2E_SHOT_LABEL ?? "before"

test("主要画面を撮る", async ({ page, approvedUser }) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("撮影用世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })

  // 片手操作の実寸で見たいゆえ iPhone 相当の幅にする（DESIGN_SYSTEM の前提）。
  await page.setViewportSize({ width: 390, height: 844 })

  for (const [name, path] of [
    ["meals", "/meals"],
    ["shopping", "/shopping"],
    ["stock", "/stock"],
    ["baby", "/baby"],
    ["calendar", "/calendar"],
    ["settings", "/settings"],
  ] as const) {
    await page.goto(path)
    await page.waitForLoadState("networkidle")
    // ⚠️ `test-results/` は Playwright が実行前に掃除するゆえ、
    //    変更前後を並べたいときは**その外**へ書かねば消える（一度踏んだ）。
    await page.screenshot({
      path: `${process.env.E2E_SHOT_DIR ?? "test-results/shots"}/${LABEL}-${name}.png`,
      fullPage: true,
    })
  }
})
