import { test, expect } from "./fixtures/test"

/**
 * `/auth/confirm`（メールを使わぬ緊急ログインの着地点）が **proxy に食われず
 * ハンドラへ届く**ことを、実ビルド + `next start` で固定する。
 *
 * ## なぜ単体テストでは足りぬのか
 *
 * `src/__tests__/proxy.test.ts` は `proxy()` を直接呼んでおる。matcher の書き損じ
 * や `isPublicRoute` の綴り間違いは、そこでは**永久に緑のまま**じゃ。cron route で
 * まさにこれをやられた ——「テストは全緑・本番は 100% 不発」。
 *
 * ## ⚠️ 弁別子は status ではなく `error` クエリじゃ
 *
 * proxy に食われた場合も **`/login` への 307**、ハンドラが弾いた場合も
 * **`/login` への 307** で、**status では区別できぬ**。違うのは
 * `?error=link_invalid` が付くか否かだけ ——ハンドラを通った証拠はそこにしかない。
 *
 * ## cookie 無しで撃つ
 *
 * 緊急リンクを踏むのは「入れなくなった人」＝未認証じゃ。`request` フィクスチャは
 * cookie を持たぬゆえ、本番と同じ形になる。
 */

test("/auth/confirm は proxy に食われずハンドラへ届く（無効 token は link_invalid）", async ({
  request,
}) => {
  const res = await request.get(
    "/auth/confirm?token_hash=definitely-not-a-real-token&type=magiclink",
    { maxRedirects: 0 }
  )

  expect(res.status()).toBe(307)
  const location = new URL(res.headers()["location"], "http://localhost")
  expect(location.pathname).toBe("/login")
  expect(
    location.searchParams.get("error"),
    "error が付いておらぬ ＝ ハンドラに届かず proxy に食われておる（cron の V8 と同型）"
  ).toBe("link_invalid")
})

test("発行せぬ type は verifyOtp へ渡らず弾かれる", async ({ request }) => {
  const res = await request.get(
    "/auth/confirm?token_hash=whatever&type=recovery",
    { maxRedirects: 0 }
  )
  const location = new URL(res.headers()["location"], "http://localhost")
  expect(location.searchParams.get("error")).toBe("link_invalid")
})

/**
 * 完全一致であることの証人。前方一致（`startsWith("/auth/")`）へ緩めると、
 * ここが `error` 付きになるか 200 になり、**将来の全 `/auth/*` が未認証で開く**。
 */
test("/auth/confirm 以外の /auth/* は公開されておらぬ", async ({ request }) => {
  const res = await request.get("/auth/confirmation", { maxRedirects: 0 })

  expect(res.status()).toBe(307)
  const location = new URL(res.headers()["location"], "http://localhost")
  expect(location.pathname).toBe("/login")
  expect(
    location.searchParams.get("error"),
    "error が付いておる ＝ ハンドラに届いておる ＝ 公開範囲が広がっておる"
  ).toBeNull()
})
