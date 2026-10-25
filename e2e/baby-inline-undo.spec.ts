import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 直前の記録の取り消し（画面内の帯）E2E。
 *
 * login → 世帯作成 → /baby → おしっこ → 取り消しトーストが出ておる間は帯を出さぬ
 * → トーストが自動で閉じたら帯「直前の記録（HH:MM）を取り消す」が出る → 押す
 * → 「おむつの記録を取り消しました」・今日のまとめが 0 に戻る・DB の行も消える。
 * 対照: トーストの「取り消す」で消した記録には帯が出ない（同じ 1 件の取り消しは 1 回）。
 *
 * ## なぜ e2e でも見るか
 * 帯とトーストの引き継ぎは sonner の onAutoClose / onDismiss に頼る。単体テストは mock の
 * sonner でしか確かめられぬゆえ、実物の sonner（下端・ナビの上）で引き継ぎが起きることを固定する。
 * 世帯は fixture（approvedUser）がテストごとに作って消す。家族の実データには触れぬ。
 */

test.setTimeout(180_000)

/** approvedUser の世帯 ID を DB 断面で待つ（baby-diaper-amount.spec.ts と同じ）。 */
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

/** おむつ行の件数が expected になるのを DB 断面で待つ。 */
async function expectDiaperRowCount(householdId: string, expected: number): Promise<void> {
  const admin = adminClient()
  await expect(async () => {
    const { data, error } = await admin
      .from("baby_logs")
      .select("id")
      .eq("household_id", householdId)
      .eq("log_type", "diaper")
    if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
    if ((data?.length ?? 0) !== expected)
      throw new Error(`expected ${expected} diaper rows, got ${data?.length ?? 0}`)
  }).toPass({ timeout: 15_000 })
}

const INLINE_UNDO = /^直前の記録（\d\d:\d\d）を取り消す$/

test("直前の記録の取り消し: トーストが閉じた後は画面内の帯から 1 タップで取り消せる", async ({
  page,
  approvedUser,
}) => {
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E取り消し帯世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).click()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)

  const summary = page.getByRole("group", { name: "今日のまとめ" })
  await expect(summary).toBeVisible({ timeout: 15_000 })
  // クイック記録は main へスコープする（シート・トーストの同名釦と取り違えぬ）
  const quick = page.getByRole("main")

  // ── 1. 記録 → トーストが出ておる間は帯を出さぬ（下端のトーストと重ねぬ）─────────
  await quick.getByRole("button", { name: "おしっこ", exact: true }).click()
  const recordedToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "おむつ交換を記録しました（おしっこ）" })
  await expect(recordedToast).toBeVisible({ timeout: 15_000 })
  await expect(summary).toContainText("おしっこ1・うんち0")
  await expect(quick.getByRole("button", { name: INLINE_UNDO })).toHaveCount(0)
  await expectDiaperRowCount(householdId, 1)

  // ── 2. トーストが自動で閉じる（hover で止めぬよう指を外す）→ 帯が引き継ぐ ──────────
  await page.mouse.move(0, 0)
  await expect(recordedToast).toHaveCount(0, { timeout: 20_000 })
  const inlineUndo = quick.getByRole("button", { name: INLINE_UNDO })
  await expect(inlineUndo).toBeVisible({ timeout: 10_000 })

  // ── 3. 帯から取り消す → 画面と DB の両方から消える ────────────────────────────
  await inlineUndo.click()
  // 指を帯の上から外す: 下端（ナビの上）のトーストが帯の位置に出るため、指が乗ったままだと
  // sonner がトーストの自動クローズを止め、下の「消えるまで待つ」が時間切れになる
  await page.mouse.move(0, 0)
  await expect(page.getByText("おむつの記録を取り消しました")).toBeVisible({ timeout: 15_000 })
  await expect(summary).toContainText("おしっこ0・うんち0")
  await expect(inlineUndo).toHaveCount(0)
  await expectDiaperRowCount(householdId, 0)

  // ── 4. 対照: トーストの「取り消す」で消した記録には、閉じた後も帯が出ない ──────────
  // 前のトースト（取り消しました）が消えるのを待ってから記録する
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 20_000 })
  await quick.getByRole("button", { name: "おしっこ", exact: true }).click()
  const secondToast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "おむつ交換を記録しました（おしっこ）" })
  await expect(secondToast).toBeVisible({ timeout: 15_000 })
  await secondToast.hover()
  await secondToast.getByRole("button", { name: "取り消す" }).click()
  await expect(page.getByText("おむつの記録を取り消しました")).toBeVisible({ timeout: 15_000 })
  await expect(summary).toContainText("おしっこ0・うんち0")
  await page.mouse.move(0, 0)
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 20_000 })
  await expect(quick.getByRole("button", { name: INLINE_UNDO })).toHaveCount(0)
  await expectDiaperRowCount(householdId, 0)
})
