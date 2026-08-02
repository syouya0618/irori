import { test, expect } from "./fixtures/test"
import { loadE2eEnv } from "./fixtures/env"

/**
 * V8【致命的】cron route が `proxy.ts` の承認ゲートに食われぬことを **実ビルド +
 * `next start`** で固定する。
 *
 * ## なぜ e2e なのか（単体テストでは原理的に取れぬ）
 * `src/app/api/cron/google-sync/__tests__/route.test.ts` は Route Handler を
 * **直接 import** しておるゆえ proxy を通らぬ。proxy が `/api/cron/` を
 * public route に入れていなければ、Vercel Cron（**cookie 無しの GET**）は
 * `/login` へ 307 され**ハンドラに到達せぬ**のに、単体テストは緑のままになる。
 * これはグローバル規約が名指しする「テスト緑・本番 100% 不発」と同型じゃ。
 *
 * ## この 1 本が両方の壊し方を捕まえる
 * 「secret 無しで **401**」という 1 つの assert が、
 *   - proxy が食えば → **307**（赤）
 *   - CRON_SECRET 検証を外せば → **200/500**（赤）
 * の**両方**を割る。V8 が「不可分の 1 PR」と言うのはこの不可分性ゆえじゃ。
 *
 * ## status を 200 で固定せぬ理由
 * 認可を通った後の本体は Supabase（service role）を触るため、環境の権限状態に
 * 依存する。ここで検証したいのは**到達と認可**であって同期の成否ではない。
 * ゆえに「307 でない」「401 でない」を assert する（同期本体の契約は
 * `src/lib/google/__tests__/sync.test.ts` が持つ）。
 */

const CRON_PATH = "/api/cron/google-sync"

test("cron route は proxy に食われず、secret 無しでは 401（V8）", async ({
  request,
}) => {
  const res = await request.get(CRON_PATH, { maxRedirects: 0 })

  // proxy に食われておれば 307 + Location: /login になる。
  expect(res.status(), "proxy の承認ゲートに食われておる（V8 の再発）").not.toBe(
    307,
  )
  // CRON_SECRET 検証が外れておれば 200/500 になる。
  expect(res.status(), "無認証で cron が開いておる（V8 の裏返し）").toBe(401)
})

test("誤った secret でも 401（307 ではなく）", async ({ request }) => {
  const res = await request.get(CRON_PATH, {
    maxRedirects: 0,
    headers: { authorization: "Bearer definitely-not-the-secret" },
  })
  expect(res.status()).toBe(401)
})

test("正しい secret ならハンドラへ到達する（401 でも 307 でもない）", async ({
  request,
}) => {
  // `next start` 側の env は playwright.config.ts が .env.e2e から注入する。
  // テストプロセスには自動で入らぬゆえ同じファイルから読む。
  const secret = loadE2eEnv().CRON_SECRET?.trim()
  test.skip(
    !secret,
    "CRON_SECRET が未設定（`pnpm e2e:env` を再実行して .env.e2e を作り直すこと）",
  )

  const res = await request.get(CRON_PATH, {
    maxRedirects: 0,
    headers: { authorization: `Bearer ${secret}` },
  })
  expect(res.status()).not.toBe(307)
  expect(res.status()).not.toBe(401)
})

test("session 認証の明示トリガは承認ゲートを通る（cookie 無しなら /login へ）", async ({
  request,
}) => {
  // `/api/google/sync` は `/api/cron/` 配下ではないゆえ proxy を通る＝正しい。
  // ここが 401 に変わったら、public route の prefix を広げすぎた合図じゃ。
  const res = await request.post("/api/google/sync", { maxRedirects: 0 })
  expect(res.status()).toBe(307)
  expect(res.headers()["location"]).toContain("/login")
})
