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
  ["育児", "/baby"],
  ["予定", "/calendar"],
  ["設定", "/settings"],
  ["要望", "/feedback"],
  // 家事ハブ（2026-11）。ボトムナビの 4 タブ目と、ごみ・掃除・ごはんへの入口カード
  ["家事", "/chores"],
  // 掃除（2026-11）。空の案内・追加の釦・更新の釦。項目つきの実測は e2e/chores-cleaning.spec.ts
  ["掃除", "/chores/cleaning"],
  // ごみ（2026-11）。未登録の案内（カレンダーへの導線）・通知の状態・更新の釦。
  // 分類つきの画面とフォームの実測は e2e/chores-garbage.spec.ts
  ["ごみ", "/chores/garbage"],
  // ごはん（2026-11）。今夜（主な 2 つの操作・買い物への導線）・献立（開始日と日数・作成・7 日の
  // カード・手で追加）・買い物（空の案内・献立から更新・項目を追加）。料理・項目つきの画面と
  // シートの実測は e2e/chores-meals.spec.ts
  ["ごはん（今夜）", "/chores/meals"],
  ["ごはん（献立）", "/chores/meals/plan"],
  ["ごはん（買い物）", "/chores/meals/shopping"],
  // ごはん（2026-11）。食材（まとめ入力・空の案内）・今あるもので（0 件の案内と、食材・常備品への
  // 導線）・設定（人数の増減・常備品とアレルゲンの札・登録の釦・出典のリンク）・レシピ詳細
  // （出典のリンク）。新しい世帯には食材も子どもも無いゆえ、行つきの一覧・編集シート・取り分けの
  // 案内（子どもごとの出典リンク）の実測はここに含まれぬ
  ["ごはん（食材）", "/chores/meals/pantry"],
  ["ごはん（今あるもので）", "/chores/meals/now"],
  ["ごはん（設定）", "/chores/meals/settings"],
  ["ごはん（レシピ）", "/chores/meals/recipes/sweet_potato_honey_lemon"],
] as const

test("押下対象はどの画面でも 44x44px 以上ある（実ブラウザ実測）", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("タッチ領域検査世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })

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

// 家事（2026-11）: 狭い Android 端末の幅（360px）で、どの家事の画面も横へはみ出さぬ。
// 同じ幅の検査は e2e/baby-bottle-default.spec.ts が育児の画面に持つ。料理・項目つきの画面の
// 390px の操作は e2e/chores-{garbage,cleaning,meals}.spec.ts が持つ。
test("家事の画面は 360px 幅でも横へはみ出さない（実ブラウザ実測）", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("狭い画面検査世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })

  await page.setViewportSize({ width: 360, height: 760 })

  const choreScreens = SCREENS.filter(([, path]) => path.startsWith("/chores"))
  // 対照: 家事の画面を一つも測らずに緑にならぬよう、数を確かめる
  expect(choreScreens.length).toBeGreaterThanOrEqual(10)

  const overflows: string[] = []
  for (const [label, path] of choreScreens) {
    await page.goto(path)
    await page.waitForLoadState("networkidle")
    await expect(page.getByRole("main")).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    if (overflow > 0) overflows.push(`${label}(${path}): ${overflow}px`)
  }

  expect(overflows, `360px で横にはみ出した画面:\n  ${overflows.join("\n  ")}`).toEqual([])
})
