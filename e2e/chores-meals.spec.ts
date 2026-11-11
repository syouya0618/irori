import { test, expect } from "./fixtures/test"
import { adminClient, cleanupUser, createApprovedUser, loginViaMagicLink, uniqueEmail } from "./fixtures/auth"
import type { Page } from "@playwright/test"

/**
 * ごはん E2E（要件台帳 C-23 / C-31 / C-33 / C-37 / C-41 / C-47 / C-71 / C-72 / V-C1 / V-C2 / V-C3 /
 * V-C5 / V-BROWSER）。
 *
 * ① 食材を登録 → 「今あるもので」に、その食材で作れる料理が出る
 * ② 「金曜はカレー」を読み取り → 採用して 7 日分 → 作り直しても金曜のカレーは固定のまま →
 *    確定 → 買い物リスト → 購入チェック（在庫は増えない）→ 同じ世帯の 2 人目から購入済みが見える →
 *    2 人目のチェックが 1 人目へ反映される
 * ③ 今日に手で料理（豚こま 500g）→ 確定 → 300g だけ買う（不足 200g）→ 「作った」→ 取り消し →
 *    購入の記録 300g は残り、不足は元の 200g（在庫は増えない）
 * ③' 同じ流れで、作る前に家族の端末で開いた詳細から、作った後に合計 400g（+100g）を保存 → 取り消し →
 *    100g は残り、不足は 100g（版の違いが充当の記録だけなら、購入の操作は通る）
 * ④ レシピ詳細から金曜にカレーを固定 → 確定 → 食材登録 → 「今あるもので」から副菜を**既存の日（固定した
 *    カレーが在る金曜）**へ足す（カレーと固定は残る・二重押しで 2 品にならない・買い物は副菜の差分だけ）→
 *    7 日分の献立 → 確定 → 買い物 → 再読込で残る
 * ⑤ 卵アレルギーの世帯で、材料にマヨネーズ（卵を含む）を入れた手動料理は警告され、自動の確定に混ざらない
 *    （同じ世帯の 2 アカウントでの献立・購入の共有は ② が見る）
 *
 * AI 補助は使わない（env 未設定の既定で、規則による読み取りと自動献立だけで通る）。
 * 世帯は fixture（approvedUser）がテストごとに作って消す（households の CASCADE でごはんの行も消える）。
 * 待機は役割・名前と DB の断面で行い、固定の sleep は使わない。
 */

test.setTimeout(240_000)

const MIN_TOUCH_PX = 44

/** approvedUser の世帯 ID を DB 断面で待つ。 */
async function waitForHouseholdId(userId: string): Promise<string> {
  const admin = adminClient()
  let householdId = ""
  await expect(async () => {
    const { data: profile, error } = await admin.from("profiles").select("household_id").eq("id", userId).single()
    if (error) throw new Error(`profile lookup failed: ${error.message}`)
    if (!profile?.household_id) throw new Error("household not ready")
    householdId = profile.household_id
  }).toPass({ timeout: 15_000 })
  return householdId
}

async function setupHousehold(page: Page, userId: string, email: string, name: string): Promise<string> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill(name)
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(userId)
  await page.setViewportSize({ width: 390, height: 844 })
  return householdId
}

/** 献立の版（行が無い世帯は 0）。 */
async function planRevision(householdId: string): Promise<number> {
  const { data, error } = await adminClient()
    .from("dinner_plan_state")
    .select("revision")
    .eq("household_id", householdId)
    .maybeSingle()
  if (error) throw new Error(`dinner_plan_state lookup failed: ${error.message}`)
  return typeof data?.revision === "number" ? data.revision : 0
}

/** 献立の版が `after` より進むのを DB 断面で待つ。 */
async function waitForRevisionAfter(householdId: string, after: number): Promise<number> {
  let revision = after
  await expect(async () => {
    revision = await planRevision(householdId)
    if (revision <= after) throw new Error(`plan revision is still ${revision}`)
  }).toPass({ timeout: 20_000 })
  return revision
}

interface EntryRow {
  id: string
  plan_date: string
  recipe_id: string | null
  pinned: boolean
  status: string
}

async function planEntries(householdId: string): Promise<EntryRow[]> {
  const { data, error } = await adminClient()
    .from("dinner_plan_entries")
    .select("id, plan_date, recipe_id, pinned, status")
    .eq("household_id", householdId)
    .order("plan_date", { ascending: true })
  if (error) throw new Error(`dinner_plan_entries lookup failed: ${error.message}`)
  return (data ?? []) as EntryRow[]
}

/** 押下対象（button / role=button / a / checkbox / radio）の 44px を実測して、違反を集める。 */
async function measureTouchTargets(page: Page, label: string, violations: string[]): Promise<void> {
  const targets = page.locator('button, [role="button"], a[href], input[type="checkbox"], input[type="radio"]')
  const count = await targets.count()
  for (let i = 0; i < count; i++) {
    const element = targets.nth(i)
    const box = await element.boundingBox()
    if (box === null || box.width === 0 || box.height === 0) continue
    if (box.width >= MIN_TOUCH_PX && box.height >= MIN_TOUCH_PX) continue
    const name =
      (await element.getAttribute("aria-label")) ?? (await element.textContent())?.trim().slice(0, 24) ?? "(名前不明)"
    violations.push(`${label}: "${name}" = ${Math.round(box.width)}x${Math.round(box.height)}px`)
  }
}

test("ごはん: 食材を登録すると、「今あるもので」にその食材で作れる料理が出る", async ({ page, approvedUser }) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん食材世帯")

  // ── 1. 家事 → ごはん（今夜）。主な 2 つの操作から「今あるもので」へ ───────────────
  await page.getByRole("link", { name: "家事", exact: true }).click()
  await expect(page).toHaveURL(/\/chores$/, { timeout: 15_000 })
  await page.getByRole("link", { name: /^ごはん/ }).click()
  await expect(page).toHaveURL(/\/chores\/meals$/, { timeout: 15_000 })
  await expect(page.getByRole("heading", { level: 1, name: "ごはん" })).toBeVisible()
  await expect(page.getByTestId("tonight-state")).toContainText("まだ決まっていません")
  await page.getByRole("link", { name: /今あるもので作る/ }).click()
  await expect(page).toHaveURL(/\/chores\/meals\/now$/, { timeout: 15_000 })

  // 食材が無いうちは、候補を捏造せず登録へ誘導する
  await expect(page.getByText("食材がまだ登録されていません")).toBeVisible()
  await expect(page.getByTestId("now-candidate")).toHaveCount(0)
  await page.getByRole("link", { name: /食材を登録する/ }).click()
  await expect(page).toHaveURL(/\/chores\/meals\/pantry$/, { timeout: 15_000 })

  // ── 2. まとめ入力 → 読み取り結果の確認 → 登録 ───────────────────────────────
  await page.getByLabel("家にある食材").fill("鮭 2切れ、塩 小さじ2、こめ油 大さじ2")
  await page.getByRole("button", { name: "内容を確認" }).click()
  await expect(page.getByTestId("pantry-preview-resolved")).toHaveText("3件", { timeout: 15_000 })
  await expect(page.getByTestId("pantry-preview-unresolved")).toHaveText("0件")
  // 確認の時点では、まだ保存されていない
  {
    const { data, error } = await adminClient().from("pantry_items").select("id").eq("household_id", householdId)
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  }
  await page.getByRole("button", { name: "3件を登録" }).click()
  await expect(page.getByRole("status").filter({ hasText: "3件の食材を登録しました。" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("heading", { name: "登録した食材（3件）" })).toBeVisible({ timeout: 15_000 })
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("pantry_items")
      .select("ingredient_id")
      .eq("household_id", householdId)
    if (error) throw new Error(`pantry_items lookup failed: ${error.message}`)
    const ids = (data ?? []).map((row) => row.ingredient_id).sort()
    if (JSON.stringify(ids) !== JSON.stringify(["rice_oil", "salmon", "salt"])) {
      throw new Error(`unexpected pantry rows: ${JSON.stringify(ids)}`)
    }
  }).toPass({ timeout: 15_000 })

  // ── 3. 「今あるもので」: 登録した食材で作れる料理が、買い足しの枠ではない所に出る ──────
  await page.getByRole("navigation", { name: "ごはんの画面" }).getByRole("link", { name: "今あるもので" }).click()
  await expect(page).toHaveURL(/\/chores\/meals\/now$/, { timeout: 15_000 })
  const candidate = page.getByTestId("now-candidate").filter({ hasText: "鮭の塩焼き" })
  await expect(candidate).toBeVisible({ timeout: 15_000 })
  // 必須の食材（鮭・塩・こめ油）は全て在るので、「買い足せば作れる」には入らない
  await expect(page.getByRole("region", { name: "買い足せば作れる" }).getByText("鮭の塩焼き")).toHaveCount(0)
  // 再読込しても同じ（保存されている）
  await page.reload()
  await expect(page.getByTestId("now-candidate").filter({ hasText: "鮭の塩焼き" })).toBeVisible({ timeout: 15_000 })
  // 提案を見ただけでは、献立も在庫も変わらない
  expect(await planEntries(householdId)).toHaveLength(0)
})

