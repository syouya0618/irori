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
 * ## 200 まで固定する（2026-08-04 に「せぬ」から改めた）
 * 当初は「本体が service role で Supabase を触るゆえ環境の権限状態に依存する」
 * として `not.toBe(307/401)` に留めておった。それは**開発機の Supabase CLI が
 * 壊れておった**ことを暗黙に許容していただけで、契約としては弱すぎる:
 * `not.toBe(401)` は **500 を通してしまう**ゆえ、service role が表を読めぬ環境
 * （実際 CLI 2.108.0 では `42501 permission denied for table google_connections`）
 * でも緑になる。cron は誰も見ておらぬ経路ゆえ、それは最も避けたい偽緑じゃ。
 *
 * CLI を CI と同じ 2.101.0 へ揃えた今、200 は両環境で安定する。ゆえに
 *   - **200**（500 を弾く＝service role が表を読めることの固定）
 *   - `ok: true` と `summaries` が配列（本体を走り切った証跡。エラーページ等の
 *     別物が 200 で返る取り違えも同時に潰す）
 * まで固定する。**`households` の値は assert せぬ** — e2e は
 * `google_connections` を作らぬゆえ常に 0 じゃが、それは偶然の環境事実であって
 * この経路の契約ではない。将来 fixture が接続を 1 本作った途端に無関係な赤を
 * 生むため、脆い結合を作らぬ。同期本体の契約は
 * `src/lib/google/__tests__/sync.test.ts` が持つ。
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

test("正しい secret なら同期本体を走り切って 200 を返す", async ({ request }) => {
  // `next start` 側の env は playwright.config.ts が .env.e2e から注入する。
  // テストプロセスには自動で入らぬゆえ同じファイルから読む。
  //
  // ⚠️ ここを `test.skip` で逃がすと V8 の検査が**半分抜けたまま緑**になる。
  // `.env.e2e` は生成器（scripts/e2e-env.sh）が必ず CRON_SECRET を書くゆえ、
  // 欠けておるのは「生成器より古いファイルが残っておる」ときだけじゃ。
  // それは黙って skip すべき状況ではなく、直すべき状況ゆえ**落とす**。
  const secret = loadE2eEnv().CRON_SECRET?.trim()
  expect(
    secret,
    "CRON_SECRET が .env.e2e に無い。`pnpm e2e:env` で作り直すこと（古い .env.e2e が残っておる）",
  ).toBeTruthy()

  const res = await request.get(CRON_PATH, {
    maxRedirects: 0,
    headers: { authorization: `Bearer ${secret}` },
  })

  // proxy に食われれば 307、認可が外れれば 401、service role が表を読めねば 500。
  // 200 ちょうどを要求することで 3 つとも 1 本で割れる。
  expect(
    res.status(),
    "cron が 200 を返しておらぬ（307=proxy に食われた / 401=認可 / 500=service role が表を読めぬ）",
  ).toBe(200)

  // 200 を返す別物（エラーページ等）と取り違えぬよう、本体の形まで見る。
  const body = await res.json()
  expect(body).toMatchObject({ ok: true })
  expect(Array.isArray(body.summaries)).toBe(true)
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
