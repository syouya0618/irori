import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * PR #272 の受入ゲート。使い捨てローカルSupabaseだけに認証・保存する。
 * 単体試験ではなく実ブラウザの「提案→1品変更→1品削除」と
 * 「自分で家事を登録→カレンダー→完了→取消」を320pxで確認する。
 */
test.setTimeout(240_000)

interface PlanRow {
  id: string
  plan_date: string
  recipe_id: string | null
  pinned: boolean
  status: string
}

async function openHousehold(page: Page, userId: string, email: string, name: string): Promise<string> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill(name)
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  let householdId = ""
  await expect(async () => {
    const { data, error } = await adminClient().from("profiles")
      .select("household_id").eq("id", userId).single()
    if (error) throw new Error(error.message)
    if (!data?.household_id) throw new Error("household is not ready")
    householdId = data.household_id
  }).toPass({ timeout: 15_000 })
  await page.setViewportSize({ width: 320, height: 750 })
  return householdId
}

async function planRows(householdId: string): Promise<PlanRow[]> {
  const { data, error } = await adminClient().from("dinner_plan_entries")
    .select("id, plan_date, recipe_id, pinned, status")
    .eq("household_id", householdId).order("plan_date", { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as PlanRow[]
}

test("受入: AI補助なしの提案から1品だけ手入力変更・確認削除しても他の献立を残す（320px）", async ({
  page, approvedUser,
}) => {
  const household = await openHousehold(page, approvedUser.id, approvedUser.email, "受入_献立1品編集")
  await page.goto("/chores/meals/plan")
  const generate = page.getByRole("button", { name: "7日分の献立を作る" })
  await expect(generate).toBeEnabled({ timeout: 15_000 })
  await generate.click()
  await expect(page.getByRole("status").filter({ hasText: "7日分の献立を作りました" }))
    .toBeVisible({ timeout: 30_000 })

  let initial: PlanRow[] = []
  await expect(async () => {
    initial = await planRows(household)
    expect(initial.filter((entry) => entry.recipe_id !== null && entry.status === "proposed").length)
      .toBeGreaterThanOrEqual(2)
  }).toPass({ timeout: 20_000 })
  const target = initial.find((entry) => entry.recipe_id !== null && entry.status === "proposed")!
  const sibling = initial.find((entry) => entry.id !== target.id)!

  // 週間スケジュールにある1品のIDを指定して編集シートへ入る。
  await page.goto(`/chores/meals/plan?entry=${encodeURIComponent(target.id)}`)
  const editing = page.getByRole("dialog")
  await expect(editing.getByText("この料理を手入力で変更")).toBeVisible({ timeout: 15_000 })
  const change = editing.getByRole("button", { name: "変更を保存" })
  await expect(change).toBeEnabled({ timeout: 15_000 })
  await editing.getByLabel("料理名").fill("受入用おでん")
  await change.click()
  await expect(async () => {
    const rows = await planRows(household)
    expect(rows.find((entry) => entry.id === target.id)).toMatchObject({
      id: target.id, plan_date: target.plan_date, recipe_id: null, pinned: true,
    })
    expect(rows.find((entry) => entry.id === sibling.id)).toEqual(sibling)
    expect(rows).toHaveLength(initial.length)
  }).toPass({ timeout: 20_000 })

  // 確認画面を開いただけでは削除しない。対象IDだけ削除してほかの1品は保持する。
  await page.goto(`/chores/meals/plan?entry=${encodeURIComponent(target.id)}`)
  const removing = page.getByRole("dialog")
  await expect(removing.getByRole("heading", { name: "受入用おでん" })).toBeVisible({ timeout: 15_000 })
  await removing.getByRole("button", { name: "この料理を献立から外す" }).click()
  await expect(removing.getByText(/「受入用おでん」をこの日の献立から外します/)).toBeVisible()
  expect((await planRows(household)).some((entry) => entry.id === target.id)).toBe(true)
  const confirm = removing.getByRole("button", { name: "外す", exact: true })
  await expect(confirm).toBeEnabled({ timeout: 15_000 })
  await confirm.click()
  await expect(async () => {
    const rows = await planRows(household)
    expect(rows.some((entry) => entry.id === target.id)).toBe(false)
    expect(rows.find((entry) => entry.id === sibling.id)).toEqual(sibling)
    expect(rows).toHaveLength(initial.length - 1)
  }).toPass({ timeout: 20_000 })
  await page.goto("/chores/meals")
  await expect(page.getByTestId("schedule-week").locator(":scope > li")).toHaveCount(7)
})

test("受入: 家事項目を自由登録し、カレンダーの予定→完了→取消を320pxで照合", async ({
  page, approvedUser,
}) => {
  const household = await openHousehold(page, approvedUser.id, approvedUser.email, "受入_掃除自由設定")
  await page.goto("/chores/cleaning")
  await page.getByRole("button", { name: "家事項目を設定" }).click()
  const form = page.getByRole("dialog")
  await expect(form.getByRole("heading", { name: "掃除の項目を追加" })).toBeVisible()
  await form.getByLabel("名前").fill("リビングの床拭き")
  await form.getByLabel("場所（任意）").fill("リビング")
  await form.getByRole("button", { name: /実施してから一定期間後/ }).click()
  await form.getByLabel("間隔").selectOption("2")
  await expect(form.getByTestId("cadence-reading")).toContainText("2週間後")
  const today = await form.getByLabel("最初の予定日").inputValue()
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  const dateLabel = `${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日`
  await form.getByRole("button", { name: "この内容で追加" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「リビングの床拭き」を追加しました。" }))
    .toBeVisible({ timeout: 15_000 })

  const calendar = page.getByTestId("cleaning-calendar")
  const pending = calendar.getByRole("button", { name: `${dateLabel}: 完了0件・次回目安1件` })
  await expect(pending).toBeVisible({ timeout: 15_000 })
  await pending.click()
  await expect(calendar.getByRole("button", { name: /リビングの床拭き.*次回目安/ })).toBeVisible()
  await page.getByRole("checkbox", { name: "リビングの床拭きを完了にする" }).click()
  await expect(page.getByRole("status").filter({ hasText: "「リビングの床拭き」を完了にしました。" }))
    .toBeVisible({ timeout: 15_000 })
  await expect(calendar.getByRole("button", { name: `${dateLabel}: 完了1件・次回目安0件` }))
    .toBeVisible({ timeout: 15_000 })
  await page.getByTestId("cleaning-inline-undo").getByRole("button", { name: "直前の記録を取り消す" }).click()
  await expect(page.getByRole("status").filter({ hasText: "記録を取り消しました。" }))
    .toBeVisible({ timeout: 15_000 })
  await expect(pending).toBeVisible({ timeout: 15_000 })

  // 削除ではなく履歴の無効化。再読込後も履歴を完了に誤計上しない。
  await expect(async () => {
    const { data, error } = await adminClient().from("cleaning_logs")
      .select("voided_at").eq("household_id", household)
    if (error) throw new Error(error.message)
    expect(data).toHaveLength(1)
    expect(data?.[0]?.voided_at).not.toBeNull()
  }).toPass({ timeout: 15_000 })
  await page.reload()
  await expect(pending).toBeVisible({ timeout: 15_000 })
})
