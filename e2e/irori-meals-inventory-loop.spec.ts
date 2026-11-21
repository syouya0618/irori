import { test, expect } from "./fixtures/test"
import { adminClient, cleanupUser, createApprovedUser, loginViaMagicLink, uniqueEmail } from "./fixtures/auth"

/**
 * 冷蔵庫 → カタログ料理を手入力へ変換 → 確定 → 買い物 → 購入 → 在庫へ補充 →
 * 調理 → 実際の使用量を引く → 家族の古い版からは二重減算できない、を実ブラウザで確認。
 * adminClientは使い捨てlocalhost Supabaseだけを受け付ける。
 */
test.setTimeout(240_000)

const todayJst = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date())

test("家族: 手入力料理の材料が買い物へ反映され、購入・補充・調理後の在庫が二重計上されない", async ({
  page, approvedUser, browser,
}, testInfo) => {
  const admin = adminClient()
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("冷蔵庫献立買い物E2E")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  let householdId = ""
  await expect(async () => {
    const { data, error } = await admin.from("profiles").select("household_id")
      .eq("id", approvedUser.id).single()
    if (error || !data?.household_id) throw Error(error?.message ?? "household not ready")
    householdId = data.household_id
  }).toPass({ timeout: 15_000 })
  await page.setViewportSize({ width: 390, height: 844 })

  // 1. 冷蔵庫: ほうれん草2束を正確な数量として登録。
  await page.goto("/chores/meals/pantry")
  await page.getByLabel("家にある食材").fill("ほうれん草 2束")
  await page.getByRole("button", { name: "数量・保管場所などを詳しく入力" }).click()
  await page.getByRole("button", { name: "内容を確認" }).click()
  await expect(page.getByTestId("pantry-preview-resolved")).toHaveText("1件", { timeout: 15_000 })
  await page.getByRole("button", { name: "1件を登録" }).click()
  await expect(page.getByRole("status").filter({ hasText: "1件の食材を登録しました。" })).toBeVisible({ timeout: 20_000 })
  let spinachId = ""
  await expect(async () => {
    const { data, error } = await admin.from("pantry_items")
      .select("id, ingredient_id, quantity, unit").eq("household_id", householdId)
      .eq("ingredient_id", "spinach").single()
    if (error || !data) throw Error(error?.message ?? "spinach not ready")
    expect(data.quantity).toBe(2)
    expect(data.unit).toBe("bunch")
    spinachId = data.id
  }).toPass({ timeout: 15_000 })

  // 2. 献立: ほうれん草のおひたしを今日に追加。レシピの材料を引き継ぎ1品だけ変更。
  await page.goto("/chores/meals/recipes/spinach_ohitashi")
  await page.getByRole("button", { name: "ほうれん草のおひたしを献立に入れる" }).click()
  const panel = page.getByRole("group", { name: "ほうれん草のおひたしを献立に入れる日" })
  await panel.getByLabel("入れる日").selectOption(todayJst())
  await panel.getByRole("button", { name: "この日の献立に入れる" }).click()
  await expect(page.getByTestId("add-to-plan-result").getByRole("status"))
    .toContainText("ほうれん草のおひたし", { timeout: 20_000 })

  let entryId = ""
  await expect(async () => {
    const { data, error } = await admin.from("dinner_plan_entries")
      .select("id, recipe_id, plan_date").eq("household_id", householdId).single()
    if (error || !data) throw Error(error?.message ?? "dish not ready")
    expect(data.recipe_id).toBe("spinach_ohitashi")
    expect(data.plan_date).toBe(todayJst())
    entryId = data.id
  }).toPass({ timeout: 15_000 })

  await page.goto(`/chores/meals/plan?entry=${entryId}`)
  let sheet = page.getByRole("dialog")
  await expect(sheet.getByText("この料理を手入力で変更")).toBeVisible({ timeout: 15_000 })
  // 変換しても材料を捨てない。3番目のかつお節だけ2g→4gへ変更。
  await expect(sheet.getByLabel("材料 1 の名前")).toHaveValue("ほうれん草")
  await expect(sheet.getByLabel("材料 3 の名前")).toHaveValue("かつお節")
  await sheet.getByLabel("料理名").fill("アレンジおひたし")
  await sheet.getByLabel("材料 3 の量").fill("4")
  await sheet.getByRole("button", { name: "変更を保存" }).click()

  await expect(async () => {
    const { data, error } = await admin.from("dinner_plan_entries")
      .select("recipe_id, custom_title, custom_ingredients, pinned")
      .eq("household_id", householdId).eq("id", entryId).single()
    if (error || !data) throw Error(error?.message ?? "custom dish missing")
    expect(data.recipe_id).toBeNull()
    expect(data.custom_title).toBe("アレンジおひたし")
    expect(data.pinned).toBe(true)
    const lines = data.custom_ingredients as Array<{ ingredientId: string; quantity: { amount: number; unit: string } }>
    expect(lines).toHaveLength(3)
    expect(lines.find((line) => line.ingredientId === "katsuobushi")?.quantity).toMatchObject({ amount: 4, unit: "g" })
  }).toPass({ timeout: 20_000 })

  // 3. 確定した献立から買い物へ。材料の変更が必要量4gに反映される。
  await page.goto("/chores/meals/plan")
  await page.getByRole("button", { name: "この献立で確定" }).click()
  await expect(page.getByRole("status").filter({ hasText: "献立を確定しました" })).toBeVisible({ timeout: 25_000 })
  await expect(async () => {
    const { data, error } = await admin.from("grocery_items")
      .select("required_quantity, unit, ingredient_id").eq("household_id", householdId)
      .eq("ingredient_id", "katsuobushi").single()
    if (error || !data) throw Error(error?.message ?? "grocery item missing")
    expect(Number(data.required_quantity)).toBe(4)
    expect(data.unit).toBe("g")
  }).toPass({ timeout: 20_000 })

  // 4. 購入チェックだけでは冷蔵庫は増えない。「在庫へ追加」で初めて補充する。
  await page.goto("/chores/meals/shopping")
  await page.getByRole("checkbox", { name: "かつお節を購入済みにする" }).click()
  await expect(async () => {
    const { data, error } = await admin.from("grocery_items")
      .select("purchased").eq("household_id", householdId).eq("ingredient_id", "katsuobushi").single()
    if (error || !data) throw Error(error?.message ?? "purchase not recorded")
    expect(data.purchased).toBe(true)
    const { count } = await admin.from("pantry_items").select("id", { count: "exact", head: true })
      .eq("household_id", householdId).eq("ingredient_id", "katsuobushi")
    expect(count).toBe(0)
  }).toPass({ timeout: 20_000 })
  await page.getByRole("button", { name: "かつお節の詳細を開く" }).click()
  const shoppingSheet = page.getByRole("dialog")
  const restock = shoppingSheet.getByTestId("restock-section")
  await expect(restock.getByRole("button", { name: "在庫へ追加" })).toBeEnabled({ timeout: 15_000 })
  await restock.getByRole("button", { name: "在庫へ追加" }).click()
  await expect(async () => {
    const { data, error } = await admin.from("pantry_items")
      .select("quantity, unit").eq("household_id", householdId).eq("ingredient_id", "katsuobushi").single()
    if (error || !data) throw Error(error?.message ?? "restock not saved")
    expect(data.quantity).toBe(4)
    expect(data.unit).toBe("g")
  }).toPass({ timeout: 20_000 })

  // 5. 今日「作った」後も在庫は勝手に減らない。A/Bが同じ版を見た状態で、Aが実使用1.5束を反映する。
  await page.goto("/chores/meals/plan")
  await page.getByTestId("plan-day")
    .filter({ hasText: "アレンジおひたし" })
    .getByRole("button", { name: "アレンジおひたしを「作った」にする" }).click()
  sheet = page.getByRole("dialog")
  await expect(sheet.getByRole("textbox", { name: "ほうれん草を使った量" })).toBeVisible({ timeout: 20_000 })
  const { data: beforeUse } = await admin.from("pantry_items")
    .select("quantity").eq("household_id", householdId).eq("id", spinachId).single()
  expect(beforeUse?.quantity).toBe(2)

  const family = await createApprovedUser(`inventory-family-${uniqueEmail(testInfo.workerIndex)}`)
  const contextB = await browser.newContext()
  await contextB.addInitScript(() => { try { localStorage.setItem("irori:tour-seen:v1", "1") } catch { /* noop */ } })
  try {
    const { error } = await admin.from("profiles").update({ household_id: householdId, role: "member" })
      .eq("id", family.id)
    if (error) throw Error(error.message)
    const pageB = await contextB.newPage()
    await loginViaMagicLink(pageB, family.email)
    await pageB.goto(`/chores/meals/plan?entry=${entryId}`)
    const sheetB = pageB.getByRole("dialog")
    await expect(sheetB.getByRole("textbox", { name: "ほうれん草を使った量" })).toBeVisible({ timeout: 20_000 })
    await sheetB.getByRole("textbox", { name: "ほうれん草を使った量" }).fill("1")

    await sheet.getByRole("textbox", { name: "ほうれん草を使った量" }).fill("1.5")
    await expect(sheet.getByTestId("cooked-pantry-remaining")).toContainText("0.5束")
    await sheet.getByRole("button", { name: "ほうれん草の使用量を反映" }).click()
    await expect(async () => {
      const { data, error } = await admin.from("pantry_items")
        .select("quantity, unit").eq("household_id", householdId).eq("id", spinachId).single()
      if (error || !data) throw Error(error?.message ?? "quantity not updated")
      expect(Number(data.quantity)).toBe(0.5)
      expect(data.unit).toBe("bunch")
    }).toPass({ timeout: 20_000 })

    // Bの古い版で再度差し引かない。古い絶対残量で上書きされることもない。
    await sheetB.getByRole("button", { name: "ほうれん草の使用量を反映" }).click()
    await expect(async () => {
      const { data, error } = await admin.from("pantry_items")
        .select("quantity, unit").eq("household_id", householdId).eq("id", spinachId).single()
      if (error || !data) throw Error(error?.message ?? "stale write changed stock")
      expect(Number(data.quantity)).toBe(0.5)
    }).toPass({ timeout: 15_000 })
    await pageB.reload()
    await expect(pageB.getByRole("dialog").getByText("現在：ある・0.5束")).toBeVisible({ timeout: 15_000 })
  } finally {
    await contextB.close()
    await cleanupUser(family.id)
  }
})
