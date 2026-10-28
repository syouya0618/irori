import { defineConfig, devices } from "@playwright/test"
import {
  loadE2eEnv,
  PREVIEW_BASE_URL,
  PREVIEW_COMMIT_SHA,
  PREVIEW_PORT,
} from "./e2e/fixtures/env"

const isCI = !!process.env.CI

/**
 * webServer に渡す env。
 * シェル env（process.env）の上に .env.e2e を上書きマージすることで、
 * `next start` がローカル Supabase スタックを参照する（.env.local は無傷のまま）。
 */
function buildWebServerEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, loadE2eEnv())
  // 本番 Vercel と同一の TZ=UTC で next start を走らせる。
  // SSR の週境界・今日判定は JST 固定実装 (date-jst.ts の currentWeekRangeJst /
  // todayJstString) になったため、サーバー TZ に依存しないことを E2E 全体で
  // 常時検証する (issue #23 の回帰検出。以前の TZ=Asia/Tokyo 注入はバグ隠蔽だった)
  env.TZ = "UTC"
  return env
}

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: isCI ? 2 : 0,
  // 認証メール（Mailpit）とローカル DB を共有するため direct 実行は 1 worker に固定
  workers: 1,
  forbidOnly: isCI,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    // emailRedirectTo が window.location.origin 由来のため、GoTrue の site_url
    // (http://127.0.0.1:3000) と一致させる。localhost は使わない。
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  },
  projects: [
    {
      // 既存の全 spec（axe の検査を含む）。WebKit 用の中核ケースだけは重ねて走らせぬ
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /webkit-core\.spec\.ts/,
    },
    // 2026-10-27 F2: 中核ケースだけを WebKit・iPhone 相当の端末設定（hasTouch・isMobile・393px）で。
    // ⚠️ これは**エミュレーション**じゃ: iPhone 実機・ホーム画面の standalone・日本語 IME・
    // VoiceOver の保証ではない。WebKit の本体が要るゆえ `E2E_WEBKIT=1` の時だけ足す
    // （E2E_OFFLINE / E2E_SHOTS と同じ流儀。CI は `playwright install webkit --with-deps` と併せて立てる）。
    ...(process.env.E2E_WEBKIT
      ? [
          {
            name: "webkit-iphone",
            use: {
              ...devices["iPhone 15"],
              locale: "ja-JP",
              timezoneId: "Asia/Tokyo",
            },
            testMatch: /webkit-core\.spec\.ts/,
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: "pnpm exec next start -H 127.0.0.1 -p 3000",
      url: "http://127.0.0.1:3000/login",
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: buildWebServerEnv(),
    },
    {
      // 同じ build を「本番でないデプロイ」として起動する（e2e/feedback-preview-gate.spec.ts）。
      // preview の値は .env.e2e（VERCEL_ENV="" を持つ）を重ねた**後**に上書きする — 先に置くと消える
      command: `pnpm exec next start -H 127.0.0.1 -p ${PREVIEW_PORT}`,
      url: `${PREVIEW_BASE_URL}/login`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: {
        ...buildWebServerEnv(),
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_SHA: PREVIEW_COMMIT_SHA,
      },
    },
  ],
})
