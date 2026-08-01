import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * スモークテスト: 認証 → 世帯セットアップ → 献立ページ到達のクリティカルパス。
 *
 * 経路: /login（signInWithOtp）→ Mailpit からマジックリンク取得
 *   → /auth/callback?code=（exchangeCodeForSession）→ /（proxy 通過）
 *   → /meals（(main)/layout が世帯なしを検知）→ /setup
 *   → create_household RPC → /meals（空状態）
 */
test("新規ユーザーが login → setup → /meals に到達できる", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)

  // 承認済み + 世帯なし → /setup へ誘導される
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })

  await page.getByLabel("世帯名").fill("E2Eテスト世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()

  // create_household 成功 → /meals へリダイレクト
  await expect(page).toHaveURL(/\/meals/, { timeout: 15_000 })

  // 新規世帯は献立ゼロ → 今週ビューの空状態が表示される
  await expect(
    page.getByText("今週の献立はまだありません。タップして追加しましょう！")
  ).toBeVisible()
})

/**
 * Liquid Glass のぼかしが実ブラウザで「実際に効いている」ことの回帰テスト。
 *
 * 背景（2026-07-28 実測）: `.glass` のぼかしをリテラルで書くと Next 16 / Turbopack の
 * ビルド（lightningcss）が標準 `backdrop-filter` を削り `-webkit-backdrop-filter` だけを
 * 出力する。Chrome は prefix 版を解さない（`CSS.supports` = false）ため、**Chrome/Android
 * ではぼかしが 1px も掛からず、iOS Safari だけ効く**という端末間の分裂が起きていた。
 *
 * この欠陥は tsc も lint も `next build` も通り、CSS ファイルの存在確認すらすり抜ける
 * （プロパティ名は出力されているため）。**実ブラウザの computed style だけが証人**ゆえ
 * ここに置く。globals.css の `--glass-filter` を経由する書き方を変えたら落ちる。
 */
test("Liquid Glass: .glass のぼかしが実ブラウザで有効（prefix 落ちの回帰防止）", async ({
  page,
}) => {
  await page.goto("/login")

  const computed = await page.evaluate(() => {
    const el = document.createElement("div")
    el.className = "glass"
    document.body.appendChild(el)
    const value = getComputedStyle(el).backdropFilter
    el.remove()
    return {
      value,
      // Chrome が prefix 版を解さないことの陽性対照（この前提が崩れたら設計を見直す）
      supportsPrefixed: CSS.supports("-webkit-backdrop-filter", "blur(10px)"),
      supportsStandard: CSS.supports("backdrop-filter", "blur(10px)"),
    }
  })

  expect(computed.supportsStandard).toBe(true)
  // "none" なら標準プロパティがビルドで落ちている（この PR 以前の状態）
  expect(computed.value).toBe("blur(40px) saturate(1.8)")
})
