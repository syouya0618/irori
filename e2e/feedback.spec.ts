import type { Browser, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import {
  adminClient,
  cleanupUser,
  createApprovedUser,
  loginViaMagicLink,
  uniqueEmail,
  type E2eUser,
} from "./fixtures/auth"

/**
 * 要望・改善提案の筋書き（20261025200001）を実ブラウザ + ローカル Supabase で固定する。
 *
 *   1. 妻（一般利用者）が設定から要望を送る。**応答だけが失われた**送信を押し直しても 1 件
 *   2. 連打しても 1 件
 *   3. 運用者（app_operators・別世帯）が受信箱で受け取り、状態を変え、返信する
 *   4. マージを記録しても妻には「反映済み」と出ぬ（本番未確認）
 *   5. 「反映済み」は本番確認のチェックと SHA が揃うまで押せぬ。揃えて確定すると妻に出る
 *   6. 運用者でない妻には受信箱が 404
 *
 * ## 運用者の用意は service role で行う
 * 運用者の登録は migration が誰も seed せぬ（fail-closed）手作業の領分ゆえ、e2e は
 * adminClient で `app_operators` に 1 行入れる。後始末で必ず消す。
 *
 * ## Push はここでは見ぬ
 * e2e 環境には VAPID を置いておらぬ（cron-routes-auth.spec.ts の注記）。知らせの配信の契約は
 * `src/lib/notifications/__tests__/deliver-feedback.test.ts`、積み込みは pgTAP が持つ。
 */

test.setTimeout(240_000)

/** 運用者を別世帯に用意する（承認済み・世帯所属・app_operators 在籍）。 */
async function createOperator(workerIndex: number): Promise<E2eUser & { householdId: string }> {
  const admin = adminClient()
  const user = await createApprovedUser(`op-${uniqueEmail(workerIndex)}`)
  const { data: household, error: householdError } = await admin
    .from("households")
    .insert({ name: "E2E 運用者の世帯" })
    .select("id")
    .single()
  if (householdError || !household) {
    throw new Error(`operator household insert failed: ${householdError?.message}`)
  }
  const { error: profileError } = await admin
    .from("profiles")
    .update({ household_id: household.id, role: "owner", is_approved: true, display_name: "運用者" })
    .eq("id", user.id)
    .select("id")
    .single()
  if (profileError) throw new Error(`operator profile update failed: ${profileError.message}`)
  const { error: operatorError } = await admin.from("app_operators").insert({ user_id: user.id })
  if (operatorError) throw new Error(`app_operators insert failed: ${operatorError.message}`)
  return { ...user, householdId: household.id }
}

async function removeOperator(operator: E2eUser & { householdId: string }): Promise<void> {
  const { error } = await adminClient().from("app_operators").delete().eq("user_id", operator.id)
  if (error) console.warn(`[e2e cleanup] app_operators delete failed: ${error.message}`)
  await cleanupUser(operator.id, operator.householdId)
}

async function openPageWithoutTour(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:3000",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    try {
      localStorage.setItem("irori:tour-seen:v1", "1")
    } catch {
      /* localStorage 不可でも止めぬ */
    }
  })
  return page
}

async function countFeedback(submitterId: string, title: string): Promise<number> {
  const { count, error } = await adminClient()
    .from("feedback_items")
    .select("id", { count: "exact", head: true })
    .eq("submitter_id", submitterId)
    .eq("title", title)
  if (error) throw new Error(`feedback count failed: ${error.message}`)
  return count ?? -1
}

/**
 * 要望の詳細（受信箱・投稿者のどちらも）を開き、ハイドレーションが済むまで待つ。同期点は、マウント後の
 * effect でしか飛ばぬ既読の Server Action（FeedbackSeenMarker → markFeedbackSeen）の POST。
 * 掴むのは「開いた頁へ向けた、この要望の既読」だけ（前の文書の別の POST を取り違えぬ）。
 */
async function gotoHydrated(page: Page, absoluteUrl: string): Promise<void> {
  const feedbackId = new URL(absoluteUrl).pathname.split("/").at(-1) ?? ""
  const seen = page.waitForRequest(
    (r) =>
      r.method() === "POST" &&
      Boolean(r.headers()["next-action"]) &&
      r.url() === absoluteUrl &&
      (r.postData() ?? "").includes(feedbackId),
    { timeout: 20_000 },
  )
  await page.goto(absoluteUrl)
  await seen
}

/** 送るボタン（ハイドレーション前の押下は無反応になりうるゆえ、結果が出るまで押し直す）。 */
async function fillFeedback(page: Page, title: string, body: string): Promise<void> {
  await page.getByLabel("要望（ひとことで）").fill(title)
  await page.getByLabel("詳しい内容（任意）").fill(body)
}

