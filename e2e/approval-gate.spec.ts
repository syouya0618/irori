import { test, expect } from "./fixtures/test"
import { loginViaMagicLink } from "./fixtures/auth"

/**
 * 未承認ユーザーが承認ゲートに阻まれることの回帰テスト。
 *
 * ## なぜ要るか
 *
 * これまで e2e に登場するユーザーは全員 `is_approved=true` を注入されており
 * （fixtures/auth.ts の createApprovedUser）、**未承認ユーザーが出てくる e2e は
 * 1 本も無かった**。承認ゲートが丸ごと死んでも e2e は全緑のままだった。
 *
 * ## 2 本が測っているものは違う（重要）
 *
 * 承認ゲートは二層ある:
 *   一層目 = `src/proxy.ts`（規約ファイル。置き場所を一段間違えるだけで
 *            build/lint/tsc 全緑のまま黙って無効化される）
 *   二層目 = `getAuthContext`（`(main)/layout.tsx` が reason="not-approved" で
 *            /pending-approval へ redirect）
 *
 * - 「/meals」ケースは **合成**の検証。proxy が inert でも layout が拾うため、
 *   proxy 単独の実効性は測れない。測っているのは利用者から見た不変条件
 *   （未承認は保護ページの中身を見られない）。
 * - 「/login」ケースは **proxy 単独**の検証。`/login` は `"use client"` の
 *   ページで、`(auth)/layout.tsx` にも認証判定が無い。ゆえに「認証済み・未承認で
 *   /login を開くと /pending-approval へ飛ぶ」は proxy にしか実装が無い。
 *   proxy を誤配置すると **このケースだけが落ちる**（導入時に実測で確認）。
 *
 * proxy の配置そのものは scripts/check-proxy-effective.py が CI で機械固定する。
 * こちらは「実際に走ったリクエストが弾かれる」という実行時の証人じゃ。
 */
test("未承認ユーザーは保護ページ (/meals) を開けず /pending-approval へ送られる", async ({
  page,
  unapprovedUser,
}) => {
  await loginViaMagicLink(page, unapprovedUser.email)

  await page.goto("/meals")

  await expect(page).toHaveURL(/\/pending-approval/, { timeout: 15_000 })
  await expect(page.getByRole("heading", { name: "承認待ち" })).toBeVisible()
})

test("未承認ユーザーが /login を開くと /pending-approval へ送られる（proxy 単独の実効性）", async ({
  page,
  unapprovedUser,
}) => {
  await loginViaMagicLink(page, unapprovedUser.email)

  await page.goto("/login")

  // proxy が inert なら /login のログインフォームがそのまま描画される
  // （このページには server 側の認証判定が一切ない）。
  await expect(page).toHaveURL(/\/pending-approval/, { timeout: 15_000 })
  await expect(page.getByRole("heading", { name: "承認待ち" })).toBeVisible()
})
