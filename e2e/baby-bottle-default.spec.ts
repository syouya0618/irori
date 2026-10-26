import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import {
  adminClient,
  cleanupUser,
  createApprovedUser,
  loginViaMagicLink,
  uniqueEmail,
} from "./fixtures/auth"

/**
 * いつものミルク量（households.bottle_default_ml）E2E。二つの端末（A = 世帯を作った人、
 * B = 同じ世帯の家族）。
 *
 * A: 未設定のミルク → 量のシートで 120 → 「保存して記録する」→ 120ml の記録 1 件
 * → もう一度ミルク（1 タップ）→ 120ml が 2 件
 * B: /baby を開くと 120ml（世帯で共有）
 * A: 「ミルクの量を変更」で 160 → 過去の 2 件は 120ml のまま（書き換えぬ）
 * A: 通信断でミルク → 圏外トースト → 戻って押し直す → 160ml が 1 件だけ増える
 * B: 画面復帰（visibilitychange）で 160ml に変わり、知らせが出る → B のミルクは 160ml
 * 同時変更: B がシートを開いたまま A が 180 を保存 → B の 200 は衝突（上書きせず入力は残る）
 * → B が 180 を見たうえで保存し直すと 200
 *
 * ## なぜ DB 断面まで見るか
 * 釦の「120ml」やタイムラインは楽観反映でも同じに見える。保存した量・記録した量・過去の行が
 * 変わらぬことは service_role の直読みで固定する（baby-diaper-amount.spec.ts と同じ流儀）。
 *
 * ## フレーク対策
 * - 時間ベースの sleep は使わず DB 断面を poll して同期する
 * - Sheet の open は openOverlay（退場中シートの消滅を待ってから click）
 * - クイック記録は <main> へ、シートの中は開いているシート（[data-open]）へスコープする
 */

test.setTimeout(240_000)

const OFFLINE_ACTION_TOAST = "通信できませんでした。電波の良い場所でもう一度お試しください"

/** Sheet / Dialog を決定的に開く（baby-diaper-amount.spec.ts と同一実装）。 */
async function openOverlay(trigger: Locator, readySignal: Locator): Promise<void> {
  await expect(
    trigger.page().locator('[data-slot="sheet-content"]:not([data-open])')
  ).toHaveCount(0, { timeout: 10_000 })
  await expect(async () => {
    if (!(await readySignal.isVisible())) {
      await trigger.click({ timeout: 2_000 })
    }
    await expect(readySignal).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

function openSheetOf(page: Page): Locator {
  return page.locator('[data-slot="sheet-content"][data-open]')
}

/** approvedUser の世帯 ID を DB 断面で待つ（世帯作成 server action の完了同期点）。 */
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
    if (!profile?.household_id) throw new Error("household not ready")
    householdId = profile.household_id
  }).toPass({ timeout: 15_000 })
  return householdId
}

interface BottleRow {
  id: string
  amount_ml: number | null
  logged_by: string
}

/** 世帯のミルク行が `expectedCount` 件になるのを DB 断面で待ち、記録順に返す（二重記録も同時に固定）。 */
async function waitForBottleRows(
  householdId: string,
  expectedCount: number
): Promise<BottleRow[]> {
  const captured: BottleRow[] = []
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("baby_logs")
      .select("id, amount_ml, logged_by")
      .eq("household_id", householdId)
      .eq("log_type", "feeding")
      .eq("feeding_type", "bottle")
      .order("logged_at", { ascending: true })
    if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
    if (!data || data.length !== expectedCount)
      throw new Error(`expected ${expectedCount} bottle rows, got ${data?.length ?? 0}`)
    captured.length = 0
    captured.push(...(data as BottleRow[]))
  }).toPass({ timeout: 15_000 })
  return captured
}