test("要望を送り、運用者が受け取り、本番で確かめてから「反映済み」になる", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  const operator = await createOperator(testInfo.workerIndex)
  const title = `夜は画面を暗くしてほしい ${Date.now()}`
  const doubleTitle = `連打した要望 ${Date.now()}`

  try {
    await test.step("妻: 世帯を作り、設定から要望の画面へ", async () => {
      await loginViaMagicLink(page, approvedUser.email)
      await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
      await page.getByLabel("世帯名").fill("E2E 要望世帯")
      await page.getByRole("button", { name: "世帯を作成する" }).click()
      await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
      await page.goto("/settings")
      await page.getByRole("link", { name: /要望・改善提案を送る/ }).click()
      await expect(page).toHaveURL(/\/feedback$/)
      await expect(page.getByRole("heading", { name: "要望・改善提案" })).toBeVisible()
    })

    await test.step("妻: 応答だけが失われた送信を押し直しても 1 件", async () => {
      await fillFeedback(page, title, "授乳中にまぶしい")
      let dropped = false
      await page.route("**/feedback", async (route) => {
        const request = route.request()
        if (!dropped && request.method() === "POST" && request.headers()["next-action"]) {
          dropped = true
          // サーバまでは届けて DB に書かせ、応答だけを落とす（通信断の最悪の形）。
          await route.fetch()
          await route.abort("connectionreset")
          return
        }
        await route.fallback()
      })
      const sendButton = page.getByRole("button", { name: "送る" })
      await expect(async () => {
        if (!dropped) await sendButton.click({ timeout: 2_000 })
        expect(dropped).toBe(true)
      }).toPass({ timeout: 20_000 })
      await expect(page.getByText(/送信できたか確かめられませんでした/)).toBeVisible({ timeout: 15_000 })
      await page.unroute("**/feedback")
      // 落とした送信は DB に届いておる（＝押し直しが 2 件目を作れば重複になる状況）
      await expect.poll(() => countFeedback(approvedUser.id, title)).toBe(1)

      await sendButton.click()
      await expect(page).toHaveURL(/\/feedback\/[0-9a-f-]{36}$/, { timeout: 15_000 })
      await expect(page.getByRole("heading", { name: title })).toBeVisible()
      expect(await countFeedback(approvedUser.id, title)).toBe(1)
    })

    await test.step("妻: 連打しても 1 件", async () => {
      await page.goto("/feedback")
      await fillFeedback(page, doubleTitle, "")
      await page.getByRole("button", { name: "送る" }).dblclick()
      await expect(page).toHaveURL(/\/feedback\/[0-9a-f-]{36}$/, { timeout: 15_000 })
      // 待ち行列から再生された 2 度目が遅れて着く余地を見てから数える
      await page.waitForTimeout(1_000)
      expect(await countFeedback(approvedUser.id, doubleTitle)).toBe(1)
    })

    await test.step("妻: 運用者でなければ受信箱は 404", async () => {
      await page.goto("/feedback/inbox")
      await expect(page.getByText("ページが見つかりません")).toBeVisible()
    })

    const operatorPage = await openPageWithoutTour(browser)
    let detailUrl = ""

    await test.step("運用者: 受信箱で受け取り、検討中にして返信する", async () => {
      await loginViaMagicLink(operatorPage, operator.email)
      await operatorPage.goto("/feedback/inbox")
      const row = operatorPage.getByRole("link", { name: new RegExp(title) })
      await expect(row).toBeVisible({ timeout: 15_000 })
      await expect(row).toContainText("未読")
      await row.click()
      await expect(operatorPage.getByRole("heading", { name: title })).toBeVisible()
      detailUrl = operatorPage.url()

      await operatorPage.getByRole("radio", { name: "検討中" }).check({ force: true })
      await operatorPage.getByLabel(/返信（投稿者に表示されます）/).fill("夜間の配色を検討します")
      await operatorPage.getByRole("button", { name: "保存する" }).click()
      await expect(operatorPage.getByText("状態が「検討中」になりました")).toBeVisible({ timeout: 15_000 })
    })

    await test.step("妻: 状態と返信が見える（アプリ内が正本）", async () => {
      await page.goto("/feedback")
      const item = page.getByRole("link", { name: new RegExp(title) })
      await expect(item).toContainText("検討中")
      await expect(item).toContainText("更新あり")
      await item.click()
      await expect(page.getByText("夜間の配色を検討します")).toBeVisible()
    })

    await test.step("運用者: マージを記録しても、妻には「反映済み」と出ぬ", async () => {
      // フルロードの直後に radio を押すと、ハイドレーション前で state に届かず「取り込み済み」の欄が出ぬことがある
      await gotoHydrated(operatorPage, detailUrl)
      await operatorPage.getByRole("radio", { name: "対応中" }).check({ force: true })
      await operatorPage.getByLabel("取り込み済みの変更（任意）").fill("PR #241")
      await operatorPage.getByRole("button", { name: "保存する" }).click()
      await expect(operatorPage.getByText("状態が「対応中」になりました")).toBeVisible({ timeout: 15_000 })

      await page.reload()
      await expect(page.getByText(/本番への反映はまだです/)).toBeVisible()
      await expect(page.getByText("反映済み", { exact: true })).toHaveCount(0)
    })

    await test.step("運用者: 本番確認のチェックと SHA が揃うまで「反映済み」は押せぬ", async () => {
      // ハイドレーションが済むまで待つ（マウント後の effect でしか飛ばぬ既読の Server Action が同期点）。
      // 待たずに入力すると state が付いてこず、「押せる」の assert が CI でだけ落ちうる
      await gotoHydrated(operatorPage, detailUrl)
      const releaseButton = operatorPage.getByRole("button", { name: "反映済みにする" })
      await expect(releaseButton).toBeDisabled()
      await operatorPage.getByLabel("確かめたコミット（SHA・7〜40 桁）").fill("abcdef1")
      await expect(releaseButton).toBeDisabled()
      await operatorPage
        .getByRole("checkbox", { name: "本番環境で、この変更が動いていることを確かめました" })
        .check()
      await expect(releaseButton).toBeEnabled()
      await releaseButton.click()
      await expect(operatorPage.getByText("本番への反映を確かめました")).toBeVisible({ timeout: 15_000 })
    })

    await test.step("妻: 反映済みと、確かめた日時が見える", async () => {
      await page.reload()
      await expect(page.getByText("反映済み", { exact: true })).toBeVisible()
      await expect(page.getByText(/本番での反映を確かめました/)).toBeVisible()
    })

    await operatorPage.context().close()
  } finally {
    await removeOperator(operator)
  }
})
