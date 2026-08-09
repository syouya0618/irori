import fs from "node:fs"
import path from "node:path"
import { test, expect } from "./fixtures/test"
import { loadE2eEnv } from "./fixtures/env"

/**
 * V8【致命的】**全ての** cron route が (a) proxy の承認ゲートに食われず
 * (b) secret 無しでは開かぬことを、実ビルド + `next start` で固定する。
 *
 * ## なぜ「列挙」するのか
 * `e2e/google-cron-proxy.spec.ts` は `/api/cron/google-sync` を名指ししておる。
 * 名指しのテストは**次に増える route を取りこぼす** — B-3 の `/api/cron/notify`、
 * B-5 のダイジェストと、この配下は増え続ける。増えた 1 本が
 * 「proxy に食われて 100% 不発」でも「無認証で service role が開く」でも、
 * 名指しのテストは緑のままじゃ。ゆえにディレクトリを走査して**全数**を撃つ。
 *
 * ## 偽緑を潰す
 * 走査が 0 件になれば assert は空回りして緑になる（glob を書き損じた時に起きる）。
 * ゆえに**まず「1 本以上見つかったこと」を固定する**。
 *
 * ## ⚠️ cookie を持たぬ `request` フィクスチャを使うこと
 * proxy は**承認済みユーザー**が isPublicRoute を踏むと `/` へ 307 する。
 * ログイン済みの context から叩くと「307 でないこと」が偽陽性の赤になる。
 * Vercel Cron も pg_net も cookie を持たぬゆえ、cookie 無しが本番と同じ形じゃ。
 */

const CRON_DIR = path.resolve(__dirname, "../src/app/api/cron")

function discoverCronRoutes(): string[] {
  return fs
    .readdirSync(CRON_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(CRON_DIR, entry.name, "route.ts")),
    )
    .map((entry) => `/api/cron/${entry.name}`)
}

const CRON_ROUTES = discoverCronRoutes()

test("cron route が 1 本以上見つかる（走査が空なら以降は空回りの偽緑）", () => {
  expect(CRON_ROUTES.length).toBeGreaterThan(0)
})

for (const route of CRON_ROUTES) {
  test(`${route} は proxy に食われず、secret 無しでは 401`, async ({ request }) => {
    const res = await request.get(route, { maxRedirects: 0 })

    // proxy に食われておれば 307 + Location: /login になる。
    expect(
      res.status(),
      `${route} が proxy の承認ゲートに食われておる（V8 の再発）`,
    ).not.toBe(307)
    // secret 検証が外れておれば 200/500 になる。
    expect(res.status(), `${route} が無認証で開いておる（V8 の裏返し）`).toBe(401)
  })

  test(`${route} は誤った secret でも 401`, async ({ request }) => {
    const res = await request.get(route, {
      maxRedirects: 0,
      headers: { authorization: "Bearer definitely-not-the-secret" },
    })
    expect(res.status()).toBe(401)
  })
}

test("`/api/cron/notify` は正しい secret でハンドラへ到達する", async ({
  request,
}) => {
  // `next start` 側の env は playwright.config.ts が .env.e2e から注入する。
  // テストプロセスには自動で入らぬゆえ同じファイルから読む。
  const secret = loadE2eEnv().NOTIFY_CRON_SECRET?.trim()
  test.skip(
    !secret,
    "NOTIFY_CRON_SECRET が未設定（`pnpm e2e:env` を再実行して .env.e2e を作り直すこと）",
  )

  const res = await request.get("/api/cron/notify", {
    maxRedirects: 0,
    headers: { authorization: `Bearer ${secret}` },
  })
  // status を 200 で固定せぬ: 認可の先は VAPID env と DB の状態に依存する
  // （e2e 環境には VAPID を置いておらぬゆえ 500 が正常な姿じゃ）。ここで見たいのは
  // **到達と認可**であって配信の成否ではない。配信の契約は
  // `src/lib/notifications/__tests__/deliver.test.ts` が持つ。
  expect(res.status()).not.toBe(307)
  expect(res.status()).not.toBe(401)
})

test("**鍵の分離** — google-sync の secret では notify は開かぬ", async ({
  request,
}) => {
  const cronSecret = loadE2eEnv().CRON_SECRET?.trim()
  test.skip(!cronSecret, "CRON_SECRET が未設定")

  // pg_net は Authorization ヘッダを DB のキューテーブルへ保存する。片方の
  // 漏洩が両方を開けてはならぬ、という設計をここで実物として固定する。
  const res = await request.get("/api/cron/notify", {
    maxRedirects: 0,
    headers: { authorization: `Bearer ${cronSecret}` },
  })
  expect(res.status()).toBe(401)
})