test("ごはん: 金曜を固定 → 7 日分 → 確定 → 買い物 → 家族の端末に購入チェックが見える", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん献立世帯")
  const admin = adminClient()
  const violations: string[] = []

  // ── 1. 献立の画面。AI 補助は未設定でも、作成の釦は使える ───────────────────────
  await page.goto("/chores/meals/plan")
  await expect(page.getByRole("heading", { level: 2, name: "献立を作る" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("meal-ai-status")).toContainText("自動献立はそのまま使えます")
  await expect(page.getByText(/標準の2人分で計算しています/)).toBeVisible()
  const createButton = page.getByRole("button", { name: "7日分の献立を作る" })
  await expect(createButton).toBeEnabled({ timeout: 15_000 })

  // ── 2. 希望「金曜はカレー」を読み取る（この時点では献立を変えない）─────────────────
  await page.getByLabel("希望（任意）").fill("金曜はカレー")
  await page.getByRole("button", { name: "希望を反映" }).click()
  const reading = page.getByRole("region", { name: "希望の読み取り結果" })
  await expect(reading).toContainText("「カレーライス」に固定", { timeout: 20_000 })
  await expect(reading).toContainText("この時点では、献立は変わっていません")
  expect(await planEntries(householdId)).toHaveLength(0)
  expect(await planRevision(householdId)).toBe(0)

  // ── 3. 採用して 7 日分を作る。金曜はカレーで固定 ──────────────────────────────
  await reading.getByRole("button", { name: "この内容で献立を作る" }).click()
  await expect(page.getByRole("status").filter({ hasText: "7日分の献立を作りました" })).toBeVisible({ timeout: 30_000 })
  const firstRevision = await waitForRevisionAfter(householdId, 0)
  const friday = page.getByTestId("plan-day").filter({ has: page.getByRole("heading", { name: /（金）/ }) })
  await expect(friday).toHaveCount(1)
  await expect(friday.getByRole("button", { name: "カレーライスの固定を解除" })).toBeVisible({ timeout: 15_000 })
  // 固定した料理は差し替えられない（解除は明示の操作）
  await expect(friday.getByRole("button", { name: "カレーライスを差し替え" })).toBeDisabled()
  let entries = await planEntries(householdId)
  const curry = entries.filter((entry) => entry.recipe_id === "curry_rice")
  expect(curry).toHaveLength(1)
  expect(curry[0].pinned).toBe(true)
  // 7 日とも主菜と副菜が入る（通常条件の初期カタログで成立する）
  expect(new Set(entries.map((entry) => entry.plan_date)).size).toBe(7)
  expect(entries.every((entry) => entry.status === "proposed")).toBe(true)
  await expect(page.getByTestId("plan-gap")).toHaveCount(0)
  await measureTouchTargets(page, "献立（料理つき）", violations)

  // ── 4. もう一度 7 日分を作り直しても、金曜のカレーは同じ行のまま固定で残る ───────────
  await expect(createButton).toBeEnabled({ timeout: 15_000 })
  await createButton.click()
  await waitForRevisionAfter(householdId, firstRevision)
  await expect(friday.getByRole("button", { name: "カレーライスの固定を解除" })).toBeVisible({ timeout: 15_000 })
  entries = await planEntries(householdId)
  const curryAfter = entries.filter((entry) => entry.recipe_id === "curry_rice")
  expect(curryAfter).toEqual([{ ...curry[0] }])

  // ── 5. 確定 → 買い物リスト。確定するまで、買い物の自動項目は無い ──────────────────
  {
    const { data, error } = await admin.from("grocery_items").select("id").eq("household_id", householdId)
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  }
  const confirmButton = page.getByRole("button", { name: "この献立で確定" })
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 })
  await confirmButton.click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 30_000 })
  await expect(async () => {
    const rows = await planEntries(householdId)
    if (rows.some((row) => row.status !== "confirmed")) throw new Error("some entries are not confirmed yet")
  }).toPass({ timeout: 20_000 })
  await page.getByRole("link", { name: "買い物リストを見る" }).click()
  await expect(page).toHaveURL(/\/chores\/meals\/shopping$/, { timeout: 15_000 })

  // ── 6. 売場ごとに並び、カレーの材料が入っている。購入チェック（在庫は増えない）────────
  await expect(page.getByRole("heading", { level: 2, name: /^まだ買うもの（\d+件）$/ })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("shopping-section").first()).toBeVisible()
  const rouxBox = page.getByRole("checkbox", { name: "カレールウを購入済みにする" })
  await expect(rouxBox).toBeVisible({ timeout: 15_000 })
  await expect(rouxBox).not.toBeChecked()
  // どの日のどの料理に使うかを確かめられる
  const rouxRow = page.getByTestId("shopping-item").filter({ hasText: "カレールウ" })
  await rouxRow.getByRole("button", { name: /^使う料理/ }).click()
  await expect(rouxRow).toContainText("カレーライス")
  await measureTouchTargets(page, "買い物（項目つき）", violations)

  await rouxBox.click()
  await expect(
    page.getByRole("status").filter({ hasText: "「カレールウ」を購入済みにしました。在庫は変えていません。" }),
  ).toBeVisible({ timeout: 15_000 })
  await expect(async () => {
    const { data, error } = await admin
      .from("grocery_items")
      .select("purchased, purchased_quantity")
      .eq("household_id", householdId)
      .eq("name", "カレールウ")
    if (error) throw new Error(`grocery_items lookup failed: ${error.message}`)
    if (data?.length !== 1 || data[0].purchased !== true || !(Number(data[0].purchased_quantity) > 0)) {
      throw new Error(`purchase is not stored yet: ${JSON.stringify(data)}`)
    }
  }).toPass({ timeout: 15_000 })
  // 購入済みにしても、食材（在庫）は増えない（在庫へ足すのは別の操作）
  {
    const { data, error } = await admin.from("pantry_items").select("id").eq("household_id", householdId)
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  }
  const purchasedRegion = page.getByRole("region", { name: /^購入済み（\d+件）$/ })
  await expect(purchasedRegion.getByText("カレールウ")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("checkbox", { name: "カレールウを購入済みにする" })).toBeChecked()

  // 詳細シート（量の調整・メモ・売場・在庫へ追加）の 44px
  await page.getByRole("button", { name: "カレールウの詳細を開く" }).click()
  const detail = page.getByRole("dialog")
  await expect(detail.getByTestId("restock-section")).toContainText("購入チェックとは別の操作です")
  await measureTouchTargets(page, "買い物の詳細シート", violations)
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)

  // ── 7. 同じ世帯の 2 人目: 買い物を開くと、購入済みが見える。献立も同じ ───────────────
  const family = await createApprovedUser(`family-meals-${uniqueEmail(testInfo.workerIndex)}`)
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
    const { data: joined, error: joinError } = await admin
      .from("profiles")
      .update({ household_id: householdId, role: "member" })
      .eq("id", family.id)
      .select("id")
      .single()
    if (joinError || !joined) throw new Error(`family join failed: ${joinError?.message ?? "0 rows"}`)

    const pageB = await contextB.newPage()
    await loginViaMagicLink(pageB, family.email)
    await pageB.setViewportSize({ width: 390, height: 844 })
    await pageB.goto("/chores/meals/shopping")
    await expect(pageB.getByRole("region", { name: /^購入済み（\d+件）$/ }).getByText("カレールウ")).toBeVisible({
      timeout: 15_000,
    })
    await expect(pageB.getByRole("checkbox", { name: "カレールウを購入済みにする" })).toBeChecked()
    // 反映のタイミングを文で示している
    await expect(pageB.getByText(/ほかの端末での変更は、この画面に戻ったときと/)).toBeVisible()

    await pageB.goto("/chores/meals/plan")
    const fridayB = pageB.getByTestId("plan-day").filter({ has: pageB.getByRole("heading", { name: /（金）/ }) })
    await expect(fridayB.getByText("カレーライス")).toBeVisible({ timeout: 15_000 })
    await expect(fridayB.getByRole("button", { name: "カレーライスの固定を解除" })).toBeVisible()

    // ── 8. 2 人目が別の項目を購入済みにすると、1 人目の画面へ反映される（画面復帰で再取得）──
    await pageB.goto("/chores/meals/shopping")
    const porkBoxB = pageB.getByRole("checkbox", { name: "豚こま切れ肉を購入済みにする" })
    await expect(porkBoxB).toBeEnabled({ timeout: 15_000 })
    await porkBoxB.click()
    await expect(async () => {
      const { data, error } = await admin
        .from("grocery_items")
        .select("purchased")
        .eq("household_id", householdId)
        .eq("name", "豚こま切れ肉")
      if (error) throw new Error(`grocery_items lookup failed: ${error.message}`)
      if (data?.length !== 1 || data[0].purchased !== true) throw new Error("family purchase is not stored yet")
    }).toPass({ timeout: 15_000 })

    // 1 人目の画面は、画面復帰（と約 30 秒ごとの再取得）で取り込む。復帰の合図を送って待つ
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
    await expect(page.getByRole("checkbox", { name: "豚こま切れ肉を購入済みにする" })).toBeChecked({ timeout: 20_000 })
    // 同じ項目を 2 人が押しても、行は 1 件のまま（重複書込みをしない）
    {
      const { data, error } = await admin
        .from("grocery_items")
        .select("id")
        .eq("household_id", householdId)
        .eq("name", "豚こま切れ肉")
      expect(error).toBeNull()
      expect(data ?? []).toHaveLength(1)
    }
  } finally {
    await contextB.close()
    await cleanupUser(family.id)
  }

  expect(violations, `44px 未満の押下対象:\n  ${violations.join("\n  ")}`).toEqual([])
})

