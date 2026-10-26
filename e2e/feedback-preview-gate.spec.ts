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
import { PREVIEW_BASE_URL, PREVIEW_COMMIT_SHA } from "./fixtures/env"

/**
 * 要望の「反映済み」は本番のデプロイからだけ確定できる（preview の配信だけでは確定できぬ）こと、
 * そして別の世帯の利用者に要望が漏れぬことを、実ブラウザ + ローカル Supabase で固定する。
 *
 *   1. 妻が要望を送る
 *   2. 運用者が **preview のサーバ**（playwright.config.ts の 2 本目・VERCEL_ENV=preview）で受信箱の
 *      詳細を開く → 「本番のデプロイではありません」と出て、SHA とチェックを揃えても確定を押せぬ。
 *      「稼働中のデプロイと同じコミットです」とも言わぬ。画面の門を飛ばして form を直に送っても、
 *      サーバの Action が拒み、DB は released にならぬ
 *   3. 対照: 同じ運用者が 3000 番（VERCEL_ENV なし = 判別できぬ環境）で開けば確定を押せる
 *      （押さぬ。押せることだけを見て、DB は released にならぬまま）
 *   4. 別の世帯の利用者は、妻の要望の詳細も一覧も受信箱も見えぬ（404・一覧に出ぬ）
 *
 * 待ち合わせ: 受信箱の詳細はハイドレーションが済んでから入力する（openInboxDetailHydrated の注記）。
 * RLS（他人の要望の行が読めぬ）は pgTAP `supabase/tests/feedback_rls.sql` が持ち、ここは画面の層を見る。
 *
 * 運用者の用意は feedback.spec.ts と同じく service role で行い、後始末で必ず消す。
 */

test.setTimeout(240_000)

/** 運用者を別世帯に用意する（承認済み・世帯所属・app_operators 在籍。feedback.spec.ts と同一実装）。 */
async function createOperator(workerIndex: number): Promise<E2eUser & { householdId: string }> {
  const admin = adminClient()
  const user = await createApprovedUser(`op-preview-${uniqueEmail(workerIndex)}`)
  const { data: household, error: householdError } = await admin
    .from("households")
    .insert({ name: "E2E 運用者の世帯（preview）" })
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

/** login → 世帯作成 → /baby（世帯 ID を DB 断面で待つ）。 */
async function createHousehold(page: Page, user: E2eUser, name: string): Promise<string> {
  await loginViaMagicLink(page, user.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill(name)
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  let householdId = ""
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("profiles")
      .select("household_id")
      .eq("id", user.id)
      .single()
    if (error) throw new Error(`profile lookup failed: ${error.message}`)
    if (!data?.household_id) throw new Error("household not ready")
    householdId = data.household_id
  }).toPass({ timeout: 15_000 })
  return householdId
}

/**
 * 受信箱の詳細を開き、**ハイドレーションが済むまで**待つ。同期点は、頁がマウントした後の effect でしか
 * 飛ばぬ既読の Server Action（FeedbackSeenMarker → markFeedbackSeen の POST）。これを待たずに入力すると、
 * 入力が React の state に届かぬまま assert が走りうる（disabled は SSR の時点で既に disabled ゆえ偽陽性、
 * enabled は state が付いてこず偽陰性）。
 */
async function openInboxDetailHydrated(
  page: Page,
  url: string,
  title: string,
  feedbackId: string,
): Promise<void> {
  // 掴むのは「開いた頁へ向けた、この要望の既読の POST」だけ（前の文書の別の Server Action を取り違えぬ）
  const target = new URL(url, "http://127.0.0.1:3000").href
  const seen = page.waitForRequest(
    (r) =>
      r.method() === "POST" &&
      Boolean(r.headers()["next-action"]) &&
      r.url() === target &&
      (r.postData() ?? "").includes(feedbackId),
    { timeout: 20_000 },
  )
  await page.goto(url)
  // heading の確認が先に落ちても、待ちの promise を宙に浮かせぬ
  await Promise.all([
    expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 15_000 }),
    seen,
  ])
}

async function feedbackRow(id: string): Promise<{ status: string; released_commit_sha: string | null }> {
  const { data, error } = await adminClient()
    .from("feedback_items")
    .select("status, released_commit_sha")
    .eq("id", id)
    .single()
  if (error || !data) throw new Error(`feedback lookup failed: ${error?.message ?? "no row"}`)
  return data as { status: string; released_commit_sha: string | null }
}

