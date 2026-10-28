import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures/test"
import { adminClient, loginViaMagicLink } from "./fixtures/auth"

/**
 * 中核ケースを WebKit・iPhone 相当の端末設定（playwright.config.ts の project "webkit-iphone"）で
 * 通す（2026-10-27 大型更新 F2）。全 spec を重ねて走らせず、利用者が毎日触る経路だけに絞る:
 *
 *   ログイン → 世帯作成 → ミルクの量を決めて記録（タップ）→ 量の入力の置き換え（160→180）
 *   → 記録の編集 → 日記の下書きの復元（再読込を跨ぐ）→ 記録の CSV 書き出し
 *
 * ⚠️ エミュレーションじゃ。iPhone 実機・ホーム画面の standalone・日本語 IME の変換確定・
 * VoiceOver は保証せぬ（AC25/AC26 の manual-device は別に NOT_RUN として報告する）。
 * 下書きの段は contract-v1 §4（useDraft）の UI 配線が入った統合 tree でのみ意味を持つ。
 */

test.setTimeout(240_000)

async function openOverlay(trigger: Locator, readySignal: Locator): Promise<void> {
  await expect(
    trigger.page().locator('[data-slot="sheet-content"]:not([data-open])')
  ).toHaveCount(0, { timeout: 10_000 })
  await expect(async () => {
    if (!(await readySignal.isVisible())) {
      await trigger.tap({ timeout: 2_000 })
    }
    await expect(readySignal).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
}

function openSheetOf(page: Page): Locator {
  return page.locator('[data-slot="sheet-content"][data-open]')
}

async function waitForHouseholdId(userId: string): Promise<string> {
  let householdId = ""
  await expect(async () => {
    const { data, error } = await adminClient()
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()
    if (error) throw new Error(`profile lookup failed: ${error.message}`)
    if (!data?.household_id) throw new Error("household not ready")
    householdId = data.household_id
  }).toPass({ timeout: 15_000 })
  return householdId
}

async function bottleAmounts(householdId: string): Promise<(number | null)[]> {
  const { data, error } = await adminClient()
    .from("baby_logs")
    .select("amount_ml")
    .eq("household_id", householdId)
    .eq("feeding_type", "bottle")
    .order("logged_at", { ascending: true })
  if (error) throw new Error(`baby_logs lookup failed: ${error.message}`)
  return (data ?? []).map((r) => r.amount_ml as number | null)
}

test("WebKit/タッチ: 記録・量の置き換え・編集・下書き・CSV の中核経路", async ({
  page,
  approvedUser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "webkit-iphone", "WebKit 用の中核ケース")

  // ── ログイン → 世帯作成 ────────────────────────────────────────────
  await loginViaMagicLink(page, approvedUser.email)
  await expect(page).toHaveURL(/\/setup/, { timeout: 15_000 })
  await page.getByLabel("世帯名").fill("E2E WebKit世帯")
  await page.getByRole("button", { name: "世帯を作成する" }).tap()
  await expect(page).toHaveURL(/\/baby/, { timeout: 15_000 })
  const householdId = await waitForHouseholdId(approvedUser.id)
  const quick = page.getByRole("main")

  // ── ミルク: 未設定 → 量のシートで 160 → 保存して記録（タップ）────────────
  await openOverlay(
    quick.getByRole("button", { name: "ミルク", exact: true }),
    page.getByRole("heading", { name: "いつものミルク量" })
  )
  const sheet = openSheetOf(page)
  const amount = sheet.getByLabel("1回の量（ml）")
  await amount.tap()
  await amount.pressSequentially("160")
  await expect(amount).toHaveValue("160")
  await sheet.getByRole("button", { name: "保存して記録する" }).tap()
  await expect.poll(() => bottleAmounts(householdId), { timeout: 15_000 }).toEqual([160])

  // ── 量の置き換え 160 → 180（タップで入り、全選択して打ち直す）─────────────
  // 単発の fill では「160,180」に結合した実測がある（上流の初回 focus でキャレットが末尾へ動く —
  // bottle-default-number-input.test.tsx）。ここでは利用者の操作の順（focus → 全選択 → 入力）で確かめる
  await openOverlay(
    quick.getByRole("button", { name: "ミルクの量を変更" }),
    page.getByRole("heading", { name: "いつものミルク量" })
  )
  const change = openSheetOf(page)
  const changeInput = change.getByLabel("1回の量（ml）")
  await changeInput.tap()
  await changeInput.press("ControlOrMeta+A")
  await changeInput.pressSequentially("180")
  await expect(changeInput).toHaveValue("180")
  await change.getByRole("button", { name: "保存する" }).tap()
  await expect(quick.getByTestId("bottle-default-amount")).toHaveText("180ml", { timeout: 15_000 })
  // 過去の記録は 160 のまま（量の変更は次の記録から）
  expect(await bottleAmounts(householdId)).toEqual([160])

  // ── 記録の編集（おむつ → メモを足して更新）────────────────────────────
  await quick.getByRole("button", { name: "うんち", exact: true }).tap()
  await quick.getByRole("button", { name: "大量", exact: true }).tap()
  await expect(page.getByText("おむつ交換を記録しました（うんち（大量））")).toBeVisible({
    timeout: 15_000,
  })
  await openOverlay(
    page.getByRole("button", { name: /うんち（大量）/ }),
    page.getByRole("heading", { name: "おむつを編集" })
  )
  const edit = openSheetOf(page)
  await edit.getByLabel("メモ").tap()
  await edit.getByLabel("メモ").pressSequentially("WebKitで足したメモ")
  await edit.getByRole("button", { name: "更新する" }).tap()
  await expect(page.getByText("ログを更新しました")).toBeVisible({ timeout: 15_000 })

  // ── 日記の下書き（再読込 → 開き直して「戻す」を選ぶ）─────────────────────
  await openOverlay(
    page.getByRole("button", { name: "日記を編集" }),
    page.getByRole("heading", { name: "育児日記" })
  )
  const diary = openSheetOf(page).getByLabel("日記本文")
  await diary.tap()
  await diary.pressSequentially("WebKitの下書き")
  await page.reload()
  await openOverlay(
    page.getByRole("button", { name: "日記を編集" }),
    page.getByRole("heading", { name: "育児日記" })
  )
  // v9 は前回の下書きを自動では入れず、利用者が戻すか破棄するかを選ぶ。
  await expect(openSheetOf(page).getByLabel("日記本文")).toBeDisabled()
  await openSheetOf(page).getByRole("button", { name: "戻す", exact: true }).tap()
  await expect(openSheetOf(page).getByLabel("日記本文")).toHaveValue("WebKitの下書き", {
    timeout: 10_000,
  })

  // ── 記録の CSV（BOM 付き・blob の保存が WebKit でも始まる）────────────────
  await page.goto("/settings")
  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: /記録のCSV/ }).tap()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^uchinolog_logs_.*\.csv$/)
  const path = await download.path()
  const fs = await import("node:fs/promises")
  const bytes = await fs.readFile(path)
  expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
  expect(bytes.toString("utf8")).toContain("WebKitで足したメモ")
})
