// Synthetic HTTP fixtures only: this is a rendering benchmark, never an RLS/Auth test.
// Build first with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55439 and
// NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-public-key. No .env files are read here.
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { writeFileSync, existsSync } from "node:fs"
import { chromium } from "@playwright/test"

const uid = "00000000-0000-4000-8000-000000000001"
const hid = "00000000-0000-4000-8000-000000000010"
const cid = "00000000-0000-4000-8000-000000000020"
const now = new Date()
const user = { id: uid, aud: "authenticated", role: "authenticated", email: "user-a@example.invalid", app_metadata: {}, user_metadata: {}, created_at: now.toISOString() }
// Deliberately unsigned fixture token. Only the isolated fake Auth service accepts it.
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url")
const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: uid, exp: Math.floor(Date.now() / 1000) + 7200, role: "authenticated" })}.c3ludGhldGlj`
const profile = { id: uid, household_id: hid, is_approved: true, role: "owner", default_page: "baby", display_name: "テスト利用者A", avatar_url: null }
const household = { id: hid, name: "架空の世帯A", baby_name: "テスト児A1", baby_birth_date: "2026-01-01", feeding_interval_min: 180, bottle_default_ml: null }
let latency = 0
let rowCount = 30
const requests = []
const api = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:55438")
  res.setHeader("Access-Control-Allow-Headers", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Content-Type", "application/json")
  if (req.method === "OPTIONS") return res.end()
  const url = new URL(req.url, "http://127.0.0.1:55439")
  const started = performance.now()
  await new Promise((resolve) => setTimeout(resolve, latency))
  let data = []
  if (url.pathname === "/auth/v1/user") data = user
  if (url.pathname.endsWith("/profiles")) data = [profile]
  if (url.pathname.endsWith("/households")) data = [household]
  if (url.pathname.endsWith("/children")) data = [{ id: cid, household_id: hid, name: household.baby_name, birth_date: household.baby_birth_date, sex: null, is_legacy: true, feeding_interval_min: 180, bottle_default_ml: null, created_at: now.toISOString() }]
  if (url.pathname.endsWith("/baby_logs")) {
    data = Array.from({ length: rowCount }, (_, i) => ({
      id: `00000000-0000-4000-8001-${String(i + 1).padStart(12, "0")}`, household_id: hid, child_id: cid, logged_by: uid,
      log_type: "feeding", feeding_type: "bottle", amount_ml: 80, duration_min: null, duration_sec: null,
      breast_left_sec: null, breast_right_sec: null, breast_left_count: null, breast_right_count: null, breast_start_side: null,
      diaper_type: null, poop_amount: null, temperature: null, weight_g: null, height_cm: null, memo: null,
      logged_at: new Date(now.getTime() - i * 60_000).toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(),
    }))
    for (const [key, value] of url.searchParams) {
      const [op, ...rest] = value.split("."); const val = rest.join(".")
      if (op === "eq") data = data.filter((row) => String(row[key]) === val)
      if (op === "lt") data = data.filter((row) => Date.parse(row[key]) < Date.parse(val))
      if (op === "gte") data = data.filter((row) => Date.parse(row[key]) >= Date.parse(val))
    }
    if (url.searchParams.has("limit")) data = data.slice(0, Number(url.searchParams.get("limit")))
  }
  if (url.pathname.includes("/rpc/")) data = url.pathname.endsWith("/is_app_operator") ? false : 0
  if (Array.isArray(data) && req.headers.accept?.includes("vnd.pgrst.object")) data = data[0] ?? null
  requests.push({ path: url.pathname, ms: Math.round(performance.now() - started) })
  res.end(JSON.stringify(data))
})
await new Promise((resolve) => api.listen(55439, "127.0.0.1", resolve))
const childEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
Object.assign(childEnv, { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55439", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:55438", NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC" })
const app = spawn("pnpm", ["exec", "next", "start", "-H", "127.0.0.1", "-p", "55438"], { env: childEnv, stdio: "ignore" })
let browser
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch("http://127.0.0.1:55438/login", { signal: AbortSignal.timeout(1500) })).ok) break } catch {}
    if (i === 99) throw new Error("local production server did not start")
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {})
  const results = []
  for (const scenario of [{ name: "normal", latency: 0, rows: 30 }, { name: "many-records", latency: 0, rows: 800 }, { name: "slow-api", latency: 200, rows: 30 }]) {
    latency = scenario.latency; rowCount = scenario.rows
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP", timezoneId: "Asia/Tokyo", serviceWorkers: "block" })
    const session = { access_token: token, refresh_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 7200, expires_in: 7200, token_type: "bearer", user }
    await context.addCookies([{ name: "sb-127-auth-token", value: `base64-${b64(session)}`, domain: "127.0.0.1", path: "/" }])
    await context.addInitScript(() => localStorage.setItem("irori:tour-seen:v1", "1"))
    const page = await context.newPage()
    const sample = async (label, action, path) => {
      requests.length = 0
      console.log(`measuring ${scenario.name} ${label}`)
      const start = performance.now()
      await action()
      await page.waitForURL(`**${path}`)
      await page.getByRole("navigation", { name: "メインナビゲーション" }).waitFor()
      if (path === "/baby") await page.locator("span").filter({ hasText: /^テスト児A1$/ }).first().waitFor()
      if (path === "/calendar") await page.getByRole("button", { name: "前の月", exact: true }).waitFor()
      if (path === "/settings") await page.getByRole("heading", { name: "設定", exact: true }).waitFor()
      await page.waitForTimeout(100)
      results.push({ scenario: scenario.name, operation: label, settledMs: Math.round(performance.now() - start), apiRequests: requests.length, apiMs: requests.reduce((sum, req) => sum + req.ms, 0) })
    }
    await sample("cold-start", () => page.goto("http://127.0.0.1:55438/baby"), "/baby")
    await page.waitForTimeout(500)
    for (const [label, path, name] of [["baby-calendar", "/calendar", "予定"], ["calendar-settings", "/settings", "設定"], ["settings-baby", "/baby", "育児"]]) {
      await sample(label, () => page.getByRole("navigation").getByRole("link", { name, exact: true }).click(), path)
    }
    await sample("back", () => page.goBack(), "/settings")
    // A hard settings load also renders the layout; SPA navigation reuses it.
    await sample("cold-settings", () => page.goto("http://127.0.0.1:55438/settings"), "/settings")
    if (process.argv.includes("--check-phase2")) {
      const toggle = page.getByRole("button", { name: "更新履歴を見る" })
      if (await toggle.getAttribute("aria-expanded") !== "false") throw new Error("history must start closed")
      await toggle.click()
      await page.getByRole("heading", { name: "2026年10月28日の更新" }).waitFor()
      await toggle.click()
      if (await toggle.getAttribute("aria-expanded") !== "false") throw new Error("history did not close")
      await page.goto("http://127.0.0.1:55438/baby")
      await page.getByRole("main").getByRole("button", { name: "搾乳", exact: true }).click()
      const sheet = page.locator('[data-slot="sheet-content"][data-open]')
      await sheet.getByText("保存した量がここに表示されます").waitFor()
      if (await sheet.getByRole("button", { name: "10", exact: true }).count()) throw new Error("invented candidate")
      await sheet.getByLabel("量 (ml)").fill("120")
      if (await sheet.getByLabel("量 (ml)").inputValue() !== "120") throw new Error("direct amount entry failed")
    }
    await context.close()
  }
  const result = { method: "local production build; synthetic HTTP fixtures; includes 100ms settle; SW blocked; not DB/Auth/Realtime proof", results }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser?.close()
  app.kill("SIGTERM")
  api.closeAllConnections(); api.close()
}
