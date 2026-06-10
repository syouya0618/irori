import { defineConfig, devices } from "@playwright/test"
import { loadE2eEnv } from "./e2e/fixtures/env"

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
  // SSR の週境界 (getMonday 等) はサーバー TZ 依存 — ブラウザ (timezoneId) /
  // テスト (todayJst) と揃えねば JST 月曜早朝 (UTC 日曜 15:00-24:00) に
  // 「今日」が前週扱いになり CI が決定的に落ちる
  env.TZ = "Asia/Tokyo"
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
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm exec next start -H 127.0.0.1 -p 3000",
    url: "http://127.0.0.1:3000/login",
    reuseExistingServer: !isCI,
    timeout: 60_000,
    env: buildWebServerEnv(),
  },
})
