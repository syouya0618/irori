import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * タッチ領域 44px の**実ブラウザ回帰テスト**。
 *
 * CLAUDE.md「Touch targets: min 44px」/ DESIGN_SYSTEM.md:99「タッチターゲット
 * 最小 44x44px」を、ソースではなく**描画された箱**で検査する。
 *
 * ## なぜソースの静的検査ではなく e2e なのか
 * 高さは call-site の className・`Button` variant の既定・親の flex・padding の
 * 積み重ねで決まる。静的に追うと `cn`（twMerge）の上書き規則まで再実装する
 * ことになり、**その再実装が間違っておっても緑になる**。実測なら曖昧さが無い。
 *
 * さらに `Button` プリミティブを通さぬ**生の `<button>`** も捕まる。基底クラスへ
 * `min-h-11` を置いても、生の `<button>` はその恩恵を受けぬゆえ、そこが穴になる。
 *
 * ## 除外の考え方
 * - **不可視の要素は測らぬ**（`boundingBox()` が null / 面積 0）。閉じたシートの
 *   中身などは触れぬゆえ対象外じゃ
 * - 例外リストは**設けておらぬ**。作った瞬間に「例外に足せば通る」経路ができる
 */

/** 44px。DESIGN_SYSTEM.md:99 の値をここへ写す（マジックナンバーにせぬ）。 */
const MIN_TOUCH_PX = 44

const SCREENS = [
  ["献立", "/meals"],
  ["買い物", "/shopping"],
  ["在庫", "/stock"],
  ["育児", "/baby"],
  ["予定", "/calendar"],
  ["設定", "/settings"],
] as const

test("押下対象はどの画面でも 44x44px 以上ある（実ブラウザ実測）", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("タッチ領域検査世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })

  // 片手操作の実寸で測る（DESIGN_SYSTEM が前提とする使い方）。
  await page.setViewportSize({ width: 390, height: 844 })

  const violations: string[] = []

  for (const [label, path] of SCREENS) {
    await page.goto(path)
    await page.waitForLoadState("networkidle")

    // button / role=button / a / input[type=checkbox|radio] を対象にする。
    const targets = page.locator(
      'button, [role="button"], a[href], input[type="checkbox"], input[type="radio"]'
    )
    const n = await targets.count()
    for (let i = 0; i < n; i++) {
      const el = targets.nth(i)
      const box = await el.boundingBox()
      // 不可視（閉じたシートの中身など）は触れぬゆえ対象外。
      if (box === null || box.width === 0 || box.height === 0) continue
      if (box.width >= MIN_TOUCH_PX && box.height >= MIN_TOUCH_PX) continue

      const name =
        (await el.getAttribute("aria-label")) ??
        (await el.textContent())?.trim().slice(0, 24) ??
        (await el.getAttribute("class"))?.slice(0, 40) ??
        "(名前不明)"
      violations.push(
        `${label}(${path}): "${name}" = ${Math.round(box.width)}x${Math.round(box.height)}px`
      )
    }
  }

  expect(
    violations,
    `44px 未満の押下対象が見つかった。片手操作での誤タップは ` +
      `DESIGN_SYSTEM.md:15-16 が名指しする失敗モードじゃ:\n  ${violations.join("\n  ")}`
  ).toEqual([])
})