/** 世帯のいつものミルク量（DB）が `expected` になるのを待つ。 */
async function waitForBottleDefault(householdId: string, expected: number | null): Promise<void> {
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("households")
      .select("bottle_default_ml")
      .eq("id", householdId)
      .single()
    if (error) throw new Error(`households lookup failed: ${error.message}`)
    if (data?.bottle_default_ml !== expected)
      throw new Error(`bottle_default_ml is ${data?.bottle_default_ml}, expected ${expected}`)
  }).toPass({ timeout: 15_000 })
}

/** A: login → 世帯作成 → /baby。世帯 ID を返す。 */
async function createHouseholdAsA(
  page: Page,
  user: { id: string; email: string },
  householdName: string
): Promise<string> {
  await loginViaMagicLink(page, user.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill(householdName)
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(user.id)
  await expect(page.getByRole("group", { name: "今日のまとめ" })).toBeVisible({
    timeout: 15_000,
  })
  return householdId
}

test("いつものミルク量: 未設定から初回設定 → 1 タップ → 120→160 → 夫婦の別端末へ反映。過去の記録は変わらぬ", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  const householdId = await createHouseholdAsA(page, approvedUser, "E2Eミルク量世帯")
  const quickA = page.getByRole("main")
  const milkA = quickA.getByRole("button", { name: "ミルク", exact: true })

  // ── 1. A: 未設定。釦は「量を設定」、量の口は「設定」（「変更」ではない）──────
  await expect(quickA.getByTestId("bottle-default-amount")).toHaveText("量を設定")
  await expect(quickA.getByRole("button", { name: "ミルクの量を設定" })).toBeVisible()
  await expect(quickA.getByRole("button", { name: "ミルクの量を変更" })).toHaveCount(0)

  // ── 2. A: ミルク → 量のシートで 120 → 保存して記録する ────────────────
  await openOverlay(milkA, page.getByRole("heading", { name: "いつものミルク量" }))
  const sheetA = openSheetOf(page)
  await expect(sheetA.getByLabel("1回の量（ml）")).toHaveValue("")
  await sheetA.getByLabel("1回の量（ml）").fill("120")
  await sheetA.getByRole("button", { name: "保存して記録する" }).click()
  await expect(page.getByText("授乳を記録しました（ミルク 120ml）")).toBeVisible({
    timeout: 15_000,
  })
  await waitForBottleDefault(householdId, 120)
  let rows = await waitForBottleRows(householdId, 1)
  expect(rows[0].amount_ml).toBe(120)
  await expect(quickA.getByTestId("bottle-default-amount")).toHaveText("120ml")

  // ── 3. A: もう一度ミルク = 1 タップで 120ml（シートは開かぬ）───────────
  await expect(milkA).toBeEnabled({ timeout: 15_000 })
  await milkA.click()
  rows = await waitForBottleRows(householdId, 2)
  expect(rows.map((r) => r.amount_ml)).toEqual([120, 120])
  await expect(openSheetOf(page)).toHaveCount(0)

  // ── 4. B: 同じ世帯の家族。/baby を開くと 120ml（世帯で共有）────────────
  const family = await createApprovedUser(`family-bottle-${uniqueEmail(testInfo.workerIndex)}`)
  const contextB = await browser.newContext()
  // 手で作った context は fixtures/test.ts の page fixture を通らぬ（初回ツアーを抑止する）
  await contextB.addInitScript(() => {
    try {
      localStorage.setItem("irori:tour-seen:v1", "1")
    } catch {
      /* localStorage 不可環境でも E2E を止めない */
    }
  })
  try {
    const { data: joined, error: joinError } = await adminClient()
      .from("profiles")
      .update({ household_id: householdId, role: "member" })
      .eq("id", family.id)
      .select("id")
      .single()
    if (joinError || !joined)
      throw new Error(`family join failed: ${joinError?.message ?? "0 rows"}`)

    const pageB = await contextB.newPage()
    await loginViaMagicLink(pageB, family.email)
    await pageB.goto("/baby")
    const quickB = pageB.getByRole("main")
    await expect(quickB.getByTestId("bottle-default-amount")).toHaveText("120ml", {
      timeout: 15_000,
    })

    // ── 5. A: 「ミルクの量を変更」で 160。過去の 2 件は 120ml のまま ────────
    await expect(milkA).toBeEnabled({ timeout: 15_000 })
    await openOverlay(
      quickA.getByRole("button", { name: "ミルクの量を変更" }),
      page.getByRole("heading", { name: "いつものミルク量" })
    )
    const changeSheet = openSheetOf(page)
    await expect(changeSheet.getByLabel("1回の量（ml）")).toHaveValue("120")
    // 増減ボタン（10ml 刻み）で 140、さらに直接入力で 160
    await changeSheet.getByRole("button", { name: "10ml増やす" }).click()
    await changeSheet.getByRole("button", { name: "10ml増やす" }).click()
    await expect(changeSheet.getByLabel("1回の量（ml）")).toHaveValue("140")
    await changeSheet.getByLabel("1回の量（ml）").fill("160")
    await changeSheet.getByRole("button", { name: "保存する" }).click()
    await expect(
      page.getByText("いつものミルク量を160mlにしました。次の記録から使います")
    ).toBeVisible({ timeout: 15_000 })
    await waitForBottleDefault(householdId, 160)
    await expect(quickA.getByTestId("bottle-default-amount")).toHaveText("160ml")
    rows = await waitForBottleRows(householdId, 2)
    expect(rows.map((r) => r.amount_ml)).toEqual([120, 120])

    // ── 6. A: 通信断でミルク → 圏外トースト → 戻って押し直す → 160ml が 1 件だけ ──
    await expect(milkA).toBeEnabled({ timeout: 15_000 })
    await page.context().setOffline(true)
    await milkA.click()
    await expect(page.getByText(OFFLINE_ACTION_TOAST)).toBeVisible({ timeout: 15_000 })
    await page.context().setOffline(false)
    await expect(milkA).toBeEnabled({ timeout: 15_000 })
    await milkA.click()
    rows = await waitForBottleRows(householdId, 3)
    expect(rows.map((r) => r.amount_ml)).toEqual([120, 120, 160])

    // ── 7. B: 画面復帰で 160ml に変わり、知らせが出る。B のミルクは 160ml ────
    await pageB.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await expect(quickB.getByTestId("bottle-default-amount")).toHaveText("160ml", {
      timeout: 15_000,
    })
    await expect(
      pageB.getByText("いつものミルク量が別の端末で160mlに変更されました")
    ).toBeVisible({ timeout: 15_000 })
    const milkB = quickB.getByRole("button", { name: "ミルク", exact: true })
    await expect(milkB).toBeEnabled({ timeout: 15_000 })
    await milkB.click()
    rows = await waitForBottleRows(householdId, 4)
    expect(rows.map((r) => r.amount_ml)).toEqual([120, 120, 160, 160])
    expect(rows[3].logged_by).toBe(family.id)

    // ── 8. 同時変更: B がシートを開いたまま A が先に 180 を保存 → B の 200 は衝突 ──
    await expect(milkB).toBeEnabled({ timeout: 15_000 })
    await openOverlay(
      quickB.getByRole("button", { name: "ミルクの量を変更" }),
      pageB.getByRole("heading", { name: "いつものミルク量" })
    )
    const sheetB = openSheetOf(pageB)
    await expect(sheetB.getByLabel("1回の量（ml）")).toHaveValue("160")

    await expect(milkA).toBeEnabled({ timeout: 15_000 })
    await openOverlay(
      quickA.getByRole("button", { name: "ミルクの量を変更" }),
      page.getByRole("heading", { name: "いつものミルク量" })
    )
    const sheetA2 = openSheetOf(page)
    await sheetA2.getByLabel("1回の量（ml）").fill("180")
    await sheetA2.getByRole("button", { name: "保存する" }).click()
    await waitForBottleDefault(householdId, 180)

    // B は 160 を見て 200 を保存 → 上書きせず衝突。入力は残り、DB は A の 180 のまま
    await sheetB.getByLabel("1回の量（ml）").fill("200")
    await sheetB.getByRole("button", { name: "保存する" }).click()
    await expect(sheetB.getByRole("alert")).toContainText("先に180mlへ変更されていました", {
      timeout: 15_000,
    })
    await expect(sheetB.getByLabel("1回の量（ml）")).toHaveValue("200")
    await waitForBottleDefault(householdId, 180)

    // B が 180 を見たうえで改めて保存すれば 200 になる（意図した上書き）
    await sheetB.getByRole("button", { name: "保存する" }).click()
    await waitForBottleDefault(householdId, 200)
    await expect(quickB.getByTestId("bottle-default-amount")).toHaveText("200ml", {
      timeout: 15_000,
    })

    // 過去の記録は最後まで書き換わらぬ（量の変更は次の記録から）
    rows = await waitForBottleRows(householdId, 4)
    expect(rows.map((r) => r.amount_ml)).toEqual([120, 120, 160, 160])
  } finally {
    await contextB.close()
    // B は世帯の行を参照しておるゆえ、A の世帯の掃除（fixture）より先に消す
    await cleanupUser(family.id)
  }
})

