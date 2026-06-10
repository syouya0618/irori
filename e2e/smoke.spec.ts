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