/** JST の今日（"YYYY-MM-DD"。日付文字列を Date へ渡さぬ）。playwright.config の timezoneId と一致。 */
function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date())
}

interface GroceryFacts {
  purchased_quantity: number
  consumed_quantity: number
  still_needed: boolean
}

/** 買い物の 1 項目の、購入の事実と作った料理への充当（名前で引く。1 行であること）。 */
async function groceryFacts(householdId: string, name: string): Promise<GroceryFacts> {
  const { data, error } = await adminClient()
    .from("grocery_items")
    .select("purchased_quantity, consumed_quantity, still_needed")
    .eq("household_id", householdId)
    .eq("name", name)
  if (error) throw new Error(`grocery_items lookup failed: ${error.message}`)
  if (data?.length !== 1) throw new Error(`expected one grocery row for ${name}: ${JSON.stringify(data)}`)
  return {
    purchased_quantity: Number(data[0].purchased_quantity),
    consumed_quantity: Number(data[0].consumed_quantity),
    still_needed: data[0].still_needed,
  }
}

test("ごはん: 一部を買って「作った」→ 取り消すと、買い物の不足が元へ戻る（購入の記録は消えず、在庫は増えない）", async ({
  page,
  approvedUser,
}) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん取り消し世帯")
  const today = todayJst()
  const DISH = "E2E豚の炒め物"
  const PORK = "豚こま切れ肉"

  // ── 1. 今日に手で料理を足す（豚こま切れ肉 500g）→ 確定 ─────────────────────────
  await page.goto("/chores/meals/plan")
  const todayCard = page.locator(`[data-testid="plan-day"][data-date="${today}"]`)
  await expect(todayCard).toHaveCount(1, { timeout: 15_000 })
  await todayCard.getByRole("button", { name: /に料理を手で追加$/ }).click()
  const addSheet = page.getByRole("dialog")
  await addSheet.getByLabel("料理名").fill(DISH)
  await addSheet.getByRole("button", { name: "材料を足す" }).click()
  await addSheet.getByLabel("材料 1 の名前").fill(PORK)
  await addSheet.getByLabel("材料 1 の量").fill("500")
  await expect(addSheet.getByLabel("材料 1 の単位")).toHaveValue("g")
  await addSheet.getByRole("button", { name: "この料理を追加" }).click()
  await expect(page.getByRole("status").filter({ hasText: `「${DISH}」を献立へ追加しました。` })).toBeVisible({
    timeout: 15_000,
  })
  await expect(todayCard.getByRole("button", { name: `${DISH}を「作った」にする` })).toBeVisible({ timeout: 15_000 })

  const confirmButton = page.getByRole("button", { name: "この献立で確定" })
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 })
  await confirmButton.click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 30_000 })
  let entryId = ""
  await expect(async () => {
    const rows = await planEntries(householdId)
    if (rows.length !== 1 || rows[0].status !== "confirmed") throw new Error(`entry not confirmed yet: ${JSON.stringify(rows)}`)
    entryId = rows[0].id
  }).toPass({ timeout: 20_000 })

  // ── 2. 買い物: 必要 500g のうち 300g を買う → 不足 200g ──────────────────────────
  await page.goto("/chores/meals/shopping")
  const porkRow = page.getByTestId("shopping-item").filter({ hasText: PORK })
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("あと 500g", { timeout: 15_000 })
  await page.getByRole("button", { name: `${PORK}の詳細を開く` }).click()
  const detail = page.getByRole("dialog")
  await detail.getByLabel("買った量（合計・g）").fill("300")
  await detail.getByRole("button", { name: "買った量を保存" }).click()
  await expect(page.getByRole("status").filter({ hasText: `「${PORK}」の買った量を記録しました。` })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 300g・あと 200g", { timeout: 15_000 })
  expect(await groceryFacts(householdId, PORK)).toEqual({ purchased_quantity: 300, consumed_quantity: 0, still_needed: true })

  // ── 3. 献立: 「作った」。購入の記録（300g）は書き換えず、この料理に使った分として数える ─────
  await page.goto("/chores/meals/plan")
  await todayCard.getByRole("button", { name: `${DISH}を「作った」にする` }).click()
  await expect(async () => {
    const rows = await planEntries(householdId)
    if (rows[0]?.status !== "cooked") throw new Error("entry is not cooked yet")
    const facts = await groceryFacts(householdId, PORK)
    if (facts.consumed_quantity !== 300) throw new Error(`consumption not recorded yet: ${JSON.stringify(facts)}`)
  }).toPass({ timeout: 20_000 })
  expect(await groceryFacts(householdId, PORK)).toEqual({ purchased_quantity: 300, consumed_quantity: 300, still_needed: false })

  // 「作った」の後は、その料理のシートが開く。取り消しの文は戻り先（確定）を言う
  const entrySheet = page.getByRole("dialog")
  await expect(entrySheet.getByText(/「作った」を取り消して、確定へ戻します。/)).toBeVisible({ timeout: 15_000 })
  await entrySheet.getByRole("button", { name: "「作った」を取り消す" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: `「${DISH}」の記録を取り消し、作る前の状態へ戻しました。` }),
  ).toBeVisible({ timeout: 15_000 })

  // ── 4. 取り消しの後: 購入の記録はそのまま、使った分だけが戻り、不足は元の 200g ─────────
  await expect(async () => {
    const rows = await planEntries(householdId)
    if (rows.length !== 1 || rows[0].id !== entryId || rows[0].status !== "confirmed") {
      throw new Error(`entry is not back to confirmed: ${JSON.stringify(rows)}`)
    }
    const facts = await groceryFacts(householdId, PORK)
    if (facts.consumed_quantity !== 0) throw new Error(`consumption not reverted yet: ${JSON.stringify(facts)}`)
  }).toPass({ timeout: 20_000 })
  expect(await groceryFacts(householdId, PORK)).toEqual({ purchased_quantity: 300, consumed_quantity: 0, still_needed: true })

  await page.goto("/chores/meals/shopping")
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 300g・あと 200g", { timeout: 15_000 })
  await expect(page.getByRole("checkbox", { name: `${PORK}を購入済みにする` })).not.toBeChecked()
  // 作った・取り消しのどちらでも、食材（在庫）は増えない
  {
    const { data, error } = await adminClient().from("pantry_items").select("id").eq("household_id", householdId)
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  }
})

