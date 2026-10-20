import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * JSON エクスポート（機能 D）を実物の PostgREST で確かめる。
 *
 * baby-report-pagination.spec と同じ理由: max_rows（1000）を跨ぐ keyset の `or()` は fake では
 * 検証できぬ。1,001 行（max_rows + 1）を入れ、DB の件数と本文の counts が一致することを固定する。
 * 日記も同時に入れ、同じ本文に載ることを見る。
 */

test.setTimeout(240_000)

const DAY_MS = 24 * 60 * 60 * 1000

function buildRows(householdId: string, userId: string, count: number) {
  const base = Date.now() - DAY_MS
  return Array.from({ length: count }, (_, i) => ({
    household_id: householdId,
    log_type: "diaper",
    diaper_type: "pee",
    logged_at: new Date(base - (i % 60) * DAY_MS - Math.floor(i / 60) * 60_000).toISOString(),
    logged_by: userId,
  }))
}

async function seed(householdId: string, userId: string, count: number) {
  const admin = adminClient()
  const BATCH = 500
  const rows = buildRows(householdId, userId, count)
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    const { error } = await admin.from("baby_logs").insert(rows.slice(offset, offset + BATCH))
    if (error) throw new Error(`seed failed: ${error.message}`)
  }
  const { error: diaryError } = await admin.from("baby_diaries").insert([
    { household_id: householdId, diary_date: "2026-01-05", content: "e2e 日記 1", updated_by: userId },
    { household_id: householdId, diary_date: "2026-01-06", content: "e2e 日記 2", updated_by: userId },
  ])
  if (diaryError) throw new Error(`diary seed failed: ${diaryError.message}`)
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

test("JSON エクスポートは max_rows を跨いで全件を含み、件数が DB と一致する", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E エクスポート世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)

  await seed(householdId, approvedUser.id, 1_001)

  const res = await page.request.get("/api/baby-export?period=all")
  expect(res.status()).toBe(200)
  expect(res.headers()["content-type"]).toContain("application/json")
  expect(res.headers()["content-disposition"]).toContain('filename="uchinolog_all_')
  expect(res.headers()["x-export-truncated"]).toBeUndefined()

  const body = (await res.json()) as {
    schema_version: number
    complete: boolean
    counts: { logs: number; diaries: number }
    logs: { id: string; logged_at: string; logged_at_jst_date: string }[]
    diaries: { diary_date: string; content: string }[]
    members: { id: string }[]
  }
  expect(body.schema_version).toBe(1)
  expect(body.complete).toBe(true)
  expect(body.counts.logs).toBe(1_001)
  expect(body.logs).toHaveLength(1_001)
  expect(new Set(body.logs.map((l) => l.id)).size).toBe(1_001)
  expect(body.counts.diaries).toBe(2)
  expect(body.diaries.map((d) => d.diary_date)).toEqual(["2026-01-05", "2026-01-06"])
  expect(body.members.map((m) => m.id)).toContain(approvedUser.id)

  // 未認証は 401（proxy の 307 ではなく route の判定に届く）
  const anonymous = await page.context().browser()!.newContext()
  const anonRes = await anonymous.request.get("/api/baby-export?period=all", {
    maxRedirects: 0,
  })
  expect([307, 401]).toContain(anonRes.status())
  await anonymous.close()
})
