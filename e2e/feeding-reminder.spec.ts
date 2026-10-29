import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

test.setTimeout(120_000)

test("授乳通知: 既定OFF → 明示操作で15分前 → 再読込 → OFF、既存設定は保持", async ({ page, approvedUser }) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E授乳通知世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const admin = adminClient()
  const { error: seedError } = await admin.from("notification_preferences")
    .upsert({ user_id: approvedUser.id, event_default_minutes: 10, digest_time: "07:00" }, { onConflict: "user_id" })
  if (seedError) throw seedError
  await page.goto("/settings#settings-notification")
  const choice = page.getByRole("combobox", { name: "次の授乳を通知する時間" })
  await expect(choice).toHaveText(/通知しない/)
  await page.getByRole("button", { name: "15分前で始める" }).click()
  await expect(choice).toHaveText(/15分前/)
  await expect(async () => {
    const { data, error } = await admin.from("notification_preferences")
      .select("feeding_reminder_minutes, event_default_minutes, digest_time").eq("user_id", approvedUser.id).single()
    if (error) throw error
    expect(data).toEqual({ feeding_reminder_minutes: 15, event_default_minutes: 10, digest_time: "07:00:00" })
  }).toPass({ timeout: 10_000 })
  await page.reload()
  await expect(choice).toHaveText(/15分前/)
  await expect(page.getByText(/通知を受け取る端末がありません/)).toBeVisible()
  await choice.click()
  await expect(page.getByRole("option")).toHaveCount(5)
  await page.getByRole("option", { name: "通知しない", exact: true }).click()
  await expect(choice).toHaveText(/通知しない/)
  await expect(async () => {
    const { data, error } = await admin.from("notification_preferences")
      .select("feeding_reminder_minutes").eq("user_id", approvedUser.id).single()
    if (error) throw error
    expect(data?.feeding_reminder_minutes).toBeNull()
  }).toPass({ timeout: 10_000 })
})