test("preview のデプロイからは「反映済み」を確定できず、別の世帯には要望が見えぬ", async ({
  page,
  approvedUser,
  browser,
}, testInfo) => {
  const operator = await createOperator(testInfo.workerIndex)
  const stranger = await createApprovedUser(`stranger-fb-${uniqueEmail(testInfo.workerIndex)}`)
  let strangerHouseholdId: string | undefined
  const title = `夜は画面を暗くしてほしい（preview）${Date.now()}`
  let feedbackId = ""

  try {
    await test.step("妻: 要望を送る", async () => {
      await createHousehold(page, approvedUser, "E2E 要望世帯（preview）")
      await page.goto("/feedback")
      await page.getByLabel("要望（ひとことで）").fill(title)
      const send = page.getByRole("button", { name: "送る" })
      // ハイドレーション前の押下は無反応になりうるゆえ、詳細へ移るまで押し直す（feedback.spec.ts と同じ）
      await expect(async () => {
        if (!/\/feedback\/[0-9a-f-]{36}$/.test(page.url())) await send.click({ timeout: 2_000 })
        await expect(page).toHaveURL(/\/feedback\/[0-9a-f-]{36}$/, { timeout: 3_000 })
      }).toPass({ timeout: 20_000 })
      feedbackId = page.url().split("/").at(-1) ?? ""
      expect(feedbackId).toMatch(/^[0-9a-f-]{36}$/)
    })

    const operatorPage = await openPageWithoutTour(browser)

    await test.step("運用者: preview のサーバでは確定を押せず、「同じコミット」とも言わぬ", async () => {
      // 3000 番でログインした session（cookie）は 3100 番でもそのまま効く（cookie はポートで分かれぬ）
      await loginViaMagicLink(operatorPage, operator.email)
      await openInboxDetailHydrated(
        operatorPage,
        `${PREVIEW_BASE_URL}/feedback/inbox/${feedbackId}`,
        title,
        feedbackId,
      )

      const alert = operatorPage.getByRole("alert").filter({ hasText: "本番のデプロイではありません" })
      await expect(alert).toBeVisible()
      await expect(alert).toContainText(`preview:${PREVIEW_COMMIT_SHA}`)
      await expect(operatorPage.getByRole("button", { name: "この SHA を入れる" })).toHaveCount(0)

      const releaseButton = operatorPage.getByRole("button", { name: "反映済みにする" })
      const shaInput = operatorPage.getByLabel("確かめたコミット（SHA・7〜40 桁）")
      const verifiedBox = operatorPage.getByRole("checkbox", {
        name: "本番環境で、この変更が動いていることを確かめました",
      })
      await shaInput.fill(PREVIEW_COMMIT_SHA)
      await verifiedBox.check()
      // 入力が DOM に入ったことを見てから押せぬことを見る（state へ届くことは、上のハイドレーションの同期点が保証する）
      await expect(shaInput).toHaveValue(PREVIEW_COMMIT_SHA)
      await expect(verifiedBox).toBeChecked()
      await expect(releaseButton).toBeDisabled()
      await expect(operatorPage.getByText("稼働中のデプロイと同じコミットです。")).toHaveCount(0)

      // 画面の門を飛ばして form を直に送らせても、**サーバの Action が** preview を拒む（実ビルド・実行時の env）。
      // Action は本番確認の宣言を preview の判定より先に確かめるゆえ、この文言が出れば、チェックの state が
      // handler まで届いておったことも分かる（SHA の検査は preview の判定の後ろ）
      await operatorPage.locator("form", { has: releaseButton }).evaluate((form) => {
        ;(form as HTMLFormElement).requestSubmit()
      })
      await expect(
        operatorPage.getByText("この画面は本番のデプロイではありません。本番の irori で確定してください"),
      ).toBeVisible({ timeout: 15_000 })
      const afterPreview = await feedbackRow(feedbackId)
      expect(afterPreview.status).not.toBe("released")
      expect(afterPreview.released_commit_sha).toBeNull()
    })

    await test.step("対照: 3000 番（デプロイの段を判別できぬ環境）では押せる。押さず、DB は released にならぬ", async () => {
      await openInboxDetailHydrated(operatorPage, `/feedback/inbox/${feedbackId}`, title, feedbackId)
      await expect(
        operatorPage.getByRole("alert").filter({ hasText: "本番のデプロイではありません" }),
      ).toHaveCount(0)
      await operatorPage.getByLabel("確かめたコミット（SHA・7〜40 桁）").fill("abcdef1")
      await operatorPage
        .getByRole("checkbox", { name: "本番環境で、この変更が動いていることを確かめました" })
        .check()
      await expect(operatorPage.getByRole("button", { name: "反映済みにする" })).toBeEnabled()

      const row = await feedbackRow(feedbackId)
      expect(row.status).not.toBe("released")
      expect(row.released_commit_sha).toBeNull()
    })

    await operatorPage.context().close()

    const strangerPage = await openPageWithoutTour(browser)
    await test.step("別の世帯: 妻の要望の詳細も一覧も受信箱も見えぬ", async () => {
      strangerHouseholdId = await createHousehold(strangerPage, stranger, "E2E 別の世帯（要望）")
      await strangerPage.goto(`/feedback/${feedbackId}`)
      await expect(strangerPage.getByText("ページが見つかりません")).toBeVisible({ timeout: 15_000 })
      await expect(strangerPage.getByText(title)).toHaveCount(0)

      await strangerPage.goto("/feedback")
      await expect(strangerPage.getByRole("heading", { name: "要望・改善提案" })).toBeVisible({
        timeout: 15_000,
      })
      await expect(strangerPage.getByText(title)).toHaveCount(0)

      await strangerPage.goto("/feedback/inbox")
      await expect(strangerPage.getByText("ページが見つかりません")).toBeVisible({ timeout: 15_000 })
    })
    await strangerPage.context().close()
  } finally {
    await removeOperator(operator)
    await cleanupUser(stranger.id, strangerHouseholdId)
  }
})
