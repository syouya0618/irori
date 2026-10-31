import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

test("子どもを追加して切り替えても記録・量候補・いつもの量が混ざらない", async ({ page, approvedUser }) => {
  test.setTimeout(120_000)
  await loginViaMagicLink(page, approvedUser.email)
  await page.getByLabel("世帯名").fill("synthetic household children")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/)
  const db = adminClient()
  const { data: profile, error: pe } = await db.from("profiles").select("household_id").eq("id",approvedUser.id).single()
  if (pe) throw pe
  const { data: original, error: ce } = await db.from("children").select("id").eq("household_id",profile.household_id).eq("is_legacy",true).single()
  if (ce) throw ce
  const { error: se } = await db.from("baby_logs").insert({ household_id: profile.household_id, child_id: original.id, logged_by: approvedUser.id, log_type: "memo", memo: "synthetic legacy-only note" })
  if (se) throw se
  const { error: defaultError } = await db.from("households").update({ bottle_default_ml: 120 }).eq("id",profile.household_id)
  if (defaultError) throw defaultError
  const { error: historyError } = await db.from("feeding_amount_history").insert({ user_id: approvedUser.id, household_id: profile.household_id, child_id: original.id, feeding_type: "pumped", amount_ml: 120, use_order: 1 })
  if (historyError) throw historyError
  await page.goto("/children")
  const add = page.locator("form").filter({ has: page.getByRole("heading",{ name: "子どもの追加" }) })
  await add.getByLabel("呼び名").fill("synthetic child A2")
  await add.getByRole("button",{ name: "保存する" }).click()
  await expect(add.getByRole("status")).toHaveText("保存しました")
  await page.goto("/baby")
  await page.getByLabel("記録する子ども").selectOption({ label: "synthetic child A2" })
  await expect(page.getByLabel("記録する子ども").locator("option:checked")).toHaveText("synthetic child A2")
  await page.getByRole("main").getByRole("button", { name: "搾乳", exact: true }).click()
  const sheet = page.locator('[data-slot="sheet-content"][data-open]')
  await expect(sheet.getByText("保存した量がここに表示されます")).toBeVisible()
  await sheet.getByLabel("量 (ml)").fill("77")
  await sheet.getByRole("button", { name: "記録する", exact: true }).click()
  await expect.poll(async () => {
    const { data, error } = await db.from("baby_logs").select("child_id").eq("logged_by",approvedUser.id).eq("feeding_type","pumped")
    if (error) throw error
    return data
  }).toEqual([{ child_id: await page.getByLabel("記録する子ども").inputValue() }])
  await expect(page.getByText("synthetic legacy-only note",{ exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByLabel("記録する子ども").locator("option:checked")).toHaveText("synthetic child A2")
  await page.getByLabel("記録する子ども").selectOption(original.id)
  await expect(page.getByText("synthetic legacy-only note",{ exact: true })).toBeVisible()
  await page.getByRole("main").getByRole("button", { name: "搾乳", exact: true }).click()
  await expect(sheet.getByRole("button",{ name: "120", exact: true })).toBeVisible()
  await expect(sheet.getByRole("button",{ name: "77", exact: true })).toHaveCount(0)
})