test("ごはん: 作る前に家族の端末で開いた買い物から、作った後に +100g → 取り消しても 100g は残り、不足は 100g", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん買い足し世帯")
  const admin = adminClient()
  const today = todayJst()
  const DISH = "E2E豚の生姜焼き"
  const PORK = "豚こま切れ肉"

  // ── 1. 今日に手で料理を足す（豚こま切れ肉 500g）→ 確定 → 300g だけ買う（不足 200g）─────────
  await page.goto("/chores/meals/plan")
  const todayCard = page.locator(`[data-testid="plan-day"][data-date="${today}"]`)
  await expect(todayCard).toHaveCount(1, { timeout: 15_000 })
  await todayCard.getByRole("button", { name: /に料理を手で追加$/ }).click()
  const addSheet = page.getByRole("dialog")
  await addSheet.getByLabel("料理名").fill(DISH)
  await addSheet.getByRole("button", { name: "材料を足す" }).click()
  await addSheet.getByLabel("材料 1 の名前").fill(PORK)
  await addSheet.getByLabel("材料 1 の量").fill("500")
  await addSheet.getByRole("button", { name: "この料理を追加" }).click()
  await expect(todayCard.getByRole("button", { name: `${DISH}を「作った」にする` })).toBeVisible({ timeout: 15_000 })
  await page.getByRole("button", { name: "この献立で確定" }).click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 30_000 })
  await expect(async () => {
    const rows = await planEntries(householdId)
    if (rows.length !== 1 || rows[0].status !== "confirmed") throw new Error(`entry not confirmed yet: ${JSON.stringify(rows)}`)
  }).toPass({ timeout: 20_000 })

  await page.goto("/chores/meals/shopping")
  const porkRow = page.getByTestId("shopping-item").filter({ hasText: PORK })
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("あと 500g", { timeout: 15_000 })
  await page.getByRole("button", { name: `${PORK}の詳細を開く` }).click()
  await page.getByRole("dialog").getByLabel("買った量（合計・g）").fill("300")
  await page.getByRole("dialog").getByRole("button", { name: "買った量を保存" }).click()
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 300g・あと 200g", { timeout: 15_000 })

  // ── 2. 家族の端末: 作る前に買い物を開き、豚こま切れ肉の詳細を開いたままにする（開いている間は自動で取り直さない）──
  const family = await createApprovedUser(`family-meals-buy-more-${uniqueEmail(testInfo.workerIndex)}`)
  const contextB = await browser.newContext()
  await contextB.addInitScript(() => {
    try {
      localStorage.setItem("irori:tour-seen:v1", "1")
    } catch {
      /* localStorage 不可環境でも E2E を止めない */
    }
  })
  try {
    const { data: joined, error: joinError } = await admin
      .from("profiles")
      .update({ household_id: householdId, role: "member" })
      .eq("id", family.id)
      .select("id")
      .single()
    if (joinError || !joined) throw new Error(`family join failed: ${joinError?.message ?? "0 rows"}`)
    const pageB = await contextB.newPage()
    await loginViaMagicLink(pageB, family.email)
    await pageB.setViewportSize({ width: 390, height: 844 })
    await pageB.goto("/chores/meals/shopping")
    await pageB.getByRole("button", { name: `${PORK}の詳細を開く` }).click({ timeout: 15_000 })
    const sheetB = pageB.getByRole("dialog")
    const amountB = sheetB.getByLabel("買った量（合計・g）")
    await expect(amountB).toHaveValue("300")

    // ── 3. 1 人目: 「作った」。使った 300g が充当として記録され、買い物の行の版が進む ───────────
    await page.goto("/chores/meals/plan")
    await todayCard.getByRole("button", { name: `${DISH}を「作った」にする` }).click()
    await expect(async () => {
      const facts = await groceryFacts(householdId, PORK)
      // 「作った」の直後の同期まで終わった（献立から不要になった）
      if (facts.consumed_quantity !== 300 || facts.still_needed) throw new Error(`cooking not settled yet: ${JSON.stringify(facts)}`)
    }).toPass({ timeout: 20_000 })

    // ── 4. 家族の端末（作る前の画面のまま）: 100g 買い足して、合計 400g を保存できる ───────────────
    await amountB.fill("400")
    await sheetB.getByRole("button", { name: "買った量を保存" }).click()
    await expect(pageB.getByRole("status").filter({ hasText: `「${PORK}」の買った量を記録しました。` })).toBeVisible({
      timeout: 15_000,
    })
    expect(await groceryFacts(householdId, PORK)).toEqual({ purchased_quantity: 400, consumed_quantity: 300, still_needed: false })

    // ── 5. 1 人目: 「作った」を取り消す → 買い足した 100g は残り、500g に対する不足は 100g ───────────
    const entrySheet = page.getByRole("dialog")
    await entrySheet.getByRole("button", { name: "「作った」を取り消す" }).click({ timeout: 15_000 })
    await expect(async () => {
      const facts = await groceryFacts(householdId, PORK)
      if (facts.consumed_quantity !== 0 || !facts.still_needed) throw new Error(`undo not reflected yet: ${JSON.stringify(facts)}`)
    }).toPass({ timeout: 20_000 })
    expect(await groceryFacts(householdId, PORK)).toEqual({ purchased_quantity: 400, consumed_quantity: 0, still_needed: true })
    await page.goto("/chores/meals/shopping")
    await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 400g・あと 100g", { timeout: 15_000 })
  } finally {
    await contextB.close()
    await cleanupUser(family.id)
  }
})

