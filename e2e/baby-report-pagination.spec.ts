import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 小児科用 PDF レポートのページ取得（P1-07）を実物の PostgREST で確かめる。
 *
 * ## なぜ e2e でなければならぬか
 * PostgREST は 1 応答を max_rows（supabase/config.toml・既定 1000）で切る。route は
 * `(logged_at, id)` の keyset で次ページを `or=(logged_at.gt."…",and(logged_at.eq."…",id.gt."…"))`
 * の形で引くが、この `or()` の解釈は fake では検証できぬ（vitest の fake は自前の解釈を持つだけ）。
 * 構文が崩れておれば 2 ページ目で PostgREST が 400 を返し、route は 500 になる。
 *
 * ## 何が弁別子か — 上限ちょうどの境界の対
 * route は累計 `LOG_FETCH_LIMIT + 1`（5,001）件まで引き、溢れた時だけ X-Report-Truncated を立てる。
 * - **ちょうど 5,000 行 → ヘッダ無し**: keyset が同値の行を**重複**して引けば 5,001 に届き、誤って立つ
 * - **1 行足して 5,001 行 → ヘッダ有り**: 同値の行を**取りこぼせば** 5,000 に留まり、立たぬ。
 *   旧実装（1 要求 = max_rows の 1000 行で切られる）もここで立たなんだ
 * 同じ logged_at を 3 行ずつ共有させ、ページ境界（1000 行ごと）が同値の組を割るようにしてある
 * （1000 = 3 × 333 + 1）。PDF の本文を読まずに、件数の正しさを境界で固定する。
 */

test.setTimeout(240_000)

const DAY_MS = 24 * 60 * 60 * 1000

/** 3 行ずつ同じ時刻を共有する、直近 85 日（3ヶ月窓の内側）の diaper 行を作る。 */
function buildRows(householdId: string, userId: string, from: number, count: number) {
  const base = Date.now() - DAY_MS
  return Array.from({ length: count }, (_, k) => {
    const i = from + k
    const slot = Math.floor(i / 3)
    const loggedAt = new Date(
      base - (slot % 85) * DAY_MS - Math.floor(slot / 85) * 60_000,
    ).toISOString()
    return {
      household_id: householdId,
      log_type: "diaper",
      diaper_type: "pee",
      logged_at: loggedAt,
      logged_by: userId,
    }
  })
}

async function seed(householdId: string, userId: string, from: number, count: number) {
  const admin = adminClient()
  const BATCH = 500
  for (let offset = 0; offset < count; offset += BATCH) {
    const rows = buildRows(householdId, userId, from + offset, Math.min(BATCH, count - offset))
    const { error } = await admin.from("baby_logs").insert(rows)
    if (error) throw new Error(`seed failed: ${error.message}`)
  }
}

async function waitForHouseholdId(userId: string): Promise<string> {
  const admin = adminClient()
  let householdId = ""
  await expect(async () => {
    const { data: profile, error } = await admin
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()
    if (error) throw new Error(`profile lookup failed: ${error.message}`)
    expect(profile?.household_id).toBeTruthy()
    householdId = profile!.household_id as string
  }).toPass({ timeout: 15_000 })
  return householdId
}

test("PDF レポートは max_rows を超えても全ページを辿り、上限超過だけを切り詰めとして知らせる", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E PDF ページ取得世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)

  // ── 1. ちょうど 5,000 行: 6 ページを辿り、上限に届かぬ → 200・PDF・切り詰め無し ──
  await seed(householdId, approvedUser.id, 0, 5_000)
  const atLimit = await page.request.get("/api/baby-report?period=3months")
  expect(atLimit.status(), "2 ページ目以降の keyset 取得が PostgREST に拒まれておらぬこと").toBe(200)
  expect(atLimit.headers()["content-type"]).toContain("application/pdf")
  expect(
    atLimit.headers()["x-report-truncated"],
    "ここで立つなら keyset が同値の行を重複して引いておる",
  ).toBeUndefined()

  // ── 2. 1 行足して 5,001 行: 上限を 1 件超える → 切り詰めヘッダが立つ ──
  await seed(householdId, approvedUser.id, 5_000, 1)
  const overLimit = await page.request.get("/api/baby-report?period=3months")
  expect(overLimit.status()).toBe(200)
  expect(overLimit.headers()["content-type"]).toContain("application/pdf")
  expect(
    overLimit.headers()["x-report-truncated"],
    "立たぬなら同値の行を取りこぼしておる（旧実装も max_rows で切られてここが立たなんだ）",
  ).toBe("1")
})
