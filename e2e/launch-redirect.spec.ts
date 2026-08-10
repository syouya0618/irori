import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 起動（`/`）が**一度の 307 で**設定どおりのページへ着くことを、実ビルド +
 * `next start` で固定する。
 *
 * ## なぜ単体テストでは足りぬのか
 *
 * `src/__tests__/proxy.test.ts` は `proxy()` を直接呼んで戻り値を見ておる。
 * それは「関数がそう返す」ことしか言えぬ。実際に走るのは Next のルーティングを
 * 通った後の**リクエスト**じゃ。cron route で一度やられておる型 —— ハンドラを
 * 直接 import するテストは全緑のまま、本番は proxy に食われて 100% 不発じゃった。
 * ゆえにここでは実 URL を `maxRedirects: 0` で撃ち、**Location を直に見る**。
 *
 * ## ⚠️ これが弁別**せぬ**もの — 速くなったこと
 *
 * 旧実装（proxy を素通りし `src/app/page.tsx` が描画されて redirect する形）でも
 * **応答は同じ 307 + Location: /shopping じゃ**。ゆえに status も Location も
 * 新旧を見分けられぬ。HTTP の往復数も両者 2 回で変わらぬ。
 *
 * 変わるのは 1 往復目の**中身**だけ ——「`/` の動的描画 + getClaims + profiles の
 * 往復」が消える。それは応答のどこにも現れぬゆえ、ここでは測らぬ。速度は
 * 別途 A/B で測ること（本 PR の記述を参照）。
 *
 * ここが固定するのは **契約**じゃ: 設定どおりの行き先へ着くこと、そして
 * 承認ゲートが `/` でも効いていること。速度の主張の証人ではない。
 *
 * ## `page.request` を使う理由
 *
 * ブラウザコンテキストの cookie を引き継ぐため、ログイン後に使えば**認証済み**の
 * 経路を測れる（cookie 無しの `request` フィクスチャでは未認証の枝しか通らず、
 * `default_page` の解決そのものに到達できぬ）。
 */

test("承認済みの起動は 1 回の 307 で default_page へ着く（/ を経由せぬ）", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)

  // 既定（meals）と区別できる値を選ぶ。meals のままだと「解決せず既定へ
  // 倒れただけ」と見分けがつかず、設定が効かなくても緑になる。
  const { error } = await adminClient()
    .from("profiles")
    .update({ default_page: "shopping" })
    .eq("id", approvedUser.id)
  expect(error, `default_page の更新に失敗: ${JSON.stringify(error)}`).toBeNull()

  const res = await page.request.get("/", { maxRedirects: 0 })

  expect(res.status(), "proxy が / を解決しておらぬ（描画へ落ちておる）").toBe(
    307
  )

  const location = new URL(
    res.headers()["location"],
    "http://localhost" // 相対 Location でも解釈できるようにする
  )
  // 既定と区別できる値を選んである（上記）ゆえ、これは「設定が効いておる」の証人。
  expect(location.pathname).toBe("/shopping")
})

test("承認済みが /login を開くと、/ を経由せず default_page へ着く", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)

  const { error } = await adminClient()
    .from("profiles")
    .update({ default_page: "stock" })
    .eq("id", approvedUser.id)
  expect(error, `default_page の更新に失敗: ${JSON.stringify(error)}`).toBeNull()

  const res = await page.request.get("/login", { maxRedirects: 0 })

  expect(res.status()).toBe(307)
  const location = new URL(res.headers()["location"], "http://localhost")
  expect(location.pathname).toBe("/stock")
})

/**
 * ⚠️ **ゲートが動いておらぬことの証人。** 起動の高速化は承認済みの枝の中だけで
 * 行った。未承認が `/` から前へ進めては、公開インスタンスを家族専用に保つ門が
 * 破れる。`e2e/approval-gate.spec.ts` は `/meals` と `/login` を見ておるが、
 * **`/` は誰も見ておらなんだ** —— 今回 `/` に分岐を足したゆえ、ここで塞ぐ。
 */
test("未承認は / から前へ進めず /pending-approval へ送られる", async ({
  page,
  unapprovedUser,
}) => {
  await loginViaMagicLink(page, unapprovedUser.email)

  const res = await page.request.get("/", { maxRedirects: 0 })

  expect(res.status()).toBe(307)
  const location = new URL(res.headers()["location"], "http://localhost")
  expect(
    location.pathname,
    "未承認が / から default_page へ進んでおる（承認ゲートの破れ）"
  ).toBe("/pending-approval")
})

test("未認証は / から /login へ送られる", async ({ page }) => {
  const res = await page.request.get("/", { maxRedirects: 0 })

  expect(res.status()).toBe(307)
  const location = new URL(res.headers()["location"], "http://localhost")
  expect(location.pathname).toBe("/login")
})