/** "YYYY-MM-DD" に日数を足す（UTC の暦で数える。日付文字列を Date へ渡さぬ）。 */
function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** 今日から 7 日のうちの金曜（今日が金曜なら今日）。 */
function upcomingFriday(today: string): string {
  for (let offset = 0; offset < 7; offset++) {
    const date = addDaysYmd(today, offset)
    const [y, m, d] = date.split("-").map(Number)
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 5) return date
  }
  throw new Error(`no Friday within a week of ${today}`)
}

interface PlanRowFull extends EntryRow {
  role: string
}

async function planRows(householdId: string): Promise<PlanRowFull[]> {
  const { data, error } = await adminClient()
    .from("dinner_plan_entries")
    .select("id, plan_date, role, recipe_id, pinned, status")
    .eq("household_id", householdId)
    .order("plan_date", { ascending: true })
  if (error) throw new Error(`dinner_plan_entries lookup failed: ${error.message}`)
  return (data ?? []) as PlanRowFull[]
}

/** 買い物の自動項目の、名前ごとの必要量と出所の枠（`sources[].entryId`）。 */
async function groceryNeeds(householdId: string): Promise<Map<string, { required: number | null; entryIds: string[] }>> {
  const { data, error } = await adminClient()
    .from("grocery_items")
    .select("name, required_quantity, sources")
    .eq("household_id", householdId)
    .eq("origin", "auto")
  if (error) throw new Error(`grocery_items lookup failed: ${error.message}`)
  const needs = new Map<string, { required: number | null; entryIds: string[] }>()
  for (const row of data ?? []) {
    const sources = Array.isArray(row.sources) ? (row.sources as { entryId?: string | null }[]) : []
    needs.set(row.name, {
      required: row.required_quantity === null ? null : Number(row.required_quantity),
      entryIds: sources.map((source) => source.entryId ?? ""),
    })
  }
  return needs
}

test("ごはん ④: 今あるもので選んだ副菜を、固定したカレーの在る金曜へ足す → 7 日分 → 買い物（再読込で残る）", async ({
  page,
  approvedUser,
}) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん追加世帯")
  const friday = upcomingFriday(todayJst())

  // ── 1. レシピ詳細から、金曜（献立なし）にカレーを固定して入れる ─────────────────────
  await page.goto("/chores/meals/recipes/curry_rice")
  await page.getByRole("button", { name: "カレーライスを献立に入れる" }).click()
  const curryPanel = page.getByRole("group", { name: "カレーライスを献立に入れる日" })
  await curryPanel.getByLabel("入れる日").selectOption(friday)
  const curryAdd = curryPanel.getByRole("button", { name: "この日の献立に入れる" })
  await expect(curryAdd).toBeEnabled({ timeout: 15_000 })
  await curryAdd.click()
  await expect(page.getByTestId("add-to-plan-result").getByRole("status")).toContainText("「カレーライス」を", {
    timeout: 15_000,
  })
  let curryId = ""
  await expect(async () => {
    const rows = await planRows(householdId)
    if (rows.length !== 1 || rows[0].recipe_id !== "curry_rice" || rows[0].plan_date !== friday || !rows[0].pinned) {
      throw new Error(`curry is not pinned on Friday yet: ${JSON.stringify(rows)}`)
    }
    curryId = rows[0].id
  }).toPass({ timeout: 15_000 })

  // ── 2. 献立で確定 → カレーの材料が買い物に入る ─────────────────────────────────
  await page.goto("/chores/meals/plan")
  const confirmButton = page.getByRole("button", { name: "この献立で確定" })
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 })
  await confirmButton.click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 30_000 })
  let before = new Map<string, { required: number | null; entryIds: string[] }>()
  await expect(async () => {
    const rows = await planRows(householdId)
    if (rows.some((row) => row.status !== "confirmed")) throw new Error("curry is not confirmed yet")
    before = await groceryNeeds(householdId)
    if (!before.has("カレールウ")) throw new Error(`curry items are not synced yet: ${JSON.stringify([...before.keys()])}`)
  }).toPass({ timeout: 20_000 })

  // ── 3. 食材を登録（ほうれん草のおひたしは、かつお節だけを買い足せば作れる）────────────────
  // 前提は vitest（catalog-integration の「E2E ④ の前提」）が固定: この在庫で、おひたしは「買い足せば作れる」の
  // 表示の 3 件に入り、足りないのはかつお節だけ
  await page.goto("/chores/meals/pantry")
  await page.getByLabel("家にある食材").fill("ほうれん草 1束、しょうゆ 大さじ2")
  await page.getByRole("button", { name: "内容を確認" }).click()
  await expect(page.getByTestId("pantry-preview-resolved")).toHaveText("2件", { timeout: 15_000 })
  await page.getByRole("button", { name: "2件を登録" }).click()
  await expect(page.getByRole("status").filter({ hasText: "2件の食材を登録しました。" })).toBeVisible({ timeout: 15_000 })

  // ── 4. 今あるもので → 副菜を、固定したカレーの在る金曜へ足す ──────────────────────
  await page.getByRole("navigation", { name: "ごはんの画面" }).getByRole("link", { name: "今あるもので" }).click()
  await expect(page).toHaveURL(/\/chores\/meals\/now$/, { timeout: 15_000 })
  const candidate = page.getByTestId("now-candidate").filter({ hasText: "ほうれん草のおひたし" }).first()
  await expect(candidate).toBeVisible({ timeout: 15_000 })
  await candidate.getByRole("button", { name: "ほうれん草のおひたしを献立に入れる" }).click()
  const panel = candidate.getByRole("group", { name: "ほうれん草のおひたしを献立に入れる日" })
  await panel.getByLabel("入れる日").selectOption(friday)
  // 在る料理（固定・確定のカレー）はそのまま残すと、押す前に言う
  await expect(panel.getByTestId("add-to-plan-keeps")).toContainText("主菜「カレーライス」（確定・固定）")
  await expect(panel.getByTestId("add-to-plan-keeps")).toContainText("そのまま残し")
  await expect(panel.getByText(/確定済みのため、確定として足し/)).toBeVisible()
  const addButton = panel.getByRole("button", { name: "この日の献立に入れる" })
  await expect(addButton).toBeEnabled({ timeout: 15_000 })
  // 二重に押しても 1 品だけ（送信中は次の操作を受けない。サーバーも同じ料理を二重に足さない）
  await addButton.dblclick()
  await expect(candidate.getByTestId("add-to-plan-result").getByRole("status")).toContainText(
    "「ほうれん草のおひたし」を",
    { timeout: 15_000 },
  )
  let sideId = ""
  await expect(async () => {
    const rows = await planRows(householdId)
    const sides = rows.filter((row) => row.recipe_id === "spinach_ohitashi")
    if (sides.length !== 1) throw new Error(`expected one side dish: ${JSON.stringify(rows)}`)
    sideId = sides[0].id
  }).toPass({ timeout: 15_000 })
  {
    const rows = await planRows(householdId)
    expect(rows).toHaveLength(2)
    // カレーは同じ行のまま、固定・確定で残る。副菜は金曜の副菜として固定・確定（確定済みの日に合わせる）
    expect(rows.find((row) => row.id === curryId)).toMatchObject({ plan_date: friday, pinned: true, status: "confirmed" })
    expect(rows.find((row) => row.id === sideId)).toMatchObject({
      plan_date: friday,
      role: "side",
      pinned: true,
      status: "confirmed",
    })
  }
  // 買い物: 増えたのは副菜の差分（在庫に無いかつお節）だけで、その出所は足した副菜。カレーの分の必要量はそのまま。
  // 在庫で足りるほうれん草・しょうゆは増えない
  await expect(async () => {
    const after = await groceryNeeds(householdId)
    const added = [...after.keys()].filter((name) => !before.has(name)).sort()
    if (JSON.stringify(added) !== JSON.stringify(["かつお節"])) throw new Error(`unexpected new items: ${JSON.stringify(added)}`)
    if (JSON.stringify(after.get("かつお節")?.entryIds) !== JSON.stringify([sideId])) {
      throw new Error(`かつお節 is not sourced from the side dish: ${JSON.stringify(after.get("かつお節"))}`)
    }
    for (const [name, need] of before) {
      if (after.get(name)?.required !== need.required) throw new Error(`${name} changed: ${JSON.stringify(after.get(name))}`)
    }
  }).toPass({ timeout: 15_000 })

  // ── 5. 献立の画面: 7 日分を作っても、金曜のカレーと副菜は同じ行のまま残る ─────────────
  await page.goto("/chores/meals/plan")
  const fridayCard = page.locator(`[data-testid="plan-day"][data-date="${friday}"]`)
  await expect(fridayCard.getByRole("button", { name: "カレーライスの固定を解除" })).toBeVisible({ timeout: 15_000 })
  await expect(fridayCard.getByRole("button", { name: "ほうれん草のおひたしの固定を解除" })).toBeVisible()
  const createButton = page.getByRole("button", { name: "7日分の献立を作る" })
  await expect(createButton).toBeEnabled({ timeout: 15_000 })
  const revisionBefore = await planRevision(householdId)
  await createButton.click()
  await expect(page.getByRole("status").filter({ hasText: "7日分の献立を作りました" })).toBeVisible({ timeout: 30_000 })
  await waitForRevisionAfter(householdId, revisionBefore)
  let planned: PlanRowFull[] = []
  await expect(async () => {
    planned = await planRows(householdId)
    if (new Set(planned.map((row) => row.plan_date)).size !== 7) throw new Error("the week is not planned yet")
  }).toPass({ timeout: 20_000 })
  expect(planned.find((row) => row.id === curryId)).toMatchObject({ recipe_id: "curry_rice", pinned: true, status: "confirmed" })
  expect(planned.find((row) => row.id === sideId)).toMatchObject({ recipe_id: "spinach_ohitashi", pinned: true, status: "confirmed" })
  expect(planned.filter((row) => row.recipe_id === "spinach_ohitashi")).toHaveLength(1)

  // ── 6. 確定 → 買い物リスト。再読込しても残る ───────────────────────────────────
  await expect(confirmButton).toBeEnabled({ timeout: 15_000 })
  await confirmButton.click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 30_000 })
  await expect(async () => {
    const rows = await planRows(householdId)
    if (rows.some((row) => row.status !== "confirmed")) throw new Error("some entries are not confirmed yet")
  }).toPass({ timeout: 20_000 })
  await page.getByRole("link", { name: "買い物リストを見る" }).click()
  await expect(page).toHaveURL(/\/chores\/meals\/shopping$/, { timeout: 15_000 })
  const toBuy = page.getByRole("heading", { level: 2, name: /^まだ買うもの（\d+件）$/ })
  await expect(toBuy).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("checkbox", { name: "カレールウを購入済みにする" })).toBeVisible()
  const headingBefore = await toBuy.textContent()
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: headingBefore ?? "" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("checkbox", { name: "カレールウを購入済みにする" })).toBeVisible()
  await page.goto("/chores/meals/plan")
  await expect(fridayCard.getByRole("button", { name: "カレーライスの固定を解除" })).toBeVisible({ timeout: 15_000 })
  await expect(fridayCard.getByRole("button", { name: "ほうれん草のおひたしの固定を解除" })).toBeVisible()
  expect((await planRows(householdId)).map((row) => row.id).sort()).toEqual(planned.map((row) => row.id).sort())
})

