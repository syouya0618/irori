import type { Browser, BrowserContext, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, cleanupUser, createApprovedUser, loginViaMagicLink, uniqueEmail } from "./fixtures/auth"

/**
 * 承認済み週間献立デザインの320/390pxと、家族2アカウントの双方向同期を検証。
 * 実ログイン・実RPC・実SQL。使い捨て loopback Supabase以外では adminClient が拒否。
 * 本番Previewへ試験データを入れない。画像そのもののピクセル一致・実機PWAは別受入。
 */
test.setTimeout(240_000)

function todayJst(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date())
}
function dayIndex(): number {
  return (new Date(todayJst() + "T12:00:00Z").getUTCDay() + 6) % 7
}

async function setupHome(page: Page, email: string, userId: string): Promise<string> {
  await loginViaMagicLink(page, email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("家族同期受入E2E")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  let householdId = ""
  await expect(async () => {
    const { data, error } = await adminClient().from("profiles")
      .select("household_id").eq("id", userId).single()
    if (error) throw Error(error.message)
    if (!data?.household_id) throw Error("household is not ready")
    householdId = data.household_id
  }).toPass({ timeout: 15_000 })
  await page.setViewportSize({ width: 320, height: 750 })
  return householdId
}

async function familyPage(browser: Browser, householdId: string, workerIndex: number): Promise<{
  context: BrowserContext
  page: Page
  userId: string
}> {
  const user = await createApprovedUser("family-parity-" + uniqueEmail(workerIndex))
  let context: BrowserContext | undefined
  try {
    const { error, data } = await adminClient().from("profiles")
      .update({ household_id: householdId, role: "member" })
      .eq("id", user.id).select("id").single()
    if (error || !data) throw Error("family join failed: " + (error?.message ?? "not joined"))
    context = await browser.newContext()
    await context.addInitScript(() => { try { localStorage.setItem("irori:tour-seen:v1", "1") } catch { /* unavailable */ } })
    const page = await context.newPage()
    await page.setViewportSize({ width: 390, height: 844 })
    await loginViaMagicLink(page, user.email)
    return { context, page, userId: user.id }
  } catch (error) {
    if (context) await context.close()
    await cleanupUser(user.id)
    throw error
  }
}

async function checkCompactScreen(page: Page) {
  const result = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(result.scrollWidth, "320/390pxで横スクロールを発生させない").toBeLessThanOrEqual(result.width + 1)
}

async function openToday(page: Page) {
  const week = page.getByTestId("schedule-week")
  await expect(week.locator(":scope > li")).toHaveCount(7)
  await week.locator(":scope > li").nth(dayIndex()).getByRole("button").click()
  return page.getByRole("dialog")
}

async function proposeFirst(page: Page, role: "main" | "side" | "staple" | "soup"): Promise<string> {
  const roleName = { main: "主菜", side: "副菜", staple: "主食", soup: "汁物" }[role]
  await page.getByRole("button", { name: roleName + "を提案" }).click()
  const candidates = page.getByTestId("role-suggestion-results")
  await expect(candidates).toBeVisible({ timeout: 15_000 })
  const first = candidates.getByRole("button", { name: /を献立へ追加/ }).first()
  await expect(first).toBeEnabled({ timeout: 15_000 })
  const label = await first.getAttribute("aria-label")
  expect(label).toContain("を献立へ追加")
  const title = label!.replace(/を献立へ追加$/, "")
  await first.click()
  return title
}

test("家族2アカウント: 主菜を提案→採用→副菜競合→別端末の編集→3タブ表示（320/390px）", async ({
  page, approvedUser, browser,
}, testInfo) => {
  const household = await setupHome(page, approvedUser.email, approvedUser.id)
  const family = await familyPage(browser, household, testInfo.workerIndex)
  try {
    await page.goto("/chores/meals")
    const navigation = page.getByRole("navigation", { name: "ごはんの画面" })
    await expect(navigation.getByRole("link")).toHaveText(["スケジュール", "冷蔵庫の在庫", "メモ"])
    await checkCompactScreen(page)
    let dialog = await openToday(page)
    await expect(dialog.getByText("あと一品、提案する")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "主菜を提案" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "副菜を提案" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "主食を提案" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "汁物を提案" })).toBeVisible()

    // 4区分の提案はどれも実際に計算できる。採用するまではDBに書かない。
    for (const label of ["主食", "汁物", "副菜"]) {
      await page.getByRole("button", { name: label + "を提案" }).click()
      await expect(page.getByTestId("role-suggestion-results")
        .getByRole("button", { name: /を献立へ追加/ }).first()).toBeVisible({ timeout: 15_000 })
    }
    await page.getByRole("button", { name: "主菜を提案" }).click()
    await expect(page.getByTestId("role-suggestion-results")).toBeVisible({ timeout: 15_000 })
    const rows = await adminClient().from("dinner_plan_entries").select("id").eq("household_id", household)
    expect(rows.error).toBeNull()
    expect(rows.data ?? []).toHaveLength(0)
    const first = page.getByTestId("role-suggestion-results").getByRole("button", { name: /を献立へ追加/ }).first()
    const title = (await first.getAttribute("aria-label"))!.replace(/を献立へ追加$/, "")
    await first.click()
    await expect(page.getByRole("status").filter({ hasText: "選んだ料理を献立に追加しました" })).toBeVisible({ timeout: 20_000 })

    let mainId = ""
    await expect(async () => {
      const { data, error } = await adminClient().from("dinner_plan_entries")
        .select("id, role, recipe_id, status").eq("household_id", household).eq("role", "main")
      if (error) throw Error(error.message)
      expect(data).toHaveLength(1)
      mainId = data![0].id
    }).toPass({ timeout: 20_000 })

    // 2人目が同じ日の主菜を読み戻す。
    await family.page.goto("/chores/meals")
    await expect(family.page.getByTestId("schedule-week").getByText(title)).toBeVisible({ timeout: 15_000 })
    await checkCompactScreen(family.page)

    // Aが副菜の候補を見たあと、Bが先に採用する。古い候補で二重登録しない。
    await page.reload()
    dialog = await openToday(page)
    await page.getByRole("button", { name: "副菜を提案" }).click()
    await expect(page.getByTestId("role-suggestion-results")).toBeVisible({ timeout: 15_000 })
    const staleAdopt = page.getByTestId("role-suggestion-results")
      .getByRole("button", { name: /を献立へ追加/ }).first()
    const candidateName = (await staleAdopt.getAttribute("aria-label"))!.replace(/を献立へ追加$/, "")

    await family.page.reload()
    await openToday(family.page)
    const adoptedSide = await proposeFirst(family.page, "side")
    await expect(family.page.getByRole("status").filter({ hasText: "選んだ料理を献立に追加しました" })).toBeVisible({ timeout: 20_000 })
    await expect(async () => {
      const { data, error } = await adminClient().from("dinner_plan_entries")
        .select("id").eq("household_id", household).eq("role", "side")
      if (error) throw Error(error.message)
      expect(data).toHaveLength(1)
    }).toPass({ timeout: 20_000 })
    await staleAdopt.click()
    await expect(page.getByRole("alert").filter({ hasText: "別の端末で献立が変更されました" }))
      .toBeVisible({ timeout: 20_000 })
    const { data: sides, error: sideError } = await adminClient().from("dinner_plan_entries")
      .select("id").eq("household_id", household).eq("role", "side")
    expect(sideError).toBeNull()
    expect(sides).toHaveLength(1)
    expect(candidateName.length).toBeGreaterThan(0)

    // Bが主菜を1品手入力で編集しても、Aの表示と同じDB行へ反映される。
    await family.page.goto("/chores/meals/plan?entry=" + mainId)
    const edit = family.page.getByRole("dialog")
    await expect(edit.getByRole("button", { name: "変更を保存" })).toBeEnabled({ timeout: 15_000 })
    await edit.getByLabel("料理名").fill("家族同期のおでん")
    await edit.getByRole("button", { name: "変更を保存" }).click()
    await expect(async () => {
      const { data, error } = await adminClient().from("dinner_plan_entries")
        .select("id, custom_title, recipe_id").eq("household_id", household).eq("id", mainId).single()
      if (error) throw Error(error.message)
      expect(data).toMatchObject({ id: mainId, custom_title: "家族同期のおでん", recipe_id: null })
    }).toPass({ timeout: 20_000 })
    await page.goto("/chores/meals")
    await expect(page.getByTestId("schedule-week").getByText(/家族同期のおでん/)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("schedule-week").getByText(adoptedSide)).toBeVisible({ timeout: 15_000 })

    // デザインカンプの3タブ。冷蔵庫の絞り込みとメモは320pxで横溢しない。
    await page.getByRole("navigation", { name: "ごはんの画面" })
      .getByRole("link", { name: "冷蔵庫の在庫" }).click()
    await expect(page.getByRole("group", { name: "保管場所で絞り込む" })).toBeVisible()
    await checkCompactScreen(page)
    await page.getByRole("navigation", { name: "ごはんの画面" }).getByRole("link", { name: "メモ" }).click()
    const memo = page.getByRole("textbox", { name: "買い物メモを追加" })
    await memo.fill("卵\nキッチンペーパー")
    await page.getByRole("button", { name: "書いたメモを保存" }).click()
    await expect(page.getByRole("status").filter({ hasText: "保存しました。家族の買い物リストにも反映されます。" }))
      .toBeVisible({ timeout: 15_000 })
    await checkCompactScreen(page)
    await family.page.goto("/chores/meals/memo")
    await expect(family.page.getByText(/キッチンペーパー/)).toBeVisible({ timeout: 15_000 })
    await checkCompactScreen(family.page)

    await testInfo.attach("irori-meal-design-320", { body: await page.screenshot(), contentType: "image/png" })
  } finally {
    await family.context.close()
    await cleanupUser(family.userId)
  }
})