for (const width of [360, 390]) {
  test(`いつものミルク量: ${width}px・ダークでも釦と量の表示・シートが画面に収まり、押下対象は 44px 以上`, async ({
    page,
    approvedUser,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await page.setViewportSize({ width, height: 800 })
    const householdId = await createHouseholdAsA(page, approvedUser, `E2Eミルク量${width}`)
    const { error } = await adminClient()
      .from("households")
      .update({ bottle_default_ml: 120 })
      .eq("id", householdId)
    if (error) throw new Error(`seed bottle default failed: ${error.message}`)
    await page.reload()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)

    const quick = page.getByRole("main")
    const milk = quick.getByRole("button", { name: "ミルク", exact: true })
    const change = quick.getByRole("button", { name: "ミルクの量を変更" })
    await expect(quick.getByTestId("bottle-default-amount")).toHaveText("120ml", {
      timeout: 15_000,
    })

    // 横スクロールが出ておらぬ
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBeLessThanOrEqual(0)

    for (const [label, target] of [
      ["ミルク", milk],
      ["ミルクの量を変更", change],
    ] as const) {
      const box = await target.boundingBox()
      expect(box, `${label} が描かれておらぬ`).not.toBeNull()
      expect(box!.height, `${label} の高さ`).toBeGreaterThanOrEqual(44)
      expect(box!.width, `${label} の幅`).toBeGreaterThanOrEqual(44)
      expect(box!.x + box!.width, `${label} が画面の右へはみ出す`).toBeLessThanOrEqual(width)
    }
    // 量の文字が釦の中に収まっておる（はみ出して切れておらぬ）
    const amountBox = await quick.getByTestId("bottle-default-amount").boundingBox()
    const milkBox = await milk.boundingBox()
    expect(amountBox!.x).toBeGreaterThanOrEqual(milkBox!.x)
    expect(amountBox!.x + amountBox!.width).toBeLessThanOrEqual(milkBox!.x + milkBox!.width)
    await testInfo.attach(`quick-${width}-dark`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    })

    await openOverlay(change, page.getByRole("heading", { name: "いつものミルク量" }))
    const sheet = openSheetOf(page)
    for (const name of ["10ml減らす", "10ml増やす", "保存する"]) {
      const box = await sheet.getByRole("button", { name }).boundingBox()
      expect(box, `${name} が描かれておらぬ`).not.toBeNull()
      expect(box!.height, `${name} の高さ`).toBeGreaterThanOrEqual(44)
      expect(box!.x + box!.width, `${name} が画面の右へはみ出す`).toBeLessThanOrEqual(width)
    }
    const inputBox = await sheet.getByLabel("1回の量（ml）").boundingBox()
    expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(width)
    await testInfo.attach(`sheet-${width}-dark`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: "image/png",
    })
  })
}