test("ごはん ⑤: 卵アレルギーの世帯で、材料にマヨネーズ（卵を含む）を入れた手動料理は警告され、確定に混ざらない", async ({
  page,
  approvedUser,
}) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん除外世帯")
  const today = todayJst()
  const DISH = "E2Eポテトサラダ"

  // ── 1. 設定: 卵のアレルギー（家族全体・対象品目から選ぶ）──────────────────────────
  await page.goto("/chores/meals/settings")
  const exclusions = page.getByRole("region", { name: "使わない食材" })
  await expect(exclusions.getByRole("button", { name: "アレルギー" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 15_000,
  })
  await exclusions.getByRole("button", { name: "卵", exact: true }).click()
  const register = exclusions.getByRole("button", { name: "使わない食材に登録" })
  await expect(register).toBeEnabled({ timeout: 15_000 })
  await register.click()
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("food_exclusions")
      .select("reason, target_kind, target_id")
      .eq("household_id", householdId)
    if (error) throw new Error(`food_exclusions lookup failed: ${error.message}`)
    if (JSON.stringify(data) !== JSON.stringify([{ reason: "allergy", target_kind: "allergen", target_id: "egg" }])) {
      throw new Error(`egg allergy is not stored yet: ${JSON.stringify(data)}`)
    }
  }).toPass({ timeout: 15_000 })

  // ── 2. 今日に手で料理（料理名に「卵」は無い。材料にマヨネーズ）────────────────────────
  await page.goto("/chores/meals/plan")
  const todayCard = page.locator(`[data-testid="plan-day"][data-date="${today}"]`)
  await expect(todayCard).toHaveCount(1, { timeout: 15_000 })
  await todayCard.getByRole("button", { name: /に料理を手で追加$/ }).click()
  const sheet = page.getByRole("dialog")
  await sheet.getByLabel("料理名").fill(DISH)
  await sheet.getByRole("button", { name: "材料を足す" }).click()
  await sheet.getByLabel("材料 1 の名前").fill("じゃがいも")
  await sheet.getByLabel("材料 1 の量").fill("300")
  await sheet.getByRole("button", { name: "材料を足す" }).click()
  await sheet.getByLabel("材料 2 の名前").fill("マヨネーズ")
  await sheet.getByLabel("材料 2 の量").fill("30")
  await expect(sheet.getByLabel("材料 2 の単位")).toHaveValue("g")
  await sheet.getByRole("button", { name: "この料理を追加" }).click()
  // 保存は成立する（下書き）が、警告として出す（補足に埋もれさせない）
  const notice = page.getByTestId("plan-notice").getByRole("alert")
  await expect(notice).toContainText(`「${DISH}」を献立へ追加しました。`, { timeout: 15_000 })
  await expect(notice).toContainText("使わない食材の設定に当たります（マヨネーズ）")
  await expect(notice).toContainText("このままでは確定できません")
  let customId = ""
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("dinner_plan_entries")
      .select("id, custom_title, status, pinned")
      .eq("household_id", householdId)
    if (error) throw new Error(`dinner_plan_entries lookup failed: ${error.message}`)
    const row = (data ?? []).find((item) => item.custom_title === DISH)
    if (!row || row.status !== "proposed") throw new Error(`custom dish not stored yet: ${JSON.stringify(data)}`)
    customId = row.id
  }).toPass({ timeout: 15_000 })
  // 料理にも衝突の印。確定の釦は止め、どの料理のせいかを言う
  await expect(todayCard.getByTestId("plan-conflict")).toContainText("使わない食材の設定に当たります", { timeout: 15_000 })
  await expect(page.getByTestId("plan-confirm-held")).toContainText(`「${DISH}」`)
  const confirmButton = page.getByRole("button", { name: "この献立で確定" })
  await expect(confirmButton).toBeDisabled()

  // ── 3. 7 日分の自動献立を作っても、手で入れた料理は確定に混ざらない ───────────────────
  const createButton = page.getByRole("button", { name: "7日分の献立を作る" })
  await expect(createButton).toBeEnabled({ timeout: 15_000 })
  const revisionBefore = await planRevision(householdId)
  await createButton.click()
  await expect(page.getByRole("status").filter({ hasText: "7日分の献立を作りました" })).toBeVisible({ timeout: 30_000 })
  await waitForRevisionAfter(householdId, revisionBefore)
  await expect(async () => {
    const rows = await planRows(householdId)
    if (rows.length < 2) throw new Error(`the week is not planned yet: ${JSON.stringify(rows)}`)
  }).toPass({ timeout: 20_000 })
  await expect(page.getByTestId("plan-confirm-held")).toContainText(`「${DISH}」`, { timeout: 15_000 })
  await expect(confirmButton).toBeDisabled()
  // 何も確定していない（買い物にも入っていない）。手で入れた料理は下書きとして残る
  const rows = await planRows(householdId)
  expect(rows.every((row) => row.status === "proposed")).toBe(true)
  expect(rows.find((row) => row.id === customId)).toMatchObject({ status: "proposed", pinned: true })
  {
    const { data, error } = await adminClient().from("grocery_items").select("id").eq("household_id", householdId)
    expect(error).toBeNull()
    expect(data ?? []).toHaveLength(0)
  }
})

