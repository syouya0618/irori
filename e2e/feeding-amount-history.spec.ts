import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

test.setTimeout(180_000)
test("本人の確定した量を5件まで記憶し、再読込・再利用と更新履歴の開閉ができる", async ({ page, approvedUser }) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/)
  await page.getByLabel("世帯名").fill("household-a")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/)
  const admin = adminClient()
  const history = async () => {
    const { data, error } = await admin.from("feeding_amount_history").select("amount_ml")
      .eq("user_id", approvedUser.id).eq("feeding_type", "pumped").order("use_order", { ascending: false })
    if (error) throw error
    return data.map((row) => row.amount_ml)
  }
  const open = async () => {
    await expect(page.locator('[data-slot="sheet-content"]')).toHaveCount(0)
    await page.getByRole("main").getByRole("button", { name: "搾乳", exact: true }).click()
    const sheet = page.locator('[data-slot="sheet-content"][data-open]')
    await expect(sheet.getByLabel("量 (ml)")).toBeVisible()
    return sheet
  }
  for (const [index, amount] of [20, 40, 60, 80, 120, 160].entries()) {
    const sheet = await open()
    if (index === 0) await expect(sheet.getByText("保存した量がここに表示されます")).toBeVisible()
    await sheet.getByLabel("量 (ml)").fill(String(amount))
    await sheet.getByRole("button", { name: "記録する", exact: true }).click()
    await expect.poll(history).toEqual([20, 40, 60, 80, 120, 160].slice(0, index + 1).reverse().slice(0, 5))
  }
  await page.reload()
  const sheet = await open()
  for (const amount of [160, 120, 80, 60, 40]) await expect(sheet.getByRole("button", { name: String(amount), exact: true })).toBeVisible()
  await expect(sheet.getByRole("button", { name: "20", exact: true })).toHaveCount(0)
  await sheet.getByRole("button", { name: "60", exact: true }).click()
  await sheet.getByRole("button", { name: "記録する", exact: true }).click()
  await expect.poll(history).toEqual([60, 160, 120, 80, 40])
  await page.goto("/settings")
  const toggle = page.getByRole("button", { name: "更新履歴を見る" })
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(page.getByRole("heading", { name: "2026年10月28日の更新" })).toBeVisible()
  await toggle.click()
  await expect(page.getByRole("heading", { name: "2026年10月28日の更新" })).toBeHidden()
})