test("家族2アカウント: 自由な家事項目→完了→取消が掃除カレンダーと同期する", async ({
  page, approvedUser, browser,
}, testInfo) => {
  const household = await setupHome(page, approvedUser.email, approvedUser.id)
  const family = await familyPage(browser, household, testInfo.workerIndex)
  try {
    await page.goto("/chores/cleaning")
    await page.getByRole("button", { name: "家事項目を設定" }).click()
    const form = page.getByRole("dialog")
    await form.getByLabel("名前").fill("家族共同の床拭き")
    await form.getByLabel("場所（任意）").fill("リビング")
    await form.getByRole("button", { name: "この内容で追加" }).click()
    await expect(page.getByRole("status").filter({ hasText: "「家族共同の床拭き」を追加しました。" }))
      .toBeVisible({ timeout: 15_000 })
    await checkCompactScreen(page)

    await family.page.goto("/chores/cleaning")
    await expect(family.page.getByTestId("cleaning-item").filter({ hasText: "家族共同の床拭き" }))
      .toBeVisible({ timeout: 15_000 })
    await expect(family.page.getByTestId("cleaning-calendar")).toBeVisible()
    await family.page.getByRole("checkbox", { name: "家族共同の床拭きを完了にする" }).click()
    await expect(family.page.getByRole("status").filter({ hasText: "「家族共同の床拭き」を完了にしました。" }))
      .toBeVisible({ timeout: 15_000 })
    await expect(async () => {
      const { data, error } = await adminClient().from("cleaning_logs")
        .select("id, voided_at").eq("household_id", household)
      if (error) throw Error(error.message)
      expect(data).toHaveLength(1)
      expect(data![0].voided_at).toBeNull()
    }).toPass({ timeout: 20_000 })
    await page.reload()
    const calendar = page.getByTestId("cleaning-calendar")
    const dateLabel = todayJst().split("-")
    const dateText = Number(dateLabel[1]) + "月" + Number(dateLabel[2]) + "日"
    await expect(calendar.getByRole("button", { name: dateText + ": 完了1件・次回目安0件" }))
      .toBeVisible({ timeout: 15_000 })
    await checkCompactScreen(page)

    await family.page.getByTestId("cleaning-inline-undo")
      .getByRole("button", { name: "直前の記録を取り消す" }).click()
    await expect(family.page.getByRole("status").filter({ hasText: "記録を取り消しました。" }))
      .toBeVisible({ timeout: 15_000 })
    await page.reload()
    await expect(calendar.getByRole("button", { name: dateText + ": 完了0件・次回目安1件" }))
      .toBeVisible({ timeout: 15_000 })
    await testInfo.attach("irori-cleaning-design-320", { body: await page.screenshot(), contentType: "image/png" })
  } finally {
    await family.context.close()
    await cleanupUser(family.userId)
  }
})