test("ごはん ⑥: 確定した献立に後から卵アレルギーを足すと、その料理の材料は買い物から外れ、理由が出る（献立は変えない）", async ({
  page,
  approvedUser,
}) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん後から除外世帯")
  const today = todayJst()
  const EGG_DISH = "E2E卵焼き"
  const PORK_DISH = "E2E豚の炒め物"

  // ── 1. 今日に手で 2 品（卵 100g / 豚こま切れ肉 200g）→ 確定 → 買い物に両方が入る ────────────
  await page.goto("/chores/meals/plan")
  const todayCard = page.locator(`[data-testid="plan-day"][data-date="${today}"]`)
  await expect(todayCard).toHaveCount(1, { timeout: 15_000 })
  for (const [title, ingredient, amount] of [
    [EGG_DISH, "卵", "100"],
    [PORK_DISH, "豚こま切れ肉", "200"],
  ] as const) {
    await todayCard.getByRole("button", { name: /に料理を手で追加$/ }).click()
    const sheet = page.getByRole("dialog")
    await sheet.getByLabel("料理名").fill(title)
    await sheet.getByRole("button", { name: "材料を足す" }).click()
    await sheet.getByLabel("材料 1 の名前").fill(ingredient)
    await sheet.getByLabel("材料 1 の量").fill(amount)
    await sheet.getByRole("button", { name: "この料理を追加" }).click()
    await expect(page.getByRole("status").filter({ hasText: `「${title}」を献立へ追加しました。` })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole("dialog")).toHaveCount(0)
  }
  await page.getByRole("button", { name: "この献立で確定" }).click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 30_000 })
  let eggDishId = ""
  await expect(async () => {
    const rows = await planEntries(householdId)
    if (rows.length !== 2 || rows.some((row) => row.status !== "confirmed")) {
      throw new Error(`dishes are not confirmed yet: ${JSON.stringify(rows)}`)
    }
  }).toPass({ timeout: 20_000 })
  {
    const { data, error } = await adminClient()
      .from("dinner_plan_entries")
      .select("id, custom_title")
      .eq("household_id", householdId)
      .eq("custom_title", EGG_DISH)
      .single()
    if (error || !data) throw new Error(`egg dish lookup failed: ${error?.message ?? "0 rows"}`)
    eggDishId = data.id
  }
  await page.goto("/chores/meals/shopping")
  await expect(page.getByRole("checkbox", { name: "卵を購入済みにする" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole("checkbox", { name: "豚こま切れ肉を購入済みにする" })).toBeVisible()
  await expect(page.getByRole("region", { name: "使わない食材の設定に当たる料理" })).toHaveCount(0)

  // ── 2. 設定: 卵のアレルギー（家族全体・対象品目から選ぶ）──────────────────────────────
  await page.goto("/chores/meals/settings")
  const exclusions = page.getByRole("region", { name: "使わない食材" })
  await expect(exclusions.getByRole("button", { name: "アレルギー" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 15_000,
  })
  await exclusions.getByRole("button", { name: "卵", exact: true }).click()
  const register = exclusions.getByRole("button", { name: "使わない食材に登録" })
  await expect(register).toBeEnabled({ timeout: 15_000 })
  await register.click()
  await expect(async () => {
    const { data, error } = await adminClient().from("food_exclusions").select("target_id").eq("household_id", householdId)
    if (error) throw new Error(`food_exclusions lookup failed: ${error.message}`)
    if (JSON.stringify(data) !== JSON.stringify([{ target_id: "egg" }])) throw new Error(`egg allergy is not stored yet: ${JSON.stringify(data)}`)
  }).toPass({ timeout: 15_000 })

  // ── 3. 買い物: 卵焼きは外す理由が出る。「献立から更新」で卵が外れ、豚こま切れ肉は残る ──────────
  await page.goto("/chores/meals/shopping")
  const held = page.getByRole("region", { name: "使わない食材の設定に当たる料理" })
  await expect(held).toContainText(`使わない食材の設定に当たるため、次の料理の材料は入れていません: ${EGG_DISH}`, {
    timeout: 15_000,
  })
  // 今日の料理は、献立の画面の既定（今日から）へつなぐ
  await expect(held.getByRole("link", { name: new RegExp(`${EGG_DISH}を献立の画面で選び直す$`) })).toHaveAttribute(
    "href",
    "/chores/meals/plan",
  )
  await expect(page.getByTestId("shopping-stale")).toBeVisible()
  await page.getByRole("button", { name: "献立から更新" }).click()
  await expect(page.getByRole("status").filter({ hasText: "買い物リストを、今の献立と食材から計算し直しました" })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByRole("checkbox", { name: "卵を購入済みにする" })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByRole("checkbox", { name: "豚こま切れ肉を購入済みにする" })).toBeVisible()
  await expect(held).toContainText(EGG_DISH)
  await expect(page.getByTestId("shopping-stale")).toHaveCount(0)
  {
    const { data, error } = await adminClient()
      .from("grocery_items")
      .select("ingredient_id, still_needed")
      .eq("household_id", householdId)
      .eq("still_needed", true)
    expect(error).toBeNull()
    expect((data ?? []).map((row) => row.ingredient_id)).toEqual(["pork_komagire"])
  }
  // 献立は書き換えない（卵焼きは確定・固定のまま。選び直すのは献立の画面）
  {
    const { data, error } = await adminClient()
      .from("dinner_plan_entries")
      .select("status, pinned")
      .eq("id", eggDishId)
      .single()
    expect(error).toBeNull()
    expect(data).toEqual({ status: "confirmed", pinned: true })
  }
})

interface GroceryRowFacts {
  id: string
  name: string
  purchased_quantity: number
  still_needed: boolean
}

async function groceryRows(householdId: string): Promise<GroceryRowFacts[]> {
  const { data, error } = await adminClient()
    .from("grocery_items")
    .select("id, name, purchased_quantity, still_needed")
    .eq("household_id", householdId)
    .order("name", { ascending: true })
  if (error) throw new Error(`grocery_items lookup failed: ${error.message}`)
  return (data ?? []).map((row) => ({ ...row, purchased_quantity: Number(row.purchased_quantity) }))
}

test("ごはん ⑦: 判定できないアレルギーを足す → 買い物は「要再確認」で止まり、リストと購入は残る → 消して更新しても購入は失わず二重にならない", async ({
  page,
  approvedUser,
}) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん要再確認世帯")
  const today = todayJst()
  const PORK = "豚こま切れ肉"
  const UNKNOWN = "ぞぞぞ成分"

  // ── 1. 今日に手で 2 品（豚こま切れ肉 500g / 卵 100g）→ 確定 → 豚こまを 300g だけ買う ──────────
  await page.goto("/chores/meals/plan")
  const todayCard = page.locator(`[data-testid="plan-day"][data-date="${today}"]`)
  await expect(todayCard).toHaveCount(1, { timeout: 15_000 })
  for (const [title, ingredient, amount] of [
    ["E2E豚の炒め物", PORK, "500"],
    ["E2E卵焼き", "卵", "100"],
  ] as const) {
    await todayCard.getByRole("button", { name: /に料理を手で追加$/ }).click()
    const sheet = page.getByRole("dialog")
    await sheet.getByLabel("料理名").fill(title)
    await sheet.getByRole("button", { name: "材料を足す" }).click()
    await sheet.getByLabel("材料 1 の名前").fill(ingredient)
    await sheet.getByLabel("材料 1 の量").fill(amount)
    await sheet.getByRole("button", { name: "この料理を追加" }).click()
    await expect(page.getByRole("status").filter({ hasText: `「${title}」を献立へ追加しました。` })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByRole("dialog")).toHaveCount(0)
  }
  await page.getByRole("button", { name: "この献立で確定" }).click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 30_000 })

  await page.goto("/chores/meals/shopping")
  const porkRow = page.getByTestId("shopping-item").filter({ hasText: PORK })
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("あと 500g", { timeout: 15_000 })
  await page.getByRole("button", { name: `${PORK}の詳細を開く` }).click()
  const detail = page.getByRole("dialog")
  await detail.getByLabel("買った量（合計・g）").fill("300")
  await detail.getByRole("button", { name: "買った量を保存" }).click()
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 300g・あと 200g", { timeout: 15_000 })
  const before = await groceryRows(householdId)
  expect(before.map((row) => [row.name, row.purchased_quantity, row.still_needed])).toEqual([
    ["卵", 0, true],
    [PORK, 300, true],
  ])

  // ── 2. 設定: 判定できない語でアレルギーを登録する ───────────────────────────────────
  await page.goto("/chores/meals/settings")
  const exclusions = page.getByRole("region", { name: "使わない食材" })
  await expect(exclusions.getByRole("button", { name: "アレルギー" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 15_000,
  })
  await exclusions.getByRole("button", { name: "自由に入力", exact: true }).click()
  await exclusions.getByLabel(/名前（30文字まで）/).fill(UNKNOWN)
  await expect(exclusions.getByTestId("exclusion-preview")).toHaveAttribute("data-kind", "holds")
  const register = exclusions.getByRole("button", { name: "使わない食材に登録" })
  await expect(register).toBeEnabled({ timeout: 15_000 })
  await register.click()
  await expect(async () => {
    const { data, error } = await adminClient().from("food_exclusions").select("custom_label").eq("household_id", householdId)
    if (error) throw new Error(`food_exclusions lookup failed: ${error.message}`)
    if (JSON.stringify(data) !== JSON.stringify([{ custom_label: UNKNOWN }])) throw new Error(`not stored yet: ${JSON.stringify(data)}`)
  }).toPass({ timeout: 15_000 })

  // ── 3. 買い物: 要再確認。リスト・購入はそのまま。「献立から更新」も理由を言って止まる ───────────
  await page.goto("/chores/meals/shopping")
  const hold = page.getByTestId("shopping-auto-hold")
  await expect(hold).toContainText("要再確認", { timeout: 15_000 })
  await expect(hold).toContainText(`「${UNKNOWN}」`)
  await expect(page.getByRole("checkbox", { name: "卵を購入済みにする" })).toBeVisible()
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 300g・あと 200g")
  await expect(porkRow.getByTestId("shopping-item-recheck")).toHaveText("要再確認")
  await expect(page.getByTestId("shopping-stale")).toHaveCount(0)
  await page.getByRole("button", { name: "献立から更新" }).click()
  await expect(page.getByRole("alert").filter({ hasText: "買い物リストの自動の更新を止めています" })).toBeVisible({
    timeout: 15_000,
  })
  expect(await groceryRows(householdId)).toEqual(before)

  // ── 4. 解決: 判定できない登録を消す → 「献立から更新」→ 購入 300g は残り、行は増えない ─────────
  await page.goto("/chores/meals/settings")
  const row = exclusions.getByTestId("settings-exclusion").filter({ hasText: UNKNOWN })
  await row.getByRole("button", { name: new RegExp(`${UNKNOWN}（アレルギー・.*）を削除`) }).click()
  await row.getByRole("button", { name: "削除する", exact: true }).click()
  await expect(async () => {
    const { data, error } = await adminClient().from("food_exclusions").select("id").eq("household_id", householdId)
    if (error) throw new Error(`food_exclusions lookup failed: ${error.message}`)
    if ((data ?? []).length !== 0) throw new Error("exclusion is not deleted yet")
  }).toPass({ timeout: 15_000 })

  await page.goto("/chores/meals/shopping")
  await expect(page.getByTestId("shopping-auto-hold")).toHaveCount(0, { timeout: 15_000 })
  await page.getByRole("button", { name: "献立から更新" }).click()
  await expect(page.getByRole("status").filter({ hasText: "買い物リストを、今の献立と食材から計算し直しました" })).toBeVisible({
    timeout: 15_000,
  })
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 300g・あと 200g")
  // 同じ行（同じ ID）のまま。購入の記録は消えず、二重にもならない
  expect(await groceryRows(householdId)).toEqual(before)
  await page.reload()
  await expect(porkRow.getByTestId("shopping-progress")).toHaveText("購入済み 300g・あと 200g", { timeout: 15_000 })
  await expect(page.getByTestId("shopping-item-recheck")).toHaveCount(0)
})

test("ごはん ⑧: アレルギーで「豆乳」を選ぶと「大豆」を品目として登録する候補が出て、押すと品目だけが登録される（苦手には出ない）", async ({
  page,
  approvedUser,
}) => {
  const householdId = await setupHousehold(page, approvedUser.id, approvedUser.email, "E2Eごはん品目候補世帯")
  await page.goto("/chores/meals/settings")
  const exclusions = page.getByRole("region", { name: "使わない食材" })
  await expect(exclusions.getByRole("button", { name: "アレルギー" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 15_000,
  })
  // 苦手で豆乳を選んでも候補は出ない（個別の除外のまま）
  await exclusions.getByRole("button", { name: "苦手", exact: true }).click()
  await exclusions.getByRole("button", { name: "食材から", exact: true }).click()
  await exclusions.getByLabel("食材", { exact: true }).selectOption({ label: "豆乳" })
  await expect(exclusions.getByTestId("allergy-category-candidates")).toHaveCount(0)

  await exclusions.getByRole("button", { name: "アレルギー", exact: true }).click()
  const candidate = exclusions.getByTestId("allergy-category-candidate")
  await expect(candidate).toHaveAttribute("data-allergen-id", "soybean")
  await expect(candidate).toContainText("「豆乳」は、対象品目の「大豆」（表示推奨）を含みます。")
  await expect(candidate).toContainText("木綿豆腐")
  await candidate.getByRole("button", { name: "「大豆」を品目として登録", exact: true }).click()
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("food_exclusions")
      .select("reason, target_kind, target_id")
      .eq("household_id", householdId)
    if (error) throw new Error(`food_exclusions lookup failed: ${error.message}`)
    if (JSON.stringify(data) !== JSON.stringify([{ reason: "allergy", target_kind: "allergen", target_id: "soybean" }])) {
      throw new Error(`soybean is not stored yet: ${JSON.stringify(data)}`)
    }
  }).toPass({ timeout: 15_000 })
  await page.reload()
  await expect(exclusions.getByTestId("settings-exclusion")).toHaveCount(1, { timeout: 15_000 })
  await expect(exclusions.getByTestId("settings-exclusion")).toContainText("大豆")
})
